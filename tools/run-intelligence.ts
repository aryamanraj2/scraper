#!/usr/bin/env tsx
/**
 * F2's demonstrable artifact: turn the ingested corpus into explainable scores.
 *
 *   npm run intel:run                    # score every company, no network
 *   npm run intel:run -- --research 20   # also research up to 20 companies (LIVE)
 *   npm run intel:run -- --research 60 --country India   # scoped to one geography
 *   npm run intel:run -- --briefs        # queue research briefs for qualified leads
 *
 * Without `--research` this touches no network at all: it scores from rows F1
 * already stored, computes B2's job-count deltas from the `job_posting` signals,
 * and writes `Lead` rows. That is deliberate — the expensive half of F2 is optional,
 * and re-scoring after a weight or vocabulary change must never mean re-fetching.
 *
 * With `--research` it walks `SignalGraphService.nextAction` per company and
 * performs whatever that returns, which is where the D4 precedence floor and the
 * research budget actually bind. Every request goes through `FetchPolicyGate`.
 */
import 'dotenv/config'
import { prisma, disconnectPrisma } from '../src/core/db/client.js'
import { env } from '../src/core/config/config.js'
import { FetchPolicyGate } from '../src/core/policy/fetch-policy-gate.js'
import { COMPANY_SCORING_SELECT } from '../src/intel/scoring/collect.js'
import { ensureScoreVersion, scoreCompanyAndPersist } from '../src/intel/scoring/run.js'
import { computeJobCountDelta } from '../src/intel/signals/job-count-delta.js'
import { seedRoleTracks } from '../src/intel/taxonomy/seed-tracks.js'
import { SignalGraphService } from '../src/intel/signal-graph.js'
import { researchCompanyPage } from '../src/intel/research/page-research.js'
import { FirecrawlResearchProvider } from '../src/intel/research/firecrawl.js'
import { queueResearchBrief } from '../src/intel/brief/queue-brief.js'
import { SCORE_VERSION_V1 } from '../src/intel/scoring/score-version.js'

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const researchLimit = process.argv.includes('--research') ? Number(flag('research') ?? 10) : 0
const wantBriefs = process.argv.includes('--briefs')
/**
 * Re-research pages that are inside the refresh window. Only useful after the
 * extraction policy itself changes — a stored excerpt written under an older rule
 * is not refreshed by a re-fetch that the window skips.
 */
const refreshPages = process.argv.includes('--refresh-pages')
/**
 * Restrict research to one country. The corpus is 1,975 companies of which 1,553
 * scored `insufficient_evidence`, and research walks them oldest-first — so without
 * this, reaching a specific geography means paying for everything ingested before it.
 * H5 gives India a higher per-company allowance for exactly this reason (B7: no
 * India-native ATS exposes a public feed), and 58 of the corpus's 60 Indian companies
 * have no detected board, so page research is the only source they have.
 */
const country = flag('country')

const db = prisma()
const config = env()

const tracks = await seedRoleTracks(db)
console.log(`Role tracks: ${tracks.created} created, ${tracks.updated} updated.`)
await ensureScoreVersion(db)
console.log(`Score version: ${SCORE_VERSION_V1.label} (weights sum to 100, thresholds ${JSON.stringify(SCORE_VERSION_V1.thresholds)}).`)

// --- B2: job-count deltas from signals F1 already stored, no refetch ---------
{
  const companies = await db.company.findMany({ select: { id: true } })
  let computed = 0
  let insufficient = 0
  for (const company of companies) {
    const outcome = await computeJobCountDelta(db, company.id)
    if (outcome.computed) computed += 1
    else if (outcome.reason === 'insufficient_observations') insufficient += 1
  }
  console.log(`\nATS job-count deltas: ${computed} computed; ${insufficient} companies have fewer than two board reads.`)
}

