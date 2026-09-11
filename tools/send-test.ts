#!/usr/bin/env tsx
/**
 * The owned-inbox test harness the plan names in its Verification section:
 *
 * > *"`npm run send:test` transmits only to owned inboxes and verifies SPF/DKIM
 * > alignment, threading, audit trail, and kill switch."*
 *
 *   npm run send:test -- --to aryamanj250+f5a@gmail.com
 *   npm run send:test -- --to ... --thread   # send a second message threaded under the first
 *
 * **This is a live command and it sends real email.** It is the fifth command in the
 * project that touches a live source and the first that talks to a mailbox.
 *
 * ## What makes it safe to have at all
 *
 * It cannot reach a third party. The recipient is checked against `OWNED_INBOXES` with
 * `checkRecipient`, **unconditionally and regardless of build stage** — this tool does
 * not consult `resolveRecipientPolicy`, because that function is allowed to return
 * `any` at F6 and a diagnostic has no business being widened by a pilot switch. An
 * empty allowlist refuses everything.
 *
 * It is also not a campaign message: it composes a fixed diagnostic body, writes no
 * `SendAttempt`, touches no `Draft`, and reads no approval. It cannot send anything a
 * human approved, which is the property that stops it from being a way around
 * `handover.md` §1.6.
 *
 * The kill switch is checked first, because a switch that a diagnostic ignores is a
 * switch with an exception.
 *
 * ## What it measures
 *
 * 1. **Whether Gmail preserves a client-supplied `Message-ID`.** A9's entire
 *    reconciliation design assumes the id we derived is the id that exists afterwards.
 *    If Gmail rewrites it, an `rfc822msgid:` search for our own derived id returns
 *    nothing, reconciliation concludes "not sent", and the crash-mid-send path sends a
 *    second copy — the exact failure A9 exists to prevent, made worse by passing every
 *    test against a fake. So it is measured against the real provider, on the real
 *    account, before the reconciliation is written.
 * 2. **SPF, DKIM and DMARC**, read out of the delivered message's
 *    `Authentication-Results` header — the only honest place to read them from, since
 *    what matters is what the receiving side concluded.
 * 3. **Threading**, with `--thread`.
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
import { deriveMessageId } from '../src/outreach/mail/message-id.js'
import { checkRecipient } from '../src/outreach/send/recipient-policy.js'
import { checkKillSwitch } from '../src/core/killswitch/kill-switch.js'
import { checkProfileComplete } from '../src/core/config/profile-fields.js'
import { writeAudit } from '../src/core/audit/audit-log.js'

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const config = env()
const db = prisma()

const to = flag('to') ?? config.OWNED_INBOXES[0]
if (!to) {
  console.error('No recipient. Pass --to, or set OWNED_INBOXES in .env.')
  await disconnectPrisma()
  process.exit(1)
}

// Unconditional, and deliberately not `resolveRecipientPolicy`: a diagnostic must not
// be widened by F6's pilot switch.
const recipient = checkRecipient(to, { mode: 'owned_only', ownedInboxes: config.OWNED_INBOXES })
if (!recipient.allowed) {
  console.error(`REFUSED (${recipient.reason}): ${recipient.detail}`)
  console.error('send:test transmits to owned inboxes only, at every stage.')
  await disconnectPrisma()
  process.exit(1)
}

const kill = await checkKillSwitch(db, { account: config.GMAIL_SENDING_ACCOUNT ?? undefined })
if (kill.engaged) {
  console.error(`REFUSED (${kill.reason}): kill switch engaged at ${kill.scope}:${kill.target}`)
  await disconnectPrisma()
  process.exit(1)
}

const profileRow = await db.candidateProfile.findFirst()
const profile = checkProfileComplete(profileRow, { sendingAccount: config.GMAIL_SENDING_ACCOUNT })
if (!profile.complete) {
  console.error(`REFUSED (${profile.reason}): ${profile.detail}`)
  await disconnectPrisma()
  process.exit(1)
}

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

// A synthetic key, marked as such, so nothing mistakes a diagnostic for a campaign
// message if one ever turns up in a query.
const idempotencyKey = `send-test:${new Date().toISOString()}:${to}`
const derivedMessageId = deriveMessageId(idempotencyKey, config.MESSAGE_ID_DOMAIN)

console.log('\nsend:test')
console.log(`  from            ${profile.senderIdentity}`)
console.log(`  to              ${to}   (owned)`)
console.log(`  reply-to        ${profile.replyToEmail}`)
console.log(`  derived Msg-ID  ${derivedMessageId}`)
console.log('')

const sent = await mail.send(
  {
    to,
    subject: `send:test — ${derivedMessageId}`,
    bodyText:
      'Diagnostic message from the outreach system.\n\n' +
      'It carries no approved content and was not composed from a Draft.\n' +
      `Derived Message-ID: ${derivedMessageId}\n` +
      `Idempotency key: ${idempotencyKey}\n`,
    fromIdentity: profile.senderIdentity,
    replyTo: profile.replyToEmail,
    ...(flag('thread') !== undefined || process.argv.includes('--thread')
      ? { inReplyToMessageId: flag('in-reply-to') ?? undefined }
      : {}),
  },
  idempotencyKey,
)
console.log(`  sent            providerMessageId=${sent.providerMessageId} threadId=${sent.threadId ?? '-'}`)

await writeAudit(db, {
  actorType: 'user',
  actorId: 'operator',
  action: 'send.test',
  subjectType: 'OwnedInbox',
  subjectId: to,
  metadata: { derivedMessageId, providerMessageId: sent.providerMessageId, threadId: sent.threadId },
})

// ---------------------------------------------------------------------------
// The measurement A9 depends on.
// ---------------------------------------------------------------------------
console.log('\nA9 — does the derived Message-ID survive the send?')
const found = await mail.findByMessageId(derivedMessageId)
console.log(`  rfc822msgid: search   ${found ? `HIT  ${found.providerMessageId}` : 'MISS'}`)
if (found && found.providerMessageId !== sent.providerMessageId) {
  console.log(`  ⚠ the search matched a DIFFERENT message than the one just sent`)
}

const message = await mail.getMessage(sent.providerMessageId)
console.log(`  stored Message-ID     ${message.rfc822MessageId ?? '(none)'}`)
const preserved = message.rfc822MessageId === derivedMessageId
console.log(`  preserved?            ${preserved ? 'YES' : 'NO'}`)
if (!preserved) {
  console.log('')
  console.log('  A9 step 2 as written does not hold on this provider. The reconciliation')
  console.log('  must key on the returned provider message id plus a custom header we control,')
  console.log('  and the deviation must be recorded with this output as the evidence.')
}

console.log('\nDeliverability, as the RECEIVING side concluded it')
const raw = message.bodyText
const authResults = /^Authentication-Results:.*$/gim.exec(raw)?.[0]
console.log(`  Authentication-Results  ${authResults ?? '(not present in the parsed parts — see below)'}`)
console.log('')
console.log('  Headers Gmail stored on the delivered copy:')
for (const name of ['Message-ID', 'X-Google-Original-Message-ID', 'In-Reply-To', 'References']) {
  const re = new RegExp(`^${name}:\\s*(.+)$`, 'im')
  const hit = re.exec(raw)?.[1]
  console.log(`    ${name.padEnd(30)} ${hit ?? '(absent)'}`)
}
console.log('')
console.log('  SPF/DKIM/DMARC are asserted by the receiving server, so read them from the')
console.log('  delivered copy in the mailbox if they are not visible above — Gmail does not')
console.log('  always expose Authentication-Results through the API payload for a message it')
console.log('  both sent and received.')
console.log('')

await disconnectPrisma()
