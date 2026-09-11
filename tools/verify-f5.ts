#!/usr/bin/env tsx
/**
 * F5's exit criteria, one verdict per criterion, in the same shape as verify-f0..f4.
 *
 * Written to keep passing at every LATER stage, per F2 §4.9: the stage check is
 * `isAtOrAfter`, never equality, and nothing asserts on a value F6 will legitimately
 * change. In particular nothing here asserts that the recipient policy is
 * `owned_only` — F6 lifts that deliberately — but the criteria DO assert that lifting
 * it takes two independent acts, which stays true forever.
 *
 * Two criteria are structurally unprovable from inside this process and say so rather
 * than passing: a real send to an owned inbox, and SPF/DKIM/DMARC on the delivered
 * copy. Both are `npm run send:test`, and both are recorded from its output. A
 * verifier that silently passed them would be exactly the empty panel B3 warns about.
 */
import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { prisma, disconnectPrisma } from '../src/core/db/client.js'
import { MILESTONE_STAGE, isAtOrAfter } from '../src/core/config/stage.js'
import { reachableReasonCodes } from '../src/core/reason-codes/registry.js'
import { resolveSendingEnabled } from '../src/core/config/config.js'
import { env } from '../src/core/config/config.js'
import { resolveRecipientPolicy, checkRecipient } from '../src/outreach/send/recipient-policy.js'
import { checkProfileComplete } from '../src/core/config/profile-fields.js'
import { deliverabilityCounters } from '../src/outreach/send/counters.js'
import { deriveMessageId } from '../src/outreach/mail/message-id.js'

type Check = { name: string; ok: boolean; detail: string }
const checks: Check[] = []
const bin = (name: string) => join(process.cwd(), 'node_modules', '.bin', name)

function runSuite(name: string, pattern: string): void {
  try {
    const out = execFileSync(bin('vitest'), ['run', pattern], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    checks.push({ name, ok: true, detail: (out.match(/Tests\s+.*/) ?? ['passed'])[0]!.trim() })
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string }
    checks.push({ name, ok: false, detail: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim().slice(-600) || String(err) })
  }
}

const db = prisma()
const config = env()

// 1. The build has reached the sending milestone, honestly.
{
  const reachable = reachableReasonCodes()
  const F5_CODES = [
    'approval_hash_mismatch', 'breaker_open', 'cap_exceeded', 'duplicate_company',
    'duplicate_contact', 'hard_bounce', 'opt_out', 'profile_incomplete', 'recipient_not_owned',
    'replied', 'soft_bounce', 'stale_at_send', 'suppressed', 'user_paused', 'wrong_contact',
  ]
  const missing = F5_CODES.filter((c) => !reachable.includes(c as never))
  checks.push({
    name: 'Milestone bumped honestly',
    ok: isAtOrAfter(MILESTONE_STAGE, 'F5') && missing.length === 0,
    detail:
      `MILESTONE_STAGE=${MILESTONE_STAGE}; ${reachable.length} codes reachable; ` +
      (missing.length === 0 ? 'all 15 F5 codes registered' : `missing: ${missing.join(', ')}`),
  })
}

// 2. Sending still needs both independent factors.
{
  // The stage no longer refuses — that is what F5 means. The env flag still does, and
  // this asserts the pair rather than either half.
  const stageOnly = resolveSendingEnabled({ envFlag: false })
  const both = resolveSendingEnabled({ envFlag: true })
  const preF5 = resolveSendingEnabled({ envFlag: true, stage: 'F4' })
  checks.push({
    name: 'Sending needs BOTH the stage and the env flag',
    ok: !stageOnly.enabled && both.enabled && !preF5.enabled,
    detail:
      `stage-only=${stageOnly.enabled}, both=${both.enabled}, at F4 with the flag=${preF5.enabled}; ` +
      `SENDING_ENABLED is currently ${config.SENDING_ENABLED}`,
  })
}

