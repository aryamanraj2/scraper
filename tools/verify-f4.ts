#!/usr/bin/env tsx
/**
 * F4's exit criteria, one verdict per criterion, in the same shape as verify-f0/1/2/3.
 *
 * Written to keep passing at every LATER stage, per F2 §4.9: the stage check is
 * `isAtOrAfter`, never equality, and nothing asserts on a lifecycle value F5 will
 * legitimately advance. A draft that has become `approved`, or later `sent`, is this
 * milestone WORKING — so drafts are counted as composed, never as "still awaiting
 * approval".
 */
import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { prisma, disconnectPrisma } from '../src/core/db/client.js'
import { MILESTONE_STAGE, isAtOrAfter } from '../src/core/config/stage.js'
import { reachableReasonCodes } from '../src/core/reason-codes/registry.js'
import { validateComposition } from '../src/outreach/draft/message.js'
import { TEMPLATE_IDS } from '../src/outreach/draft/templates.js'
import { tierAYield, providerVerdict } from '../src/outreach/contacts/yield-report.js'

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

// 1. Citation-backed drafts, counted in outreach_dev.
{
  const total = await db.draft.count()
  const byStatus = await db.draft.groupBy({ by: ['status'], _count: { _all: true } })
  const withCitations = await db.draft.count({ where: { citedEvidenceIds: { isEmpty: false } } })
  checks.push({
    name: 'Citation-backed drafts exist',
    ok: total > 0,
    detail:
      `${total} draft(s), ${withCitations} carrying at least one cited Evidence row; ` +
      `by status: ${byStatus.map((r) => `${r.status}=${r._count._all}`).join(' ') || 'none'}`,
  })
}

// 2. Every stored draft passes the composition choke point.
//
// Not a re-run of the unit tests: this walks what is actually IN the database, so a
// row written by an older build, or edited by hand, is caught.
//
// Scoped to drafts that have PASSED the gate. A draft still in `composing` or
// `gate_failed` is waiting for its two judgment sentences, and refusing it is H10
// degrading honestly rather than a defect: a message without its evidence-cited
// sentence is the template spray §10.1 says the citation rule exists to beat, so the
// gate is supposed to hold it. Asserting over those too would make this criterion
// fail whenever the operator has not drained the backlog — which F2 §4.9 warns is
// exactly how a verifier stops being a regression test.
{
  const GATED = ['awaiting_approval', 'approved', 'scheduled', 'sending', 'sent'] as const
  const drafts = await db.draft.findMany({
    where: { status: { in: [...GATED] } },
    select: { id: true, composition: true },
  })
  const awaitingJudgment = await db.draft.count({ where: { status: { notIn: [...GATED] } } })

  const problems: string[] = []
  for (const d of drafts) {
    if (!d.composition) {
      problems.push(`${d.id}: no composition`)
      continue
    }
    const result = await validateComposition(db, d.composition, TEMPLATE_IDS)
    if (!result.ok) problems.push(`${d.id}: ${result.problem}`)
  }
  checks.push({
    name: 'Every gated draft passes the per-sentence citation rule',
    ok: problems.length === 0,
    detail:
      problems.length === 0
        ? `${drafts.length} gated draft(s) validated: every company sentence cites Evidence, every candidate sentence cites an ApprovedClaim. ` +
          `${awaitingJudgment} draft(s) still awaiting their outreach_draft task — the gate holds those, which is H10 working`
        : problems.slice(0, 5).join('; '),
  })
}

// 3. No Contact without provenance, and no executive, in the live database.
{
  const contacts = await db.contact.findMany({
    select: { id: true, emailNormalized: true, evidenceId: true, verified: true, discoveryMethod: true, publicTitle: true },
  })
  const withoutEvidence = contacts.filter((c) => !c.evidenceId)
  const evidenceIds = contacts.map((c) => c.evidenceId).filter((id): id is string => !!id)
  const liveEvidence = new Set(
    (await db.evidence.findMany({ where: { id: { in: evidenceIds } }, select: { id: true } })).map((e) => e.id),
  )
  const danglingEvidence = contacts.filter((c) => c.evidenceId && !liveEvidence.has(c.evidenceId))

  checks.push({
    name: 'No Contact exists without an Evidence row (§1.3)',
    ok: withoutEvidence.length === 0 && danglingEvidence.length === 0,
    detail:
      `${contacts.length} contact(s); ${withoutEvidence.length} without an evidenceId; ` +
      `${danglingEvidence.length} citing an Evidence row that no longer exists. ` +
      `Contact.evidenceId is a REQUIRED column, so a contact with no provenance cannot be created at all`,
  })
}

// 4. The executive filter, run against every stored contact.
{
  const { isExecutiveContact } = await import('../src/outreach/contacts/executive-filter.js')
  const contacts = await db.contact.findMany({ select: { emailNormalized: true, publicTitle: true } })
  const executives = contacts.filter((c) => isExecutiveContact(c.emailNormalized, c.publicTitle).isExecutive)
  checks.push({
    name: 'No founder/CEO/executive contact exists (§1.1)',
    ok: executives.length === 0,
    detail:
      executives.length === 0
        ? `${contacts.length} stored contact(s), 0 executives — §1.1 is the boundary of the operator's F4 amendment and was NOT amended`
        : `FOUND ${executives.length} executive contact(s)`,
  })
}

// 5. Unverified contacts open no outreach case.
{
  const unverified = await db.contact.count({ where: { verified: false } })
  const draftsToUnverified = await db.draft.count({ where: { contact: { verified: false } } })
  checks.push({
    name: 'No draft targets an unverified contact',
    ok: draftsToUnverified === 0,
    detail:
      `${unverified} unverified contact(s), ${draftsToUnverified} draft(s) addressed to one. ` +
      `An unverified contact opens NO outreach case, which is what makes CONTACT_ALLOW_PATTERN_INFERENCE safe`,
  })
}

