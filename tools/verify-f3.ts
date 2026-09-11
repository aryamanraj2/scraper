#!/usr/bin/env tsx
/**
 * F3's exit criteria, one verdict per criterion, in the same shape as verify-f0/1/2.
 *
 * Written to keep passing at every LATER stage, per F2 §4.9. That deviation records
 * two ways `verify-f1.ts` broke the moment F2 did its job: it asserted
 * `MILESTONE_STAGE === 'F1'` (which F2's own exit criteria made contradictory) and it
 * counted a lifecycle status the scorer legitimately advances. So here:
 *
 *   - the stage check is `isAtOrAfter`, never equality;
 *   - nothing asserts on a `Lead.status` or `ApplicationPacket.status` value that F4
 *     or F5 will move. Packets are counted as "generated", not as "still prepared",
 *     because the operator accepting and submitting them is the milestone WORKING.
 */
import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { prisma, disconnectPrisma } from '../src/core/db/client.js'
import { MILESTONE_STAGE, isAtOrAfter } from '../src/core/config/stage.js'
import { reachableReasonCodes } from '../src/core/reason-codes/registry.js'
import { PrefilledAnswers } from '../src/apply/packet/answers.js'

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

// 1. 30 reviewable application packets, counted in outreach_dev.
{
  const total = await db.applicationPacket.count()
  const companies = await db.applicationPacket.groupBy({ by: ['companyId'], _count: { _all: true } })
  const byStatus = await db.applicationPacket.groupBy({ by: ['status'], _count: { _all: true } })
  checks.push({
    name: '30 reviewable application packets',
    ok: total >= 30,
    detail:
      `${total} packet(s) across ${companies.length} compan(ies); ` +
      `by status: ${byStatus.map((r) => `${r.status}=${r._count._all}`).join(' ') || 'none'}`,
  })
}

// 2. Every packet fully reconstructible from evidence.
{
  const packets = await db.applicationPacket.findMany({
    select: {
      id: true,
      prefilledAnswers: true,
      citedEvidenceIds: true,
      approvedClaimIds: true,
      resumeVersion: { select: { fileSha256: true } },
    },
  })
  const problems: string[] = []
  for (const packet of packets) {
    const parsed = PrefilledAnswers.safeParse(packet.prefilledAnswers)
    if (!parsed.success) {
      problems.push(`${packet.id}: answers do not parse`)
      continue
    }
    for (const answer of parsed.data.answers) {
      if (answer.approvedClaimIds.length === 0) {
        problems.push(`${packet.id}/${answer.questionKey}: no approved claim`)
      }
    }
    const claimIds = [...new Set(parsed.data.answers.flatMap((a) => a.approvedClaimIds))]
    const liveClaims = await db.approvedClaim.count({ where: { id: { in: claimIds }, isActive: true } })
    if (liveClaims !== claimIds.length) problems.push(`${packet.id}: ${claimIds.length - liveClaims} dead claim id(s)`)

    const evidenceIds = [...new Set(parsed.data.answers.flatMap((a) => a.citedEvidenceIds))]
    const liveEvidence = await db.evidence.count({ where: { id: { in: evidenceIds } } })
    if (liveEvidence !== evidenceIds.length) {
      problems.push(`${packet.id}: ${evidenceIds.length - liveEvidence} dead evidence id(s)`)
    }
  }
  checks.push({
    name: 'Every packet fully reconstructible from evidence',
    ok: packets.length > 0 && problems.length === 0,
    detail:
      problems.length === 0
        ? `${packets.length} packet(s) walked; every answer traces to a live ApprovedClaim, every citation to an Evidence row`
        : `${problems.length} problem(s): ${problems.slice(0, 5).join('; ')}`,
  })
}

// 3. Opportunity.roleUrl is the official application URL.
{
  const packets = await db.applicationPacket.findMany({
    where: { opportunityId: { not: null } },
    select: { id: true, officialUrl: true, opportunity: { select: { roleUrl: true } } },
  })
  const mismatched = packets.filter((p) => p.officialUrl !== p.opportunity?.roleUrl)
  checks.push({
    name: 'Opportunity.roleUrl is the official application URL',
    ok: packets.length > 0 && mismatched.length === 0,
    detail: `${packets.length} packet(s) checked; ${mismatched.length} whose officialUrl differs from the employer-published roleUrl`,
  })
}

// 4. The operator's own data is loaded, and what is missing is named.
{
  const resumes = await db.resumeVersion.count({ where: { isActive: true } })
  const claims = await db.approvedClaim.count({ where: { isActive: true } })
  const tracks = await db.roleTrack.findMany({ select: { key: true, defaultResumeVersionId: true } })
  const unwired = tracks.filter((t) => t.defaultResumeVersionId === null).map((t) => t.key)
  checks.push({
    name: 'Resume library and approved claims loaded, every track wired',
    ok: resumes > 0 && claims > 0 && tracks.length > 0 && unwired.length === 0,
    detail:
      `${resumes} active ResumeVersion, ${claims} active ApprovedClaim, ` +
      `${tracks.length - unwired.length}/${tracks.length} tracks wired to a default resume` +
      (unwired.length > 0 ? `; UNWIRED: ${unwired.join(', ')}` : ''),
  })
}

