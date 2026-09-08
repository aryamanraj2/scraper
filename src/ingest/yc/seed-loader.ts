import type { Db } from '../../core/audit/audit-log.js'
import { writeAudit } from '../../core/audit/audit-log.js'
import type { CompanySeed, SeedProvider } from '../../core/interfaces/providers.js'
import { contentHashOf } from '../../core/evidence/content-hash.js'
import {
  FETCHED_VIA,
  verbatimExcerpt,
  writeCompanySignal,
  writeEvidence,
} from '../../core/evidence/write-evidence.js'
import type { ReasonCodeValue } from '../../core/reason-codes/registry.js'
import { canonicalizeDomain } from '../domain/canonicalize.js'
import { isSourceError } from '../source-error.js'
import { ensureCompanyResearchBudget } from '../budget/company-budget.js'
import { ensureDerivedCompanyHost } from '../host/derived-company-host.js'
import { YC_SOURCE_KEYS, type YcSourceKey } from './yc-oss.js'

export type SeedSkip = {
  externalId: string
  name: string
  reason: ReasonCodeValue
  detail: string
}

export type SeedRunResult = {
  seen: number
  created: number
  updated: number
  /** Re-seen with an identical record: fields refreshed, no new Evidence written. */
  unchanged: number
  skipped: SeedSkip[]
  /** Set when the source itself failed; no records were processed. */
  sourceFailure?: { reason: ReasonCodeValue; detail: string } | undefined
}

export type SeedLoaderOptions = {
  since?: Date | undefined
  now?: () => Date
}

/**
 * Turns a `SeedProvider` stream into `Company` rows with per-field provenance.
 *
 * Four things happen per record, and the order matters:
 *
 *   1. The website is canonicalized to a registrable domain. This is the join key,
 *      so a record that has no usable one is skipped rather than guessed at.
 *   2. The Company is upserted by canonical domain.
 *   3. One `Evidence` row is written PER SOURCE KEY, plus one for the record as a
 *      whole, and the `yc_profile` `CompanySignal` points at the record-level row.
 *   4. A `derived_company` host allow entry and the month's research budget are
 *      opened for the company.
 *
 * ## Why evidence is per source key rather than per company
 *
 * F1's exit criterion is "every field traceable to an `Evidence` row", and
 * `Evidence.excerpt` is capped at 500 verbatim characters. One row per company
 * cannot hold a full yc-oss record, so a single row would either overflow or quote
 * a fraction of the fields it claims to justify — provenance that looks complete
 * in a query and is not. One row per source key keeps every excerpt small, exact,
 * and individually checkable, at the cost of about a dozen rows per company.
 */
export async function runSeedIngest(
  db: Db,
  provider: SeedProvider,
  opts: SeedLoaderOptions = {},
): Promise<SeedRunResult> {
  const now = opts.now ?? (() => new Date())
  const result: SeedRunResult = { seen: 0, created: 0, updated: 0, unchanged: 0, skipped: [] }

  // Canonical domains claimed during THIS run. The unique index already prevents
  // two Company rows sharing a domain, but that surfaces as a constraint error
  // rather than as the `duplicate` decision the operator needs to see.
  const claimed = new Map<string, string>()

  try {
    for await (const seed of provider.listCompanies(opts.since)) {
      result.seen += 1

      const canonical = canonicalizeDomain(seed.website)
      if (!canonical.ok) {
        result.skipped.push({
          externalId: seed.externalId,
          name: seed.name,
          reason: 'source_unavailable',
          detail: `website ${JSON.stringify(seed.website)} is unusable: ${canonical.reason}`,
        })
        await writeAudit(db, {
          actorType: 'system',
          actorId: 'seed-loader',
          action: 'seed.record_skipped',
          subjectType: 'CompanySeed',
          subjectId: seed.externalId,
          reasonCode: 'source_unavailable',
          metadata: { name: seed.name, website: seed.website, cause: canonical.reason },
        })
        continue
      }

      const previous = claimed.get(canonical.domain)
      if (previous !== undefined) {
        result.skipped.push({
          externalId: seed.externalId,
          name: seed.name,
          reason: 'duplicate',
          detail: `${canonical.domain} was already claimed this run by seed ${previous}`,
        })
        await writeAudit(db, {
          actorType: 'system',
          actorId: 'seed-loader',
          action: 'seed.record_skipped',
          subjectType: 'CompanySeed',
          subjectId: seed.externalId,
          reasonCode: 'duplicate',
          metadata: { name: seed.name, canonicalDomain: canonical.domain, firstSeenAs: previous },
        })
        continue
      }
      claimed.set(canonical.domain, seed.externalId)

      const outcome = await upsertSeededCompany(db, seed, canonical.domain, now())
      result[outcome.status] += 1
      if (outcome.evidenceSkipped) result.unchanged += 1
    }
  } catch (err) {
    if (!isSourceError(err)) throw err
    result.sourceFailure = { reason: err.reasonCode, detail: err.message }
    await writeAudit(db, {
      actorType: 'system',
      actorId: 'seed-loader',
      action: 'seed.source_failed',
      subjectType: 'Url',
      subjectId: err.sourceUrl,
      reasonCode: err.reasonCode,
      metadata: { detail: err.message },
    })
  }

  await writeAudit(db, {
    actorType: 'system',
    actorId: 'seed-loader',
    action: 'seed.run_completed',
    subjectType: 'SeedRun',
    metadata: {
      seen: result.seen,
      created: result.created,
      updated: result.updated,
      unchanged: result.unchanged,
      skipped: result.skipped.length,
    },
  })

  return result
}