// 3. Owned inboxes only, and lifting it takes two acts.
{
  const policy = resolveRecipientPolicy({
    externalRecipientsEnabled: config.SEND_EXTERNAL_RECIPIENTS_ENABLED,
    ownedInboxes: config.OWNED_INBOXES,
  })
  // Every stored contact that is NOT an owned inbox must be refused at this stage.
  const contacts = await db.contact.findMany({ select: { emailNormalized: true } })
  const reachableContacts = contacts.filter((c) => checkRecipient(c.emailNormalized, policy).allowed)
  // At F6 the flag alone must still not be enough, and the stage alone must not be.
  const stageOnlyAtF6 = resolveRecipientPolicy({
    stage: 'F6',
    externalRecipientsEnabled: false,
    ownedInboxes: config.OWNED_INBOXES,
  })
  const flagOnlyAtF5 = resolveRecipientPolicy({
    stage: 'F5',
    externalRecipientsEnabled: true,
    ownedInboxes: config.OWNED_INBOXES,
  })
  const twoActs = stageOnlyAtF6.mode === 'owned_only' && flagOnlyAtF5.mode === 'owned_only'
  checks.push({
    name: 'Recipients: owned inboxes only, and lifting it needs stage AND flag',
    ok: twoActs && (policy.mode === 'any' || reachableContacts.length === 0),
    detail:
      `policy=${policy.mode}; owned=${config.OWNED_INBOXES.join(',') || 'none'}; ` +
      `${contacts.length} stored contact(s), ${reachableContacts.length} reachable at this stage; ` +
      `stage-alone-at-F6=${stageOnlyAtF6.mode}, flag-alone-at-F5=${flagOnlyAtF5.mode}`,
  })
}

// 4. D6 condition 3 has an enumerated field list, and the profile satisfies it.
{
  const profile = await db.candidateProfile.findFirst({
    select: { fullName: true, senderIdentity: true, replyToEmail: true },
  })
  const verdict = checkProfileComplete(profile, { sendingAccount: config.GMAIL_SENDING_ACCOUNT })
  checks.push({
    name: 'Candidate profile complete against the enumerated field list (D6.3, A12)',
    ok: verdict.complete,
    detail: verdict.complete
      ? `senderIdentity=${verdict.senderIdentity}, replyTo=${verdict.replyToEmail}`
      : verdict.detail,
  })
}

// 5. The resume a draft LINKS is hosted, not a file:// path (H3, B5).
{
  const resumes = await db.resumeVersion.findMany({ select: { label: true, linkUrl: true } })
  const local = resumes.filter((r) => !r.linkUrl.startsWith('https://'))
  checks.push({
    name: 'Every resume linkUrl is a hosted https URL (H3)',
    ok: resumes.length > 0 && local.length === 0,
    detail:
      local.length === 0
        ? `${resumes.length} resume(s), all hosted`
        : `still local: ${local.map((r) => r.label).join(', ')}`,
  })
}

// 6. A9's columns, and the derivation that makes reconciliation possible.
{
  const attempts = await db.sendAttempt.findMany({
    select: { id: true, idempotencyKey: true, rfc822MessageId: true, status: true, providerMessageId: true },
  })
  // Every stored Message-ID must be re-derivable from its idempotency key. That is
  // what makes a crashed attempt recoverable from the row alone.
  const mismatched = attempts.filter(
    (a) => a.rfc822MessageId !== deriveMessageId(a.idempotencyKey, config.MESSAGE_ID_DOMAIN),
  )
  const sentWithoutId = attempts.filter((a) => a.status === 'sent' && !a.providerMessageId)
  checks.push({
    name: 'Every SendAttempt carries a Message-ID re-derivable from its key (A9)',
    ok: mismatched.length === 0 && sentWithoutId.length === 0,
    detail:
      `${attempts.length} attempt(s); ${mismatched.length} whose Message-ID does not re-derive; ` +
      `${sentWithoutId.length} marked sent with no provider id`,
  })
}

// 7. Nothing transmitted without a frozen human approval (handover.md §1.6, A7).
{
  const attempts = await db.sendAttempt.findMany({
    select: { id: true, draft: { select: { approvalHash: true, approvedBy: true, approvedAt: true } } },
  })
  const unapproved = attempts.filter((a) => !a.draft.approvalHash || !a.draft.approvedBy || !a.draft.approvedAt)
  checks.push({
    name: 'No transmission without a frozen human approval',
    ok: unapproved.length === 0,
    detail: `${attempts.length} attempt(s), ${unapproved.length} without a frozen approval_hash`,
  })
}

