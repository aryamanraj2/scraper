#!/usr/bin/env tsx
/**
 * The F5 artifact: transmit an approved draft, through D6's gate.
 *
 *   npm run send:run -- --list                 # what the gate says about each approved draft
 *   npm run send:run -- --dry --id <draftId>   # evaluate the gate, send nothing
 *   npm run send:run -- --id <draftId>         # LIVE
 *   npm run send:run -- --reconcile            # recover in_flight attempts after a crash
 *
 * **This is a live command.** It is the fifth that touches a live source and the only
 * one that talks to a human who did not ask to hear from us — which at this milestone
 * cannot happen, because the gate refuses every recipient that is not an owned inbox.
 *
 * There is deliberately no `--all`. `handover.md` §1.6 is unamended and the operator
 * reconfirmed it during F4: every message is approved individually, and a command that
 * drained the approved queue in one call would be a bulk send wearing a different
 * name. One draft, one invocation, one `--id`.
 */
import 'dotenv/config'
import { prisma, disconnectPrisma } from '../src/core/db/client.js'
import { env } from '../src/core/config/config.js'
import { MILESTONE_STAGE } from '../src/core/config/stage.js'
import { FetchPolicyGate } from '../src/core/policy/fetch-policy-gate.js'
import { SecretStore } from '../src/core/crypto/secret-store.js'
import { KeychainKeyProvider } from '../src/core/crypto/keychain-key-provider.js'
import { EnvKeyProvider } from '../src/core/crypto/env-key-provider.js'
import { GmailTokenProvider } from '../src/outreach/mail/oauth.js'
import { GmailProvider } from '../src/outreach/mail/gmail.js'
import { evaluateSendGate, type SendGateOptions } from '../src/outreach/send/gate.js'
import { sendApprovedDraft, reconcileInFlight } from '../src/outreach/send/send.js'
import { deliverabilityCounters } from '../src/outreach/send/counters.js'
import { capsForStage } from '../src/outreach/send/caps.js'

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}
const has = (name: string) => process.argv.includes(`--${name}`)

const config = env()
const db = prisma()

const gateOptions: SendGateOptions = {
  ownedInboxes: config.OWNED_INBOXES,
  externalRecipientsEnabled: config.SEND_EXTERNAL_RECIPIENTS_ENABLED,
  sendingAccount: config.GMAIL_SENDING_ACCOUNT,
  messageIdDomain: config.MESSAGE_ID_DOMAIN,
  suppressionSalt: config.SUPPRESSION_HMAC_SALT,
  envFlag: config.SENDING_ENABLED,
}

function mailProvider(): GmailProvider {
  const clientId = config.GMAIL_OAUTH_CLIENT_ID
  const clientSecret = config.GMAIL_OAUTH_CLIENT_SECRET
  if (!clientId || !clientSecret) throw new Error('GMAIL_OAUTH_CLIENT_ID / _SECRET are unset')
  const gate = new FetchPolicyGate(db, {
    userAgent: config.USER_AGENT,
    robotsTtlSeconds: config.ROBOTS_CACHE_TTL_SECONDS,
    defaultRateDelayMs: config.DEFAULT_HOST_RATE_DELAY_MS,
  })
  const keyProvider =
    config.KEY_PROVIDER === 'env'
      ? new EnvKeyProvider(config.OUTREACH_KEK_BASE64 ?? '')
      : new KeychainKeyProvider(config.KEYCHAIN_SERVICE, config.KEYCHAIN_ACCOUNT)
  const secrets = new SecretStore(db, keyProvider)
  const tokens = new GmailTokenProvider(gate, secrets, { clientId, clientSecret })
  return new GmailProvider(gate, tokens, { messageIdDomain: config.MESSAGE_ID_DOMAIN })
}

console.log(`\nsend:run — stage ${MILESTONE_STAGE}, sending ${config.SENDING_ENABLED ? 'ENABLED' : 'disabled'}`)
console.log(
  `  recipients: ${config.SEND_EXTERNAL_RECIPIENTS_ENABLED ? 'external permitted' : 'OWNED INBOXES ONLY'}` +
    ` (${config.OWNED_INBOXES.join(', ') || 'none configured'})`,
)
const caps = capsForStage()
console.log(`  caps: ${caps.perDay}/day, ${caps.perDomainPerDay}/domain/day`)

if (has('reconcile')) {
  // A9's recovery path. Reconciliation never sends — it only looks for a message we
  // may already have sent and records what it finds.
  const outcomes = await reconcileInFlight(db, mailProvider())
  console.log(`\nreconciled ${outcomes.length} in-flight attempt(s):`)
  for (const o of outcomes) console.log(`  ${o.status}  ${JSON.stringify(o)}`)
} else if (has('list') || !flag('id')) {
  const drafts = await db.draft.findMany({
    where: { status: { in: ['approved', 'sending'] } },
    select: {
      id: true,
      subject: true,
      status: true,
      contact: { select: { emailNormalized: true } },
      lead: { select: { company: { select: { displayName: true } } } },
    },
    orderBy: { approvedAt: 'asc' },
  })
  console.log(`\n${drafts.length} approved draft(s):\n`)
  for (const d of drafts) {
    const decision = await evaluateSendGate(db, d.id, gateOptions)
    const verdict = decision.allowed ? 'SENDABLE' : `${decision.reason}: ${decision.detail}`
    console.log(`  ${d.id}`)
    console.log(`    ${d.lead.company.displayName} -> ${d.contact?.emailNormalized ?? '(no contact)'}`)
    console.log(`    ${d.subject ?? '(no subject)'}`)
    console.log(`    gate: ${verdict}`)
  }
  if (drafts.length === 0) console.log('  (none)')
} else {
  const draftId = flag('id')!
  if (has('dry')) {
    const decision = await evaluateSendGate(db, draftId, gateOptions)
    console.log(`\ndry run — gate says: ${decision.allowed ? 'SENDABLE' : `${decision.reason}: ${decision.detail}`}`)
    if (decision.allowed) {
      console.log(`  to            ${decision.plan.to}`)
      console.log(`  from          ${decision.plan.fromIdentity}`)
      console.log(`  Message-ID    ${decision.plan.rfc822MessageId}`)
      console.log(`  idempotency   ${decision.plan.idempotencyKey}`)
      console.log('\n  Nothing was sent and no SendAttempt was written.')
    }
  } else {
    const outcome = await sendApprovedDraft(db, mailProvider(), draftId, gateOptions)
    console.log(`\n${JSON.stringify(outcome, null, 2)}`)
  }
}

// B3: first-party counters only, and the provider-reputation caveat travels with them.
const counters = await deliverabilityCounters(db)
console.log(`\nDeliverability (first-party, ${counters.windowDays}d)`)
console.log(
  `  sent=${counters.sent} in_flight=${counters.inFlight} failed=${counters.failed} ` +
    `hard=${counters.hardBounces} soft=${counters.softBounces} replies=${counters.replies} opt_outs=${counters.optOuts}`,
)
console.log(
  `  hard-bounce rate: ${counters.hardBounceRate === null ? 'n/a (nothing sent)' : `${(counters.hardBounceRate * 100).toFixed(1)}%`}`,
)
console.log(`  complaint signal: ${counters.complaintSignal.state} — ${counters.complaintSignal.state === 'unavailable' ? counters.complaintSignal.why : ''}`)
console.log(`  ${counters.providerReputationNote}`)
console.log('')

await disconnectPrisma()
