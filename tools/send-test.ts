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

// --probe measures a message already sent, without sending another. The A9 question
// is about the provider, not about this invocation, so re-answering it costs an email
// that nobody needs.
// `--probe-id` reads ONE known message by its provider id and dumps every header.
// It is the control for `--probe`: a search miss can mean the provider rewrote our
// Message-ID, or that the query was wrong, or that the index had not caught up, and
// those want three different responses. Reading the message settles it.
const probeId = flag('probe-id')
if (probeId) {
  const message = await mail.getMessage(probeId)
  console.log(`\nsend:test --probe-id ${probeId}  (no message will be sent)`)
  console.log(`  labels: ${message.labelIds.join(',') || '-'}`)
  for (const [name, value] of Object.entries(message.headers).sort()) {
    console.log(`  ${name.padEnd(32)} ${value.slice(0, 300)}`)
  }
  await disconnectPrisma()
  process.exit(0)
}

const probe = flag('probe')
if (probe) {
  console.log(`\nsend:test --probe ${probe}  (no message will be sent)`)
  await reportOn(probe)
  await disconnectPrisma()
  process.exit(0)
}

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
await reportOn(derivedMessageId, sent.providerMessageId)

/**
 * Answers the one question A9 rests on, against the real provider.
 *
 * A message sent to an address on the same account exists TWICE — the SENT copy and
 * the delivered copy — sharing one `Message-ID`. Only the delivered copy carries
 * `Authentication-Results`, because SPF, DKIM and DMARC are conclusions the RECEIVING
 * side reached. Reading them off the sent copy would report what we asserted rather
 * than what was verified, which is not the same thing and is the weaker one.
 */
async function reportOn(messageId: string, sentProviderId?: string): Promise<void> {
  console.log('\nA9 — can a delivered message be found again from its stored row alone?')

  // Both halves are reported, because they answer different questions. The
  // `rfc822msgid:` search is A9 AS SPECIFIED and is expected to miss on Gmail; the
  // header search is what replaces it. Printing the miss keeps the deviation evidenced
  // rather than remembered.
  const byMsgId = await mail.findByRfc822MsgId(messageId)
  console.log(`  rfc822msgid: (A9 as written)  ${byMsgId.length} hit(s)${byMsgId.length === 0 ? '  <- provider rewrote the Message-ID' : ''}`)

  const hits = await mail.findAllByMessageId(messageId, { to: to ?? undefined, withinDays: 2 })
  console.log(`  X-Outreach-Ref (as built)     ${hits.length} hit(s)`)
  if (hits.length === 0) {
    console.log('')
    console.log('  MISS on BOTH. Neither the Message-ID nor the custom header survived, so a')
    console.log('  reconciliation cannot tell a delivered message from a lost one. Do not enable')
    console.log('  sending: the crash-mid-send path can only fail closed, never recover.')
    return
  }
  if (sentProviderId && !hits.some((h) => h.providerMessageId === sentProviderId)) {
    console.log('  ⚠ the search matched messages, but not the one just sent')
  }

  for (const hit of hits) {
    const message = await mail.getMessage(hit.providerMessageId)
    const copy = message.labelIds.includes('SENT') ? 'SENT copy' : 'delivered copy'
    const stored = message.headers['message-id'] ?? '(none)'
    console.log(`\n  ${copy}  (${hit.providerMessageId}, labels: ${message.labelIds.join(',') || '-'})`)
    console.log(`    Message-ID                    ${stored}`)
    console.log(`    preserved?                    ${stored === messageId ? 'YES' : 'NO'}`)
    for (const name of ['x-google-original-message-id', 'in-reply-to', 'references', 'reply-to', 'from']) {
      if (message.headers[name]) console.log(`    ${name.padEnd(29)} ${message.headers[name]}`)
    }
    const auth = message.headers['authentication-results']
    if (auth) {
      console.log(`    Authentication-Results`)
      for (const part of auth.split(';')) console.log(`      ${part.trim()}`)
    } else if (message.labelIds.includes('SENT') && message.labelIds.includes('INBOX')) {
      // Measured 2026-09-11: Gmail merges a message sent to another address on the
      // SAME account into one message carrying both labels, and short-circuits
      // delivery — so there is no Authentication-Results to read, because no
      // receiving server ever evaluated one.
      console.log('    Authentication-Results        (none — same-account delivery is not evaluated)')
    } else {
      console.log('    Authentication-Results        (absent)')
    }
  }

  console.log('')
  console.log('  SPF / DKIM / DMARC')
  console.log('    The pilot sends from a personal gmail.com mailbox through the Gmail API, so')
  console.log('    the message is DKIM-signed by Google and SPF/DMARC are Google\'s own records.')
  console.log('    There is no sending domain of ours to configure for the pilot, and a')
  console.log('    same-account test cannot show Authentication-Results at all.')
  console.log('')
  console.log('    To see them, send to an owned mailbox on a DIFFERENT provider:')
  console.log('      npm run send:test -- --to <an owned address not on this account>')
  console.log('    That becomes required at the Workspace migration on the owned domain (F6),')
  console.log('    which is the point at which SPF, DKIM and DMARC p=none are ours to set.')
  console.log('')
}

await disconnectPrisma()
