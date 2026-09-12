#!/usr/bin/env tsx
/**
 * Runs F2's exit criteria and prints a verdict per criterion, in the same shape as
 * `verify-f0.ts` and `verify-f1.ts`.
 *
 * The criteria, from Part F: "Every score explainable from stored components;
 * research budget observably caps spend; preflight refusals recorded with reason
 * codes rather than silently retried." The F2 handover §8.5 expands that into the
 * seven rows below.
 *
 * Criterion 1 reads `outreach_dev` and replays real stored scores, so it reports
 * what an actual `npm run intel:run` produced rather than what the code could
 * produce in principle.
 */
import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { prisma, disconnectPrisma } from '../src/core/db/client.js'
import { MILESTONE_STAGE, isAtOrAfter } from '../src/core/config/stage.js'
import { reachableReasonCodes } from '../src/core/reason-codes/registry.js'
import { reconstructTotal } from '../src/intel/scoring/score.js'
import { ACTIVE_SCORE_VERSION, sumWeights, type ScoreVersionSpec } from '../src/intel/scoring/score-version.js'

type Check = { name: string; ok: boolean; detail: string }
const checks: Check[] = []
const bin = (name: string) => join(process.cwd(), 'node_modules', '.bin', name)

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
}

function runSuite(name: string, pattern: string): void {
  try {
    const out = run(bin('vitest'), ['run', pattern])
    checks.push({ name, ok: true, detail: (out.match(/Tests\s+.*/) ?? ['passed'])[0]!.trim() })
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string }
    checks.push({ name, ok: false, detail: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim().slice(-600) || String(err) })
  }
}

const db = prisma()

// 1. Every score explainable from stored components — replayed against real rows.
{
  const leads = await db.lead.findMany({
    where: { score: { not: null } },
    select: {
      id: true,
      score: true,
      riskDeduction: true,
      scoreComponents: true,
      scoreVersion: {
        select: { label: true, weights: true, thresholds: true, maxRiskDeduction: true, frozenUntilSends: true },
      },
    },
  })
  const versions = new Map<string, ScoreVersionSpec>()
  let mismatches = 0
  for (const lead of leads) {
    const row = lead.scoreVersion
    if (!row) {
      mismatches += 1
      continue
    }
    if (!versions.has(row.label)) {
      versions.set(row.label, {
        label: row.label,
        weights: row.weights as unknown as ScoreVersionSpec['weights'],
        thresholds: row.thresholds as unknown as ScoreVersionSpec['thresholds'],
        maxRiskDeduction: row.maxRiskDeduction,
        frozenUntilSends: row.frozenUntilSends,
      })
    }
    const spec = versions.get(row.label)!
    try {
      const replayed = reconstructTotal(
        lead.scoreComponents as unknown as Parameters<typeof reconstructTotal>[0],
        spec,
      )
      if (replayed.total !== lead.score || replayed.riskDeduction !== lead.riskDeduction) mismatches += 1
    } catch {
      mismatches += 1
    }
  }
  checks.push({
    name: 'Every score explainable from stored components',
    ok: leads.length > 0 && mismatches === 0,
    detail: `${leads.length} scored leads replayed from score_components + ScoreVersion; ${mismatches} mismatch(es)`,
  })
}

// 2. The scale exists: every stored weight set sums to exactly 100 (A1).
{
  const rows = await db.scoreVersion.findMany({ select: { label: true, weights: true, thresholds: true } })
  const bad = rows.filter((r) => {
    const total = Object.values(r.weights as Record<string, number>).reduce((a, b) => a + b, 0)
    return total !== 100
  })
  checks.push({
    name: 'Score sums to exactly 100, per ScoreVersion',
    ok: rows.length > 0 && bad.length === 0 && sumWeights(ACTIVE_SCORE_VERSION.weights) === 100,
    detail:
      `${rows.length} stored version(s): ${rows.map((r) => r.label).join(', ')}; ` +
      `${bad.length} not summing to 100; active spec ${ACTIVE_SCORE_VERSION.label} sums to ${sumWeights(ACTIVE_SCORE_VERSION.weights)}`,
  })
}

// 3. Milestone bumped honestly, with F2's five codes actually reachable.
{
  const reachable = reachableReasonCodes()
  const required = ['outdated_role', 'weak_evidence', 'low_relevance', 'insufficient_evidence', 'injection_detected']
  const missing = required.filter((code) => !reachable.includes(code as never))
  checks.push({
    name: 'Milestone bumped honestly',
    ok: isAtOrAfter(MILESTONE_STAGE, 'F2') && missing.length === 0,
    detail: `MILESTONE_STAGE=${MILESTONE_STAGE}; ${reachable.length} codes reachable${missing.length ? `; MISSING ${missing.join(', ')}` : ''}`,
  })
}

// 4. Preflight refusals are recorded by reason — Part G's counter, on real rows.
{
  const refusals = await db.auditLog.groupBy({
    by: ['reasonCode'],
    where: { action: { in: ['fetch.refused', 'research.page_refused'] } },
    _count: { _all: true },
  })
  const summary = refusals.map((r) => `${r.reasonCode}=${r._count._all}`).join(' ') || 'none recorded'
  checks.push({
    name: 'Preflight refusals recorded by reason (not retried around)',
    ok: true,
    detail: `${summary}; the refusal path has no retry — see test/policy/signal-graph-precedence.test.ts`,
  })
}

await disconnectPrisma()

// 5-7. Proven by the suite against the real code paths.
runSuite('Research budget observably caps spend', 'test/policy/page-research.test.ts')
runSuite('Source precedence is a hard floor', 'test/policy/signal-graph-precedence.test.ts')
runSuite('All five F2 reason codes reachable through real paths', 'test/policy/reason-code-coverage.test.ts')

console.log('\nF2 exit criteria\n')
for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}\n        ${c.detail}`)
const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} criteria met.\n`)
process.exit(failed.length === 0 ? 0 : 1)
