import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { Db } from '../../core/audit/audit-log.js'
import { writeAudit } from '../../core/audit/audit-log.js'
import { contentHashOf } from '../../core/evidence/content-hash.js'
import { FETCHED_VIA, verbatimExcerpt, writeEvidence } from '../../core/evidence/write-evidence.js'
import type { CompanySeed, SeedProvider } from '../../core/interfaces/providers.js'
import { ensureCompanyResearchBudget } from '../budget/company-budget.js'
import { ensureDerivedCompanyHost } from '../host/derived-company-host.js'
import { cell, cellList, missingColumns, parseCsv, type CsvRow } from './csv.js'

/**
 * An operator-authored company list, ingested as a seed source alongside yc-oss.
 *
 * ## Why this exists
 *
 * The corpus was yc-oss only, which is a US accelerator index: 1,548 of 1,975
 * companies ended at `insufficient_evidence`, and **zero** of 57 qualified leads
 * landed on the `ios_android` track, so two of the operator's four resumes had never
 * once been selected. Widening the feed does not fix either — `--feed all` is 13x the
 * same index. A different kind of source does, and the cheapest different source is a
 * list the operator wrote by hand.
 *
 * ## What this file is, and what it is not
 *
 * It is a **hint**, in the strict sense this project uses that word. The operator
 * typed a name and a domain; roughly 120 of the 188 domains have never been checked
 * against anything. So:
 *
 *   - Nothing here is citable. The `Evidence` rows carry `user_hint` and a confidence
 *     of {@link OPERATOR_SEED_CONFIDENCE} — the same "high enough to research, never
 *     high enough to quote" position H7 takes about yc-oss, one notch lower because a
 *     typed line has no publisher at all.
 *   - `ats_guess` is **not** written to `Company.atsSlug`. The detector decides; the
 *     guess is retained on its own `Evidence` row so the run can report where the two
 *     disagreed, which is the only thing a guess is good for.
 *   - A domain that fails detection is a **finding**, not a dropped row. At a 64%
 *     unverified rate, failed detection is the expected signal for a typo, and the
 *     run reports every one.
 *
 * ## Why it does not reuse `upsertSeededCompany`
 *
 * The yc upsert writes the whole yc field set on every pass and resets `status` to
 * `normalized`. Eighteen of these rows already exist, some of them scored and
 * qualified, so running that path over them would blank `ycBatch`, `ycOneLiner`,
 * `teamSize` and `ycStatus` with nulls this file does not have, and knock qualified
 * companies back down the lifecycle. This upsert only ever **adds**: see
 * {@link upsertOperatorSeededCompany}.
 */

export const SEED_FILE_COLUMNS = [
  'name',
  'domain',
  'hq_country',
  'headcount_band',
  'tracks',
  'ats_guess',
  'notes',
] as const

/** Columns without which a row cannot become a Company. */
export const SEED_FILE_REQUIRED = ['name', 'domain'] as const

/**
 * Lower than yc-oss's 0.6 on purpose. yc-oss is a published index with a fetchable
 * URL and a content hash; this is a line somebody typed. Both are research leads and
 * neither is quotable, but only one of them has a publisher who could be wrong in
 * public.
 */
export const OPERATOR_SEED_CONFIDENCE = 0.5

/**
 * `Company.tags` carries the operator's two non-citable classifications, namespaced
 * so they are distinguishable from yc-oss's own tag vocabulary at a glance and
 * removable with one predicate.
 *
 * They live on the Company rather than only on an Evidence row because the whole
 * point of `tracks` is to answer "which of these companies should have produced an
 * `ios_android` lead and did not", and that question is a query.
 */
export const TRACK_TAG_PREFIX = 'seed-track:'
export const HEADCOUNT_TAG_PREFIX = 'seed-headcount:'

export type OperatorSeedFile = {
  /** Absolute path, as given. */
  path: string
  /** `file://` URL of the path — what every Evidence row from this file cites. */
  sourceUrl: string
  seeds: CompanySeed[]
  /** Rows the parser could not turn into a seed, with the reason and the line number. */
  rejected: { line: number; raw: string; reason: string }[]
}

/**
 * Reads and validates the file. Does not touch the database.
 *
 * A missing required column fails the whole file rather than each row: a header typo
 * would otherwise be reported 188 times, and the operator's fix is one edit either
 * way.
 */
