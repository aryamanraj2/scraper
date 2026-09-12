#!/usr/bin/env tsx
/**
 * Runs F1's exit criteria and prints a verdict per criterion, in the same shape as
 * `verify-f0.ts`.
 *
 * The criteria, from Part F: "100-200 normalized companies with live postings
 * attached; every field traceable to an `Evidence` row. No optional adapter is
 * built in this milestone." The F1 handover §8.5 expands that into the seven rows
 * below.
 *
 * Two of them read `outreach_dev`, so they report what a real `npm run ingest:seed`
 * actually produced rather than what the code could produce in principle.
 */
import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { prisma, disconnectPrisma } from '../src/core/db/client.js'
import { MILESTONE_STAGE, isAtOrAfter } from '../src/core/config/stage.js'
import { reachableReasonCodes } from '../src/core/reason-codes/registry.js'

type Check = { name: string; ok: boolean; detail: string }
const checks: Check[] = []
const bin = (name: string) => join(process.cwd(), 'node_modules', '.bin', name)

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  })
}

const db = prisma()

// 1. 100-200 normalized companies.
{
  const total = await db.company.count()
  // "Normalized" is a milestone a company has PASSED, not a state it sits in.
  // D1's lifecycle runs discovered -> normalized -> researching -> {researched |
  // insufficient_evidence | excluded}, so F2's scorer legitimately moves every
  // company out of `normalized` — and a verifier that counted only that status
  // reported 0/150 the moment F2 ran. A shipped milestone's verifier has to stay
  // green at later stages or it stops being a regression test.
  const NORMALIZED_OR_LATER = ['normalized', 'researching', 'researched', 'insufficient_evidence', 'excluded'] as const
  const normalized = await db.company.count({ where: { status: { in: [...NORMALIZED_OR_LATER] } } })
  const withDomain = await db.company.count({ where: { canonicalDomain: { not: '' } } })
  const byStatus = await db.company.groupBy({ by: ['status'], _count: { _all: true } })
  // The UPPER bound is gone, and its removal is the third instance of one shape.
  //
  // Part F's F1 target was "100-200 normalized companies", and the verifier encoded it
  // as a range. The corpus has since been widened to 1,975 companies — the operator
  // running §9.1's `--feed all` ingest, which F2, F3 and F4 all flagged as the highest-
  // value open question in the project — and the range turned a shipped milestone's
  // verifier into a test that fails because the project made progress.
  //
  // F2 §4.9 found this in the same file for a different reason (it asserted
  // `MILESTONE_STAGE === 'F1'`, and counted a lifecycle state a later milestone
  // legitimately advances past). The rule it drew is the one being applied again:
  // **a verifier for a shipped milestone must keep passing at every later stage, or it
  // stops being a regression test.** A floor is a regression test. A ceiling is a
  // statement that the project will not grow.
  checks.push({
    name: 'At least 100 normalized companies, all with a canonical domain',
    ok: normalized >= 100 && withDomain === total,
    detail:
      `${normalized} normalized or later of ${total} total ` +
      `(${byStatus.map((s) => `${s.status}=${s._count._all}`).join(', ')}); ` +
      `all have a canonical domain: ${withDomain === total}`,
  })
}

// 2. Live postings attached to the subset with a detected board.
{
  const withBoard = await db.company.count({ where: { atsBoardToken: { not: null } } })
  const opportunities = await db.opportunity.count({ where: { kind: 'published_role' } })
  const companiesWithPostings = (
    await db.opportunity.groupBy({ by: ['companyId'], _count: { _all: true } })
  ).length
  checks.push({
    name: 'Live postings attached',
    ok: withBoard > 0 && opportunities > 0,
    detail: `${withBoard} companies with a detected board; ${opportunities} postings across ${companiesWithPostings} companies`,
  })
}

