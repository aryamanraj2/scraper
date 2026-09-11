#!/usr/bin/env tsx
/**
 * F1's demonstrable artifact: seed a corpus of companies from yc-oss, detect each
 * one's ATS board, and attach its live postings — every field traceable to an
 * `Evidence` row.
 *
 * Run by hand, like `fixtures:record`, and for the same reason: it touches live
 * sources. `npm test` never does.
 *
 *   npm run ingest:seed                       # 150 companies from the hiring feed
 *   npm run ingest:seed -- --limit 40
 *   npm run ingest:seed -- --feed all --limit 200
 *   npm run ingest:seed -- --seed-only        # skip ATS detection and postings
 *   npm run ingest:seed -- --postings-only    # refresh boards already detected
 *
 * Every request goes through `FetchPolicyGate`, so the per-host rate delay applies
 * to employer domains too. Detection is the slow part by construction: it is one
 * host per company, and politeness is the point.
 */
import 'dotenv/config'
import { prisma, disconnectPrisma } from '../src/core/db/client.js'
import { env } from '../src/core/config/config.js'
import { FetchPolicyGate } from '../src/core/policy/fetch-policy-gate.js'
import { YcOssSeedProvider, type YcFeed } from '../src/ingest/yc/yc-oss.js'
import { runSeedIngest } from '../src/ingest/yc/seed-loader.js'
import { detectAtsForCompany, saveDetection } from '../src/ingest/ats/detect.js'
import { atsProviders, ingestPostings } from '../src/ingest/ats/ingest-postings.js'

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const limit = Number(flag('limit') ?? 150)
const feed = (flag('feed') ?? 'hiring') as YcFeed
const seedOnly = process.argv.includes('--seed-only')
/**
 * Refresh the boards we already know about, without re-attempting detection on
 * the companies that failed it. Detection is the expensive half — one host per
 * company at the per-host rate delay — and re-running it changes nothing for a
 * company whose site simply does not publish a board link. This is also the shape
 * of F2's weekly refresh: read the known boards, let the job-count deltas fall out
 * of it.
 */
const postingsOnly = process.argv.includes('--postings-only')

const db = prisma()
const config = env()
const gate = new FetchPolicyGate(db, {
  userAgent: config.USER_AGENT,
  robotsTtlSeconds: config.ROBOTS_CACHE_TTL_SECONDS,
  defaultRateDelayMs: config.DEFAULT_HOST_RATE_DELAY_MS,
})

if (!postingsOnly) {
  console.log(`\nSeeding from yc-oss "${feed}" feed, limit ${limit}...`)
  const seedResult = await runSeedIngest(db, new YcOssSeedProvider(gate, { feed, limit }))

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
  }
}

if (!seedOnly) {
  const companies = await db.company.findMany({
    where: postingsOnly ? { atsBoardToken: { not: null } } : { ycId: { not: null } },
    select: { id: true, canonicalDomain: true, careersUrl: true, website: true, atsSlug: true, atsBoardToken: true },
    orderBy: { createdAt: 'asc' },
  })

  console.log(`\nDetecting ATS boards across ${companies.length} companies...`)
  const providers = atsProviders(gate)
  let detected = 0
  let postingsTotal = 0

  for (const company of companies) {
    let vendor = company.atsSlug
    let boardToken = company.atsBoardToken

    if (!vendor || !boardToken) {
      if (postingsOnly) continue
      try {
        const outcome = await detectAtsForCompany(db, gate, company, {
          maxPages: 2,
          interPageDelayMs: config.DEFAULT_HOST_RATE_DELAY_MS,
        })
        if (!outcome.found) continue
        await saveDetection(db, company.id, outcome.detection, outcome.sourceUrl)
        vendor = outcome.detection.vendor
        boardToken = outcome.detection.boardToken
      } catch (error) {
        console.log(
          `  ${company.canonicalDomain.padEnd(34)} detect ERROR ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
        )
        continue
      }
    }

    detected += 1
    const provider = providers[vendor as keyof typeof providers]
    if (!provider) continue

    // One company must never end the run. A 2000-company pass is hours long and
    // unattended; an unexpected error on company 900 previously discarded every
    // detection after it. Report and continue.
    try {
      const ingest = await ingestPostings(db, provider, { id: company.id, atsBoardToken: boardToken })
      postingsTotal += ingest.created + ingest.updated + ingest.unchanged
      console.log(
        `  ${company.canonicalDomain.padEnd(34)} ${vendor.padEnd(11)} ${boardToken.padEnd(28)} ` +
          `${ingest.sourceFailure ? ingest.sourceFailure.reason : `${ingest.fetched} postings`}`,
      )
    } catch (error) {
      console.log(
        `  ${company.canonicalDomain.padEnd(34)} ${vendor.padEnd(11)} ${boardToken.padEnd(28)} ` +
          `ERROR ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
      )
    }
  }

  console.log(`\n  boards detected: ${detected}/${companies.length}; postings attached: ${postingsTotal}`)
}

await disconnectPrisma()