// --- optional research pass (LIVE) ------------------------------------------
if (researchLimit > 0) {
  const gate = new FetchPolicyGate(db, {
    userAgent: config.USER_AGENT,
    robotsTtlSeconds: config.ROBOTS_CACHE_TTL_SECONDS,
    defaultRateDelayMs: config.DEFAULT_HOST_RATE_DELAY_MS,
  })
  const firecrawl = new FirecrawlResearchProvider(gate, { apiKey: config.FIRECRAWL_API_KEY })
  const graph = new SignalGraphService(db, {
    firecrawlEnabled: firecrawl.enabled,
    ...(refreshPages ? { pageRefreshDays: 0 } : {}),
  })

  // Companies the scorer could not label come first: they are the ones with
  // nothing but a YC blurb, and page research is the only source they have left.
  // `detect_ats` actions are skipped here — detection belongs to `ingest:seed`,
  // which owns the two-stage path and its own rate budget.
  const countryFilter = country ? { countries: { has: country } } : {}
  const companies = [
    ...(await db.company.findMany({
      where: { status: 'insufficient_evidence', ...countryFilter },
      select: { id: true, canonicalDomain: true, careersUrl: true, atsSlug: true, atsBoardToken: true, countries: true },
      orderBy: { createdAt: 'asc' },
      take: researchLimit,
    })),
    ...(await db.company.findMany({
      where: { status: { not: 'insufficient_evidence' }, ...countryFilter },
      select: { id: true, canonicalDomain: true, careersUrl: true, atsSlug: true, atsBoardToken: true, countries: true },
      orderBy: { createdAt: 'asc' },
      take: researchLimit,
    })),
  ].slice(0, researchLimit)

  console.log(
    `\nResearching ${companies.length} companies${country ? ` in ${country}` : ''} (LIVE, through FetchPolicyGate)...`,
  )
  const outcomes = new Map<string, number>()
  for (const company of companies) {
    const action = await graph.nextAction(company)
    let label: string = action.kind
    if (action.kind === 'static_fetch') {
      const result = await researchCompanyPage(
        db,
        gate,
        { id: company.id, canonicalDomain: company.canonicalDomain, countries: company.countries },
        action.url,
        { sameHostDelayMs: config.DEFAULT_HOST_RATE_DELAY_MS },
      )
      label = `static_fetch:${result.kind}`
    } else if (action.kind === 'firecrawl_escalate') {
      const result = await firecrawl.escalate(
        db,
        { id: company.id, canonicalDomain: company.canonicalDomain, countries: company.countries },
        action.url,
      )
      label = `firecrawl:${result.kind}`
    }
    console.log(`  ${company.canonicalDomain.padEnd(34)} ${label}`)
    outcomes.set(label, (outcomes.get(label) ?? 0) + 1)
  }
  console.log('\n  ' + [...outcomes].map(([k, v]) => `${k}=${v}`).join('  '))
}

// --- score every company -----------------------------------------------------
{
  const companies = await db.company.findMany({ select: COMPANY_SCORING_SELECT, orderBy: { createdAt: 'asc' } })
  const bands = { queue: 0, research: 0, reject: 0 }
  let refused = 0
  const scores: number[] = []

  for (const company of companies) {
    const outcome = await scoreCompanyAndPersist(db, company)
    if (!outcome.scored) {
      refused += 1
      continue
    }
    bands[outcome.breakdown.band] += 1
    scores.push(outcome.breakdown.total)
  }

  scores.sort((a, b) => a - b)
  const median = scores.length === 0 ? 0 : scores[Math.floor(scores.length / 2)]!
  console.log(
    `\nScored ${scores.length} of ${companies.length} companies ` +
      `(${refused} refused as insufficient_evidence).\n` +
      `  queue (>=${SCORE_VERSION_V1.thresholds.queue}): ${bands.queue}\n` +
      `  research (${SCORE_VERSION_V1.thresholds.research}-${SCORE_VERSION_V1.thresholds.queue - 1}): ${bands.research}\n` +
      `  reject (<${SCORE_VERSION_V1.thresholds.research}): ${bands.reject}\n` +
      `  min ${scores[0] ?? 0}, median ${median}, max ${scores[scores.length - 1] ?? 0}`,
  )
}

// --- optionally queue briefs for the qualified leads -------------------------
if (wantBriefs) {
  const leads = await db.lead.findMany({ where: { status: 'qualified' }, select: { id: true } })
  let queued = 0
  let skipped = 0
  for (const lead of leads) {
    const outcome = await queueResearchBrief(db, lead.id)
    if (outcome.queued) queued += 1
    else skipped += 1
  }
  console.log(`\nResearch briefs: ${queued} queued, ${skipped} skipped. Drain them with \`npm run llm:next\`.`)
}

await disconnectPrisma()
