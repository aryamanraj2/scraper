#!/usr/bin/env tsx
/**
 * F1's demonstrable artifact: seed a corpus of companies, detect each one's ATS
 * board, and attach its live postings — every field traceable to an `Evidence` row.
 *
 * Run by hand, like `fixtures:record`, and for the same reason: it touches live
 * sources. `npm test` never does.
 *
 *   npm run ingest:seed                       # 150 companies from the yc-oss hiring feed
 *   npm run ingest:seed -- --limit 40
 *   npm run ingest:seed -- --feed all --limit 200
 *   npm run ingest:seed -- --seed-only        # skip ATS detection and postings
 *   npm run ingest:seed -- --postings-only    # refresh boards already detected
 *
 *   npm run ingest:seed -- --from-file data/company-seed.csv
 *   npm run ingest:seed -- --from-file data/company-seed.csv --report out.csv
 *
 * `--from-file` reads an operator-authored company list instead of the yc-oss feed.
 * It is a different SOURCE, not a different pipeline: the same canonicalization, the
 * same `Evidence`-per-field rule, the same detection and the same posting ingest run
 * afterwards, unchanged. What it changes is the corpus — yc-oss is a US accelerator
 * index, and no amount of it produces an Indian company or an `ios_android` lead.
 *
 * Detection in `--from-file` mode is scoped to the file's own companies. The
 * corpus-wide pass re-attempts every company whose detection previously failed,
 * which at 1,975 companies is hours of requests that teach nothing new; the file's
 * 188 are the ones this run is actually about.
 *
 * Every request goes through `FetchPolicyGate`, so the per-host rate delay applies to
 * employer domains too. Detection is the slow part by construction: it is one host
 * per company, and politeness is the point.
 */
import 'dotenv/config'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { prisma, disconnectPrisma } from '../src/core/db/client.js'
import { env } from '../src/core/config/config.js'
import { FetchPolicyGate } from '../src/core/policy/fetch-policy-gate.js'
import { YcOssSeedProvider, type YcFeed } from '../src/ingest/yc/yc-oss.js'
import { runSeedIngest, type SeedRunResult } from '../src/ingest/yc/seed-loader.js'
import { canonicalizeDomain } from '../src/ingest/domain/canonicalize.js'
import {
  OperatorFileSeedProvider,
  readOperatorSeedFile,
  upsertOperatorSeededCompany,
} from '../src/ingest/file/operator-seed.js'
import { detectAtsForCompany, saveDetection } from '../src/ingest/ats/detect.js'
import { atsProviders, ingestPostings } from '../src/ingest/ats/ingest-postings.js'

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const fromFile = flag('from-file')
const limit = Number(flag('limit') ?? 150)
const feed = (flag('feed') ?? 'hiring') as YcFeed
const seedOnly = process.argv.includes('--seed-only')
/**
 * Refresh the boards we already know about, without re-attempting detection on the
 * companies that failed it. Detection is the expensive half — one host per company at
 * the per-host rate delay — and re-running it changes nothing for a company whose site
 * simply does not publish a board link. This is also the shape of F2's weekly refresh:
 * read the known boards, let the job-count deltas fall out of it.
 */
const postingsOnly = process.argv.includes('--postings-only')
const reportPath = flag('report') ?? (fromFile ? 'data/seed-ingest-report.csv' : undefined)

const db = prisma()
const config = env()
const gate = new FetchPolicyGate(db, {
  userAgent: config.USER_AGENT,
  robotsTtlSeconds: config.ROBOTS_CACHE_TTL_SECONDS,
  defaultRateDelayMs: config.DEFAULT_HOST_RATE_DELAY_MS,
})

/** Per-company outcome, for the report the operator acts on. */
type Row = {
  name: string
  domain: string
  atsGuess: string
  outcome: 'detected' | 'detection_failed' | 'unusable_row' | 'skipped' | 'no_adapter'
  vendor: string
  boardToken: string
  postings: string
  detail: string
}

const rows: Row[] = []

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