async function upsertSeededCompany(
  db: Db,
  seed: CompanySeed,
  canonicalDomain: string,
  observedAt: Date,
): Promise<{ status: 'created' | 'updated'; evidenceSkipped: boolean }> {
  const existing = await db.company.findUnique({
    where: { canonicalDomain },
    select: { id: true },
  })

  const data = {
    displayName: seed.name,
    website: seed.website,
    ycId: seed.externalId,
    ycBatch: seed.batch ?? null,
    countries: seed.countries ?? [],
    locations: seed.locations ?? [],
    teamSize: seed.teamSize ?? null,
    tags: seed.tags ?? [],
    ycOneLiner: seed.oneLiner ?? null,
    ycLongDescription: seed.longDescription ?? null,
    ycIsHiring: seed.isHiring ?? null,
    ycStatus: seed.lifecycleStatus ?? null,
    // `normalized` is the Company lifecycle state D1 gives a record that has a
    // canonical domain and provenance but no research yet. F2 moves it on.
    status: 'normalized' as const,
    lastRefreshedAt: observedAt,
  }

  const company = existing
    ? await db.company.update({ where: { id: existing.id }, data, select: { id: true } })
    : await db.company.create({
        data: { canonicalDomain, ...data },
        select: { id: true },
      })

  const evidenceSkipped = await writeSeedEvidence(db, company.id, seed, observedAt)
  await ensureDerivedCompanyHost(db, {
    companyId: company.id,
    host: canonicalDomain,
    sourceUrl: seed.source.url,
  })
  await ensureCompanyResearchBudget(db, company.id, seed.countries ?? [], observedAt)

  return { status: existing ? 'updated' : 'created', evidenceSkipped }
}

/**
 * One `Evidence` row per source key, plus one for the record.
 *
 * Excerpts are re-serialized JSON fragments of the source record: the KEY and the
 * VALUE are exactly what the source published, only the surrounding braces are
 * ours. For a JSON source that is what an excerpt is — no value is reworded,
 * reordered or summarized. The single exception is `long_description`, which can
 * exceed the 500-character column: it is stored as a verbatim PREFIX, with the
 * full text on `Company.ycLongDescription` from this same fetch, so the excerpt
 * opens the text it cites rather than paraphrasing it.
 *
 * Returns true when the record was unchanged and nothing was written.
 *
 * Change detection matters more here than it looks. Each company costs ~13 rows,
 * and yc-oss is refreshed daily against a corpus of ~1,480 hiring companies — so a
 * loader that rewrote its evidence every run would add tens of thousands of
 * identical rows a week, and `Evidence` would stop being a record of what changed
 * and become a record of how often we looked. The record-level `contentHash` is
 * per company (deviation §4.10), so this skips exactly the companies that did not
 * move.
 */
async function writeSeedEvidence(
  db: Db,
  companyId: string,
  seed: CompanySeed,
  observedAt: Date,
): Promise<boolean> {
  const record = seed.source.record

  const priorRecord = await db.evidence.findFirst({
    where: { companyId, sourceType: 'yc', contentHash: seed.source.contentHash },
    select: { id: true },
  })
  if (priorRecord) {
    await writeAudit(db, {
      actorType: 'system',
      actorId: 'seed-loader',
      action: 'seed.record_unchanged',
      subjectType: 'Company',
      subjectId: companyId,
      reasonCode: 'content_unchanged',
      metadata: { contentHash: seed.source.contentHash },
    })
    return true
  }

  const recordEvidence = await writeEvidence(db, {
    companyId,
    sourceUrl: seed.source.url,
    sourceType: 'yc',
    excerpt: verbatimExcerpt(
      JSON.stringify({ id: record['id'], name: record['name'], website: record['website'] }),
    ),
    contentHash: seed.source.contentHash,
    observedAt,
    confidence: SEED_CONFIDENCE,
    fetchedVia: FETCHED_VIA.structuredFeed,
  })

  for (const key of Object.keys(YC_SOURCE_KEYS) as YcSourceKey[]) {
    const value = record[key]
    // A key the source did not publish justifies nothing, and an evidence row
    // quoting `null` is noise that makes real provenance harder to read.
    if (value === undefined || value === null) continue
    if (Array.isArray(value) && value.length === 0) continue
    if (typeof value === 'string' && value.trim() === '') continue

    await writeEvidence(db, {
      companyId,
      sourceUrl: seed.source.url,
      sourceType: 'yc',
      excerpt: verbatimExcerpt(JSON.stringify({ [key]: value })),
      // Per KEY, so F2 can tell which field changed rather than only that
      // something did.
      contentHash: contentHashOf({ [key]: value }),
      observedAt,
      confidence: SEED_CONFIDENCE,
      fetchedVia: FETCHED_VIA.structuredFeed,
    })
  }

  await writeCompanySignal(db, {
    companyId,
    evidenceId: recordEvidence.id,
    signalType: 'yc_profile',
    observedAt,
    confidence: SEED_CONFIDENCE,
  })

  return false
}

/**
 * H7: yc-oss is a seed index with no LICENSE file, and its facts must be
 * re-verified against the company's own site before anything cites them. The
 * confidence recorded here says exactly that — high enough to research, never high
 * enough to quote.
 */
export const SEED_CONFIDENCE = 0.6