// 8. A12: no soft bounce ever produced a permanent suppression.
{
  const softBounces = await db.bounce.findMany({
    where: { hardness: 'soft' },
    select: { sendAttempt: { select: { contactId: true } } },
  })
  const hardContacts = new Set(
    (
      await db.bounce.findMany({
        where: { hardness: 'hard' },
        select: { sendAttempt: { select: { contactId: true } } },
      })
    ).map((b) => b.sendAttempt.contactId),
  )
  // A contact whose ONLY bounce was soft must not be suppressed.
  const softOnly = softBounces.map((b) => b.sendAttempt.contactId).filter((id) => !hardContacts.has(id))
  const wrongly = softOnly.length === 0
    ? []
    : await db.contact.findMany({
        where: { id: { in: softOnly }, status: 'suppressed' },
        select: { id: true },
      })
  checks.push({
    name: 'A soft bounce never permanently suppresses (A12)',
    ok: wrongly.length === 0,
    detail:
      `${softBounces.length} soft bounce(s), ${softOnly.length} contact(s) with soft bounces only, ` +
      `${wrongly.length} wrongly suppressed`,
  })
}

// 9. D3's two partial unique indexes, after the one migration that drops an index.
{
  const rows = await db.$queryRawUnsafe<Array<{ indexname: string }>>(
    `SELECT indexname FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'send_attempt' AND indexdef ILIKE '%WHERE%'
     ORDER BY indexname`,
  )
  const names = rows.map((r) => r.indexname)
  const expected = ['one_first_touch_per_company_slot_per_cycle', 'one_first_touch_per_contact_per_cycle']
  checks.push({
    name: 'Both D3 partial unique indexes present after the slot migration',
    ok: expected.every((e) => names.includes(e)),
    detail: names.join(', ') || 'none',
  })
}

// 10. First-party counters only — no reputation source anywhere.
{
  const counters = await deliverabilityCounters(db)
  const FORBIDDEN = /postmaster(tools)?\.google|gmail\.com\/postmaster|reputationScore|senderScore/i
  const offenders: string[] = []
  const SELF = join(process.cwd(), 'tools', 'verify-f5.ts')
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (full !== SELF && (full.endsWith('.ts') || full.endsWith('.tsx')) && FORBIDDEN.test(readFileSync(full, 'utf8'))) {
        offenders.push(relative(process.cwd(), full))
      }
    }
  }
  for (const dir of ['src', 'app', 'tools']) walk(join(process.cwd(), dir))
  checks.push({
    name: 'First-party counters only; complaint signal reported as unavailable, never as healthy (B3)',
    ok: offenders.length === 0 && counters.complaintSignal.state === 'unavailable',
    detail:
      offenders.length > 0
        ? `reputation source found in: ${offenders.join(', ')}`
        : `complaint signal = "${counters.complaintSignal.state}" (never 0); ` +
          `hard-bounce rate = ${counters.hardBounceRate === null ? 'n/a, not 0%' : `${(counters.hardBounceRate * 100).toFixed(1)}%`}`,
  })
}

// 11-13. The proving tests.
runSuite('Crash mid-send issues no second send (Part G row 1, A9)', 'test/policy/send-gate.test.ts')
runSuite('Bounce and reply classification, and A12', 'test/policy/outcome-ingestion.test.ts')
runSuite('The owned-inbox condition fails closed', 'test/policy/owned-inbox.test.ts')
runSuite('All 15 F5 reason codes reachable through real paths', 'test/policy/reason-code-coverage.test.ts')

// 14. The live send, which cannot be proven from in here.
{
  const sendTests = await db.auditLog.findMany({
    where: { action: 'send.test' },
    orderBy: { createdAt: 'desc' },
    take: 1,
    select: { createdAt: true, subjectId: true, metadata: true },
  })
  const latest = sendTests[0]
  checks.push({
    name: 'A verified send to an owned inbox (npm run send:test)',
    ok: latest !== undefined,
    detail: latest
      ? `last send:test to ${latest.subjectId} at ${latest.createdAt.toISOString()}; ${JSON.stringify(latest.metadata)}`
      : 'no send.test audit row — run `npm run send:test -- --to <owned address>`. ' +
        'This criterion is deliberately not provable from inside this process, and is ' +
        'reported as unmet rather than passed silently (B3).',
  })
}

// --- report ---------------------------------------------------------------
console.log('\nF5 exit criteria\n')
for (const c of checks) {
  console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`)
  console.log(`        ${c.detail}`)
}
const passed = checks.filter((c) => c.ok).length
console.log(`\n${passed}/${checks.length} criteria met.\n`)

await disconnectPrisma()
process.exit(passed === checks.length ? 0 : 1)