/** Canonical domains this run is scoped to. Empty means "the whole yc corpus". */
const scopedDomains: string[] = []
/** The operator's `ats_guess` per canonical domain — a reporting hint, never a decision. */
const guessByDomain = new Map<string, string>()

let seedResult: SeedRunResult | undefined

if (!postingsOnly) {
  if (fromFile) {
    const path = resolve(fromFile)
    const file = readOperatorSeedFile(path)
    console.log(`\nSeeding from operator file ${path} — ${file.seeds.length} row(s)...`)

    for (const seed of file.seeds) {
      const canonical = canonicalizeDomain(seed.website)
      if (!canonical.ok) continue
      scopedDomains.push(canonical.domain)
      const guess = (seed.source.record as Record<string, string>)['ats_guess']?.trim()
      if (guess) guessByDomain.set(canonical.domain, guess)
    }

    // A row the parser could not read at all — wrong field count, or no name/domain.
    // Reported rather than dropped: at ~64% unverified domains, a malformed line is
    // exactly as likely as a wrong one, and both are the operator's to fix.
    for (const bad of file.rejected) {
      rows.push({
        name: '',
        domain: '',
        atsGuess: '',
        outcome: 'unusable_row',
        vendor: '',
        boardToken: '',
        postings: '',
        detail: `line ${bad.line}: ${bad.reason} — ${bad.raw}`,
      })
    }

    seedResult = await runSeedIngest(db, new OperatorFileSeedProvider(file), {
      upsert: upsertOperatorSeededCompany,
    })
  } else {
    console.log(`\nSeeding from yc-oss "${feed}" feed, limit ${limit}...`)
    seedResult = await runSeedIngest(db, new YcOssSeedProvider(gate, { feed, limit }))
  }

  if (seedResult.sourceFailure) {
    console.error(
      `  source failed: ${seedResult.sourceFailure.reason} — ${seedResult.sourceFailure.detail}`,
    )
  } else {
    console.log(
      `  seen ${seedResult.seen}, created ${seedResult.created}, updated ${seedResult.updated}, ` +
        `unchanged ${seedResult.unchanged}, skipped ${seedResult.skipped.length}`,
    )
    const bySkipReason = new Map<string, number>()
    for (const skip of seedResult.skipped) {
      bySkipReason.set(skip.reason, (bySkipReason.get(skip.reason) ?? 0) + 1)
    }
    for (const [reason, count] of bySkipReason) console.log(`    ${reason}: ${count}`)

    // A skipped row is a finding, not a statistic. `source_unavailable` here means the
    // domain the operator typed does not canonicalize — the single most likely typo.
    for (const skip of seedResult.skipped) {
      rows.push({
        name: skip.name,
        domain: '',
        atsGuess: '',
        outcome: 'skipped',
        vendor: '',
        boardToken: '',
        postings: '',
        detail: `${skip.reason}: ${skip.detail}`,
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Detect + postings
// ---------------------------------------------------------------------------

if (!seedOnly) {
  const where = postingsOnly
    ? { atsBoardToken: { not: null } }
    : scopedDomains.length > 0
      ? { canonicalDomain: { in: scopedDomains } }
      : { ycId: { not: null } }

  const companies = await db.company.findMany({
    where,
    select: {
      id: true,
      displayName: true,
      canonicalDomain: true,
      careersUrl: true,
      website: true,
      atsSlug: true,
      atsBoardToken: true,
    },
    orderBy: { createdAt: 'asc' },
  })

  console.log(`\nDetecting ATS boards across ${companies.length} companies...`)
  const providers = atsProviders(gate)
  let detected = 0
  let postingsTotal = 0

  for (const company of companies) {
    const guess = guessByDomain.get(company.canonicalDomain) ?? ''
    const row: Row = {
      name: company.displayName,
      domain: company.canonicalDomain,
      atsGuess: guess,
      outcome: 'detection_failed',
      vendor: '',
      boardToken: '',
      postings: '',
      detail: '',
    }
    rows.push(row)

    let vendor = company.atsSlug
    let boardToken = company.atsBoardToken

    if (!vendor || !boardToken) {
      if (postingsOnly) continue
      try {
        const outcome = await detectAtsForCompany(db, gate, company, {
          maxPages: 2,
          interPageDelayMs: config.DEFAULT_HOST_RATE_DELAY_MS,
        })
        if (!outcome.found) {
          // Never silently dropped. About 120 of the seed file's domains have never
          // been verified against anything, so a detection failure is the expected
          // signal for a bad domain and is the most actionable line in the report.
          row.detail = outcome.detail.slice(0, 300)
          console.log(
            `  ${company.canonicalDomain.padEnd(34)} no board  ${row.detail.split(';')[0] ?? ''}`,
          )
          continue
        }
        await saveDetection(db, company.id, outcome.detection, outcome.sourceUrl)
        vendor = outcome.detection.vendor
        boardToken = outcome.detection.boardToken
      } catch (error) {
        row.detail = `detect ERROR ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`
        console.log(`  ${company.canonicalDomain.padEnd(34)} ${row.detail}`)
        continue
      }
    }

    detected += 1
    row.outcome = 'detected'
    row.vendor = vendor
    row.boardToken = boardToken

    const provider = providers[vendor as keyof typeof providers]
    if (!provider) {
      row.outcome = 'no_adapter'
      continue
    }

    // One company must never end the run. A 2000-company pass is hours long and
    // unattended; an unexpected error on company 900 previously discarded every
    // detection after it. Report and continue.
    try {
      const ingest = await ingestPostings(db, provider, { id: company.id, atsBoardToken: boardToken })
      postingsTotal += ingest.created + ingest.updated + ingest.unchanged
      row.postings = ingest.sourceFailure ? '' : String(ingest.fetched)
      if (ingest.sourceFailure) row.detail = ingest.sourceFailure.reason
      console.log(
        `  ${company.canonicalDomain.padEnd(34)} ${vendor.padEnd(11)} ${boardToken.padEnd(28)} ` +
          `${ingest.sourceFailure ? ingest.sourceFailure.reason : `${ingest.fetched} postings`}` +
          (guess && guess !== 'unknown' && guess !== vendor ? `  (guessed ${guess})` : ''),
      )
    } catch (error) {
      row.detail = `ERROR ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`
      console.log(
        `  ${company.canonicalDomain.padEnd(34)} ${vendor.padEnd(11)} ${boardToken.padEnd(28)} ${row.detail}`,
      )
    }
  }

  console.log(`\n  boards detected: ${detected}/${companies.length}; postings attached: ${postingsTotal}`)
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (reportPath && rows.length > 0) {
  const header = 'name,domain,ats_guess,outcome,vendor,board_token,postings,detail'
  const body = rows
    .map((r) =>
      [r.name, r.domain, r.atsGuess, r.outcome, r.vendor, r.boardToken, r.postings, r.detail]
        .map(csvCell)
        .join(','),
    )
    .join('\n')
  writeFileSync(resolve(reportPath), `${header}\n${body}\n`)
  console.log(`\n  report written to ${reportPath}`)

  const failed = rows.filter((r) => r.outcome === 'detection_failed')
  const unusable = rows.filter((r) => r.outcome === 'unusable_row' || r.outcome === 'skipped')
  console.log(`  detection failed: ${failed.length}   unusable rows: ${unusable.length}`)

  // The guess is a reporting hint and the detector decides — so the only useful thing
  // to do with a guess is show where it was wrong, which is what tells the operator
  // whether their next hand-built list is worth guessing on at all.
  const disagreed = rows.filter(
    (r) => r.outcome === 'detected' && r.atsGuess !== '' && r.atsGuess !== 'unknown' && r.atsGuess !== r.vendor,
  )
  if (disagreed.length > 0) {
    console.log(`  ats_guess disagreed with the detector on ${disagreed.length}:`)
    for (const r of disagreed.slice(0, 20)) {
      console.log(`      ${r.domain.padEnd(30)} guessed ${r.atsGuess.padEnd(12)} detected ${r.vendor}`)
    }
  }
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

await disconnectPrisma()
