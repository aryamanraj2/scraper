#!/usr/bin/env tsx
/**
 * Reply and bounce ingestion — `handover.md` §5's Inbox/Outcome worker.
 *
 *   npm run inbox:sync                  # LIVE: read recent mail, classify, record
 *   npm run inbox:sync -- --days 7
 *   npm run inbox:sync -- --counters    # first-party counters only, no network
 *
 * **Live**, but read-only against the mailbox: it lists and reads messages and never
 * sends, never deletes, and never modifies a label. `gmail.modify` grants more than
 * that; this tool uses less.
 *
 * What it changes is local state, and that is the part worth reading: a hard bounce,
 * an opt-out and a wrong-contact report each write an HMAC-backed `Suppression` that
 * A10 makes outlive the contact row. A soft bounce and a plain reply stop the
 * conversation and write no suppression at all — A12, and the separation is the whole
 * design (`src/outreach/send/ingest-outcomes.ts`).
 */
import 'dotenv/config'
import { prisma, disconnectPrisma } from '../src/core/db/client.js'
import { env } from '../src/core/config/config.js'
import { FetchPolicyGate } from '../src/core/policy/fetch-policy-gate.js'
import { SecretStore } from '../src/core/crypto/secret-store.js'
import { KeychainKeyProvider } from '../src/core/crypto/keychain-key-provider.js'
import { EnvKeyProvider } from '../src/core/crypto/env-key-provider.js'
import { GmailTokenProvider } from '../src/outreach/mail/oauth.js'
import { GmailProvider } from '../src/outreach/mail/gmail.js'
import { ingestInboundMessage, type InboundForIngest } from '../src/outreach/send/ingest-outcomes.js'
import { deliverabilityCounters } from '../src/outreach/send/counters.js'

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const config = env()
const db = prisma()

async function printCounters(): Promise<void> {
  const counters = await deliverabilityCounters(db)
  console.log(`\nDeliverability (first-party, ${counters.windowDays}d) — B3`)
  console.log(`  sent            ${counters.sent}`)
  console.log(`  in flight       ${counters.inFlight}`)
  console.log(`  hard bounces    ${counters.hardBounces}`)
  console.log(`  soft bounces    ${counters.softBounces}`)
  console.log(`  replies         ${counters.replies}`)
  console.log(`  opt-outs        ${counters.optOuts}`)
  console.log(
    `  hard-bounce rate ${counters.hardBounceRate === null ? 'n/a (nothing sent — not 0%)' : `${(counters.hardBounceRate * 100).toFixed(1)}%`}`,
  )
  console.log(`  complaints      ${counters.complaintSignal.state}`)
  if (counters.complaintSignal.state === 'unavailable') console.log(`                  ${counters.complaintSignal.why}`)
  console.log(`\n  ${counters.providerReputationNote}\n`)
}

if (process.argv.includes('--counters')) {
  await printCounters()
  await disconnectPrisma()
} else {
  const days = Number(flag('days') ?? 7)
  const clientId = config.GMAIL_OAUTH_CLIENT_ID
  const clientSecret = config.GMAIL_OAUTH_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    console.error('GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET are unset.')
    await disconnectPrisma()
    process.exit(1)
  }

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
  const mail = new GmailProvider(gate, tokens, { messageIdDomain: config.MESSAGE_ID_DOMAIN })

  // Everything received recently, not only what is in a known thread. A bounce often
  // arrives outside the thread, and a reply that broke threading is still a reply.
  const query = `newer_than:${days}d -in:sent`
  const ids = await mail.listInbox(query, 50)
  console.log(`\ninbox:sync — ${ids.length} message(s) matching "${query}"\n`)

  let matched = 0
  for (const { id } of ids) {
    const message = await mail.getMessage(id)
    if (message.fromIsSelf) continue
    const inbound: InboundForIngest = {
      providerMessageId: message.id,
      threadId: message.threadId,
      from: message.from,
      subject: message.subject,
      bodyText: message.bodyText,
      inReplyTo: message.inReplyTo,
      receivedAt: message.receivedAt,
    }
    const result = await ingestInboundMessage(db, inbound, {
      suppressionSalt: config.SUPPRESSION_HMAC_SALT,
    })
    if (result.kind === 'unmatched') continue
    matched += 1
    console.log(
      `  ${result.kind.padEnd(14)} ${result.reasonCode ?? '-'}  ` +
        `${result.suppressed ? 'SUPPRESSED' : 'no suppression'}  ${result.detail}`,
    )
  }
  console.log(`\n  ${matched} message(s) matched a SendAttempt.`)
  await printCounters()
  await disconnectPrisma()
}