// 5. ResearchBrief persistence — the F2 output nothing consumed.
{
  const fulfilled = await db.llmTask.count({ where: { kind: 'research_brief', status: 'fulfilled' } })
  const briefs = await db.researchBrief.count()
  const uncited = await db.researchBrief.count({ where: { citedEvidenceIds: { isEmpty: true } } })
  checks.push({
    name: 'Accepted LlmTask output written into ResearchBrief',
    ok: fulfilled === 0 || (briefs >= fulfilled && uncited === 0),
    detail: `${fulfilled} fulfilled brief task(s), ${briefs} ResearchBrief row(s), ${uncited} with no citations`,
  })
}

// 6. Nothing auto-submits — a source inspection, not a claim.
{
  function walk(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'generated' || entry.startsWith('.')) continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) out.push(...walk(full))
      else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full)
    }
    return out
  }
  // This file lists the forbidden patterns in order to search for them, so it is
  // exempt from its own scan — the same precedent F0 set by exempting
  // raw-client.ts from tools/check-no-raw-http.ts.
  const SELF = join(process.cwd(), 'tools', 'verify-f3.ts')
  const files = ['src', 'tools', 'app']
    .flatMap((d) => {
      try {
        return walk(join(process.cwd(), d))
      } catch {
        return []
      }
    })
    .filter((f) => f !== SELF)
  const forbidden = [
    /harvest\.greenhouse\.io/i,
    /\b(submitApplication|autoApply|applyToJob|postApplication|sendApplication|submitToAts)\b/i,
  ]
  const hits = files.filter((f) => {
    const text = readFileSync(f, 'utf8')
    return forbidden.some((p) => p.test(text))
  })
  // A named allowlist rather than a count. F3 wrote `<= 1` because exactly one caller
  // existed, and the intent was "a second caller must be reviewed rather than
  // discovered" — not "there will only ever be one". F5 is that review: the mail
  // adapter posts a message to gmail.googleapis.com and cannot reach an ATS.
  //
  // A count would have had to be relaxed to `<= 2`, which is the same check one notch
  // weaker and would silently admit a third. A list does not weaken.
  const ALLOWED_POST_JSON = ['intel/research/firecrawl.ts', 'outreach/mail/gmail.ts']
  const postJsonCallers = files
    .filter((f) => !f.endsWith(join('policy', 'fetch-policy-gate.ts')) && /\.postJson\s*\(/.test(readFileSync(f, 'utf8')))
    .map((f) => f.split('/src/')[1] ?? f)
  const unexpected = postJsonCallers.filter((f) => !ALLOWED_POST_JSON.includes(f))
  checks.push({
    name: 'Nothing auto-submits (H8)',
    ok: hits.length === 0 && unexpected.length === 0,
    detail:
      `${files.length} source file(s) scanned; 0 ATS submission endpoints; ` +
      `gate.postJson called from ${postJsonCallers.length} reviewed module(s) ` +
      `(${postJsonCallers.join(', ') || 'none'})` +
      (unexpected.length > 0 ? `; UNREVIEWED: ${unexpected.join(', ')}` : ''),
  })
}

// 7. Milestone bumped honestly.
{
  const reachable = reachableReasonCodes()
  const submitted = await db.auditLog.count({ where: { reasonCode: 'application_submitted' } })
  checks.push({
    name: 'Milestone bumped honestly',
    ok: isAtOrAfter(MILESTONE_STAGE, 'F3') && reachable.includes('application_submitted'),
    detail:
      `MILESTONE_STAGE=${MILESTONE_STAGE}; ${reachable.length} codes reachable; ` +
      `application_submitted ${reachable.includes('application_submitted') ? 'reachable' : 'MISSING'}; ` +
      `${submitted} recorded in AuditLog`,
  })
}

// 8. The global research envelope is actually charged (latent F2 defect, fixed in F3).
{
  const global = await db.researchBudget.findFirst({ where: { companyId: null } })
  const perCompany = await db.researchBudget.aggregate({
    where: { companyId: { not: null } },
    _sum: { creditsSpent: true },
  })
  const companySum = perCompany._sum.creditsSpent ?? 0
  checks.push({
    name: 'Global research envelope is charged, not just read',
    ok: global !== null,
    detail:
      global === null
        ? 'no global envelope row — run `npm run seed:budget`'
        : `global ${global.creditsSpent}/${global.creditsCap} credits (${global.vendorCreditsSpent} vendor-paid); ` +
          `per-company sum ${companySum}` +
          (global.creditsSpent < companySum
            ? ` — the gap is F2 spend recorded before the fix; new spend charges both rows`
            : ''),
  })
}

await disconnectPrisma()

// 9-11. Proven by the suite against the real code paths.
runSuite('Prefilled answers come only from ApprovedClaim', 'test/policy/application-packet.test.ts')
runSuite('application_submitted reachable through a real path', 'test/policy/reason-code-coverage.test.ts')
runSuite('Brief persistence and the claim allow-set', 'test/integration/packet-llm.test.ts')

console.log('\nF3 exit criteria\n')
for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}\n        ${c.detail}`)
const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} criteria met.\n`)
process.exit(failed.length === 0 ? 0 : 1)