export function readOperatorSeedFile(path: string): OperatorSeedFile {
  const text = readFileSync(path, 'utf8')
  const parsed = parseCsv(text)

  const missing = missingColumns(parsed.header, SEED_FILE_REQUIRED)
  if (missing.length > 0) {
    throw new Error(
      `${path} is missing required column(s): ${missing.join(', ')}. ` +
        `Expected header: ${SEED_FILE_COLUMNS.join(',')}`,
    )
  }

  const sourceUrl = pathToFileURL(path).toString()
  const seeds: CompanySeed[] = []
  const rejected: OperatorSeedFile['rejected'] = parsed.malformed.map((m) => ({
    line: m.line,
    raw: m.raw,
    reason: `row has ${m.got} field(s), header has ${m.want}`,
  }))

  for (const row of parsed.rows) {
    const name = cell(row, 'name')
    const domain = cell(row, 'domain')
    if (name === null || domain === null) {
      rejected.push({ line: row.line, raw: row.raw, reason: 'name and domain are both required' })
      continue
    }
    seeds.push(seedFromRow(row, name, domain, sourceUrl))
  }

  return { path, sourceUrl, seeds, rejected }
}

function seedFromRow(row: CsvRow, name: string, domain: string, sourceUrl: string): CompanySeed {
  const country = cell(row, 'hq_country')
  const headcount = cell(row, 'headcount_band')
  const tracks = cellList(row, 'tracks')

  // The record is the row's cells, exactly as typed — no coercion, no renaming. That
  // is what makes the per-key Evidence excerpts below verbatim rather than a
  // re-description of what the operator meant.
  const record: Record<string, unknown> = { ...row.cells }

  return {
    externalId: `seed-file:${domain.toLowerCase()}`,
    name,
    // The column is specified as a bare domain, and the scheme is added so
    // `Company.website` is a URL like every other row's. An operator who pastes a full
    // URL instead is not corrected into `https://https://…`, which canonicalizes to the
    // host "https" and skips the row for a reason that says nothing about the mistake.
    website: /^[a-z][a-z0-9+.-]*:\/\//i.test(domain) ? domain : `https://${domain}`,
    ...(country === null ? {} : { countries: [country] }),
    tags: [
      ...tracks.map((t) => `${TRACK_TAG_PREFIX}${t}`),
      ...(headcount === null ? [] : [`${HEADCOUNT_TAG_PREFIX}${headcount}`]),
    ],
    origin: 'operator_file',
    source: {
      url: sourceUrl,
      record,
      observedAt: new Date(),
      contentHash: contentHashOf(record),
    },
  }
}

/** A `SeedProvider` over an already-read file, so `runSeedIngest` drives this path too. */
export class OperatorFileSeedProvider implements SeedProvider {
  constructor(private readonly file: OperatorSeedFile) {}

  async *listCompanies(): AsyncIterable<CompanySeed> {
    for (const seed of this.file.seeds) yield seed
  }
}

/**
 * Upserts a Company from an operator-typed row, **additively**.
 *
 * Every decision here is about not damaging a row that already exists and knows more
 * than this file does:
 *
 *   - `status` is set only on create. Eighteen of these companies are already in the
 *     corpus and some are `qualified`; writing `normalized` over that would silently
 *     reverse work F2 and F3 did.
 *   - `displayName` and `website` are filled only when absent. The file's name for an
 *     existing company is not better information than the one already stored, and
 *     rewriting it churns every row for nothing.
 *   - `countries` and `tags` are unioned, never replaced. A yc company with
 *     `["United States of America"]` that this file also lists as India keeps both;
 *     `resolveCountries` takes the highest-priority region present, which is what
 *     `handover.md` §1 asks for.
 *   - `ycId` is never written. It is unique, and an operator row is not a YC record.
 *
 * Provenance and the per-company research envelope are opened exactly as the yc path
 * opens them — `ensureDerivedCompanyHost` so the domain is fetchable at all, and
 * `ensureCompanyResearchBudget` so the cap exists before the first credit is spent
 * (F1 §4.2). The India allowance (H5) falls out of `countries` without a special case.
 */