// 3. Every populated field traceable to an Evidence row.
{
  const companies = await db.company.count()
  const companiesWithEvidence = (
    await db.evidence.groupBy({ by: ['companyId'], where: { companyId: { not: null } }, _count: { _all: true } })
  ).length
  const emptyExcerpts = await db.evidence.count({ where: { excerpt: '' } })
  const noSourceUrl = await db.evidence.count({ where: { sourceUrl: '' } })
  const opportunities = await db.opportunity.findMany({ select: { companyId: true, roleUrl: true } })
  const citedRoleUrls = new Set(
    (await db.evidence.findMany({ where: { sourceType: 'ats' }, select: { sourceUrl: true } })).map(
      (e) => e.sourceUrl,
    ),
  )
  const uncitedOpportunities = opportunities.filter(
    (o) => o.roleUrl !== null && !citedRoleUrls.has(o.roleUrl),
  ).length

  checks.push({
    name: 'Every field traceable to an Evidence row',
    ok:
      companiesWithEvidence === companies &&
      emptyExcerpts === 0 &&
      noSourceUrl === 0 &&
      uncitedOpportunities === 0,
    detail:
      `${companiesWithEvidence}/${companies} companies cited; ${emptyExcerpts} empty excerpts; ` +
      `${noSourceUrl} rows without a source URL; ${uncitedOpportunities} uncited postings`,
  })
}

// 4. No optional adapter built. F2a owns those, each behind its own gate (H9).
{
  // `github` alone would false-positive on raw.githubusercontent.com, which is a
  // legitimate yc-oss host — so the GitHub adapter is matched by the API host it
  // would actually have to call.
  const OPTIONAL = /workable|adzuna|data\.gov\.in|datagovin|algolia|hn-hiring|bluesky|bsky|api\.github\.com/i
  /**
   * The host allow/deny lists are exempt, and only they.
   *
   * F5b added `apply.workable.com` to `SEED_ALLOW_HOSTS`, because huggingface.co's
   * careers link redirects there and the gate was refusing the redirect with
   * `host_denied` — so detection could not even record which vendor the company
   * uses. An allow entry is a policy declaration: it grants permission to fetch a
   * host, and grants nothing else. **No Workable adapter exists**, nothing parses a
   * Workable payload, and no code path constructs a Workable URL.
   *
   * This check is a text grep, so it cannot tell a hostname in a constant from an
   * adapter. Narrowing it to skip this one file is the smallest change that keeps
   * it answering the question it was written to answer. What it gives up is
   * covered twice over: `check:no-raw-http` proves no file outside
   * `raw-client.ts` can reach the network at all, and the regex still runs over
   * every other file in src/, which is where an adapter would have to live.
   */
  const POLICY_DECLARATION = /src\/core\/policy\/host-lists\.ts$/
  const offenders: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (
        full.endsWith('.ts') &&
        !POLICY_DECLARATION.test(full) &&
        OPTIONAL.test(readFileSync(full, 'utf8'))
      ) {
        offenders.push(relative(process.cwd(), full))
      }
    }
  }
  walk(join(process.cwd(), 'src'))
  checks.push({
    name: 'No optional adapter built',
    ok: offenders.length === 0,
    detail:
      offenders.length === 0
        ? 'src/ references no F2a source outside the host allow list'
        : `found in: ${offenders.join(', ')}`,
  })
}

// 5. Milestone bumped honestly, with the new codes actually reachable.
{
  const reachable = reachableReasonCodes()
  const required = ['duplicate', 'source_unavailable', 'content_unchanged']
  const missing = required.filter((code) => !reachable.includes(code as never))
  checks.push({
    name: 'Milestone bumped honestly',
    // `isAtOrAfter`, not equality: F2 raises MILESTONE_STAGE to 'F2', and the F2
    // exit criteria also require verify:f1 to stay green. An equality check made
    // those two requirements contradictory — a shipped milestone's verifier has to
    // keep passing at every later stage, or it stops being a regression test.
    ok: isAtOrAfter(MILESTONE_STAGE, 'F1') && missing.length === 0,
    detail: `MILESTONE_STAGE=${MILESTONE_STAGE}; ${reachable.length} codes reachable${missing.length ? `; MISSING ${missing.join(', ')}` : ''}`,
  })
}

// 6 and 7 are proven by the suite against the real code paths.
for (const [name, pattern] of [
  ['Contract tests: adapters vs fixtures and fakes', 'test/integration/ats-adapters.test.ts'],
  ['All F0 invariants intact', 'test/policy'],
] as const) {
  try {
    const out = run(bin('vitest'), ['run', pattern])
    checks.push({ name, ok: true, detail: (out.match(/Tests\s+.*/) ?? ['passed'])[0]!.trim() })
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string }
    checks.push({
      name,
      ok: false,
      detail: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim().slice(-600) || String(err),
    })
  }
}

await disconnectPrisma()

console.log('\nF1 exit criteria\n')
for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}\n        ${c.detail}`)
const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} criteria met.\n`)
process.exit(failed.length === 0 ? 0 : 1)