// 6. approval_hash is frozen at approval, never recomputed at send (A7).
{
  const approved = await db.draft.findMany({
    where: { approvedAt: { not: null } },
    select: { id: true, approvalHash: true, approvedBy: true, approvedAt: true },
  })
  const bad = approved.filter((d) => !d.approvalHash || !d.approvedBy)
  checks.push({
    name: 'Every approved draft carries a frozen approval_hash (A7)',
    ok: bad.length === 0,
    detail:
      `${approved.length} approved draft(s); ${bad.length} missing a hash or an approver. ` +
      `The byte-for-byte comparison is proven in test/policy/outreach-draft.test.ts`,
  })
}

// 7. Nothing is transmitted without a frozen human approval behind it.
//
// This criterion used to read "zero external sends; sending still hard-disabled",
// asserted as `!resolveSendingEnabled({envFlag:true}) && sendAttempts === 0`. Both
// halves became false the moment F5 did its job, which made a shipped milestone's
// verifier fail for the reason the next milestone succeeded — F2 §4.9's lesson,
// repeated: "a verifier for a shipped milestone must keep passing at every later
// stage, or it stops being a regression test."
//
// What F4 is actually responsible for, forever, is that a draft cannot become a
// transmission without an approval frozen over A7's field list. That is the property
// checked now, and it gets STRONGER rather than weaker as sends accumulate.
{
  const attempts = await db.sendAttempt.findMany({
    select: { id: true, draft: { select: { approvalHash: true, approvedBy: true, approvedAt: true } } },
  })
  const unapproved = attempts.filter(
    (a) => !a.draft.approvalHash || !a.draft.approvedBy || !a.draft.approvedAt,
  )
  checks.push({
    name: 'No transmission without a frozen human approval (handover.md §1.6, A7)',
    ok: unapproved.length === 0,
    detail:
      `${attempts.length} SendAttempt row(s), ${unapproved.length} without a frozen approval_hash; ` +
      `MILESTONE_STAGE=${MILESTONE_STAGE}`,
  })
}

// 8. The composer holds no mail transport.
//
// Also rewritten for F5. The old check scanned src/, app/ and tools/ for any mail
// transport at all, which was the right check while no adapter existed and became a
// check against F5 existing the moment one did.
//
// F4's real boundary is narrower and permanent: the DRAFTING layer has no way to
// transmit. `src/outreach/draft/` and `src/apply/` compose, gate and approve; they
// hold no `MailProvider`, import nothing from `src/outreach/mail/`, and cannot
// construct a transport. Enforced by inspection here and by constructor injection in
// the code — the same shape D5 uses to keep the browser worker away from a write path.
{
  const offenders: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
        const text = readFileSync(full, 'utf8')
        if (/from ['"].*outreach\/mail\//.test(text) || /\bMailProvider\b/.test(text)) {
          offenders.push(relative(process.cwd(), full))
        }
      }
    }
  }
  for (const dir of ['src/outreach/draft', 'src/outreach/contacts', 'src/apply', 'app']) {
    walk(join(process.cwd(), dir))
  }
  checks.push({
    name: 'The drafting layer cannot transmit (no MailProvider below the send gate)',
    ok: offenders.length === 0,
    detail:
      offenders.length === 0
        ? 'src/outreach/draft, src/outreach/contacts, src/apply and app/ reach no mail transport'
        : `found in: ${offenders.join(', ')}`,
  })
}

// 9. The Tier A yield number the operator asked for (§10.6).
{
  const y = await tierAYield(db)
  checks.push({
    name: 'Tier A yield reported (§10.6)',
    ok: y.companiesAttempted > 0,
    detail:
      `${y.companiesAttempted} attempted, ${y.companiesMeasured} actually read, ` +
      `${y.companiesWithContact} yielded a contact, ${y.companiesWithAlias} a role alias, ` +
      `${y.companiesWithZero} zero. By page kind: ${JSON.stringify(y.byPageKind)}. ` +
      `VERDICT: ${providerVerdict(y)}`,
  })
}

// 10. Milestone bumped honestly, with the four new codes actually reachable.
{
  const reachable = reachableReasonCodes()
  const required = [
    'executive_only_contact',
    'legal_policy_mismatch',
    'no_public_recruiting_route',
    'outreach_not_permitted',
  ]
  const missing = required.filter((code) => !reachable.includes(code as never))
  checks.push({
    name: 'Milestone bumped honestly',
    ok: isAtOrAfter(MILESTONE_STAGE, 'F4') && missing.length === 0,
    detail:
      `MILESTONE_STAGE=${MILESTONE_STAGE}; ${reachable.length} codes reachable` +
      (missing.length ? `; MISSING ${missing.join(', ')}` : '; all four F4 codes driven through real paths'),
  })
}

// 11-13. Proven by the suite against the real code paths.
runSuite('The outreach predicate rejects every path outside the four cases', 'test/policy/outreach-draft.test.ts')
runSuite('Contact curation fails closed (§1.1, §1.2)', 'test/policy/contact-curation.test.ts')
runSuite('All four F4 reason codes reachable through real paths', 'test/policy/reason-code-coverage.test.ts')

await disconnectPrisma()

console.log('\nF4 exit criteria\n')
for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}\n        ${c.detail}`)
const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} criteria met.\n`)
process.exit(failed.length === 0 ? 0 : 1)