export async function upsertOperatorSeededCompany(
  db: Db,
  seed: CompanySeed,
  canonicalDomain: string,
  observedAt: Date,
): Promise<{ status: 'created' | 'updated'; evidenceSkipped: boolean }> {
  const existing = await db.company.findUnique({
    where: { canonicalDomain },
    select: { id: true, website: true, countries: true, tags: true },
  })

  const countries = union(existing?.countries ?? [], seed.countries ?? [])
  const tags = union(existing?.tags ?? [], seed.tags ?? [])

  const company = existing
    ? await db.company.update({
        where: { id: existing.id },
        data: {
          // `displayName` is deliberately absent: it is already set on every existing
          // row, and this file's spelling of a company's name is not better
          // information than the one the corpus already has.
          website: existing.website ?? seed.website,
          countries,
          tags,
          lastRefreshedAt: observedAt,
        },
        select: { id: true },
      })
    : await db.company.create({
        data: {
          canonicalDomain,
          displayName: seed.name,
          website: seed.website,
          countries,
          tags,
          // D1's lifecycle state for a company with a canonical domain and provenance
          // but no research yet. Set on create only — see the doc comment.
          status: 'normalized',
          lastRefreshedAt: observedAt,
        },
        select: { id: true },
      })

  const evidenceSkipped = await writeOperatorSeedEvidence(db, company.id, seed, observedAt)
  await ensureDerivedCompanyHost(db, {
    companyId: company.id,
    host: canonicalDomain,
    sourceUrl: seed.source.url,
  })
  await ensureCompanyResearchBudget(db, company.id, countries, observedAt)

  return { status: existing ? 'updated' : 'created', evidenceSkipped }
}

/**
 * One `Evidence` row per populated column, plus one for the row as a whole.
 *
 * Same shape as the yc loader's, for the same reason: `Evidence.excerpt` is capped at
 * 500 verbatim characters, so one row per company would quote a fraction of the
 * fields it claims to justify. The record-level excerpt is the **raw CSV line**,
 * which for this source is literally what was published.
 *
 * No `CompanySignal` is written, and that is deliberate rather than an omission. The
 * signal vocabulary is a closed enum of things observed about a company —
 * `yc_profile`, `careers_page`, `job_posting` — and an operator's typed line is none
 * of them. Filing it under `yc_profile` because that is the nearest value would put a
 * false claim about where a fact came from into the table F2 scores from.
 *
 * Returns true when this exact row was already ingested and nothing was written.
 */
async function writeOperatorSeedEvidence(
  db: Db,
  companyId: string,
  seed: CompanySeed,
  observedAt: Date,
): Promise<boolean> {
  const prior = await db.evidence.findFirst({
    where: { companyId, sourceType: 'user_hint', contentHash: seed.source.contentHash },
    select: { id: true },
  })
  if (prior) {
    await writeAudit(db, {
      actorType: 'system',
      actorId: 'operator-seed',
      action: 'seed.record_unchanged',
      subjectType: 'Company',
      subjectId: companyId,
      reasonCode: 'content_unchanged',
      metadata: { contentHash: seed.source.contentHash, source: seed.source.url },
    })
    return true
  }

  const record = seed.source.record as Record<string, string>

  await writeEvidence(db, {
    companyId,
    sourceUrl: seed.source.url,
    sourceType: 'user_hint',
    excerpt: verbatimExcerpt(Object.values(record).join(',')),
    contentHash: seed.source.contentHash,
    observedAt,
    confidence: OPERATOR_SEED_CONFIDENCE,
    fetchedVia: FETCHED_VIA.userHint,
  })

  for (const key of SEED_FILE_COLUMNS) {
    const value = record[key]
    if (value === undefined || value.trim() === '') continue
    await writeEvidence(db, {
      companyId,
      sourceUrl: seed.source.url,
      sourceType: 'user_hint',
      excerpt: verbatimExcerpt(JSON.stringify({ [key]: value })),
      // Per key, so a later run can tell which cell the operator corrected rather
      // than only that the line changed.
      contentHash: contentHashOf({ [key]: value }),
      observedAt,
      confidence: OPERATOR_SEED_CONFIDENCE,
      fetchedVia: FETCHED_VIA.userHint,
    })
  }

  return false
}

function union(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])]
}
