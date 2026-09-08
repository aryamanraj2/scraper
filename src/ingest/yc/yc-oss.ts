import { z } from 'zod'
import type { CompanySeed, GatedFetcher, SeedProvider } from '../../core/interfaces/providers.js'
import { contentHashOf } from '../../core/evidence/content-hash.js'
import { fetchJson } from '../fetch-json.js'
import { SourceError } from '../source-error.js'

/**
 * yc-oss seed loader (Part F, F1).
 *
 * B6: there is no official YC API and `workatastartup.com` has none either, so
 * yc-oss is the only maintained structured source. Endpoints and record shape here
 * were verified live at implementation time via `npm run fixtures:record`; the
 * recorded responses in `test/fixtures/` are what the suite replays.
 *
 * H7 governs how the data may be used: yc-oss publishes no LICENSE file, so it is
 * treated as all-rights-reserved compiled data and used as a SEED INDEX ONLY.
 * Nothing from it may be cited in a draft or an application packet without being
 * re-verified against the company's own site. That is a downstream rule, but it is
 * the reason this module records `EvidenceSourceType.yc` rather than pretending a
 * YC field is an employer statement.
 */

export const YC_OSS_BASE = 'https://yc-oss.github.io/api'

export const YC_OSS_FEEDS = {
  meta: `${YC_OSS_BASE}/meta.json`,
  all: `${YC_OSS_BASE}/companies/all.json`,
  hiring: `${YC_OSS_BASE}/companies/hiring.json`,
} as const

export type YcFeed = keyof Omit<typeof YC_OSS_FEEDS, 'meta'>

/**
 * The feeds run to tens of megabytes, well past the research-page default. Raised
 * here, at the call site, so nothing is ever truncated silently.
 */
export const YC_FEED_MAX_BYTES = 96 * 1024 * 1024

/**
 * Deliberately permissive. yc-oss adds fields without warning, and a strict schema
 * would turn a harmless new key into a total ingestion outage. Only `id` and `name`
 * are required — without them there is no record to speak of. Everything else is
 * optional and nullable, and a record that fails even this is skipped and counted
 * rather than throwing.
 */
export const YcCompanyRecord = z
  .object({
    id: z.union([z.number(), z.string()]),
    name: z.string().min(1),
    slug: z.string().nullish(),
    website: z.string().nullish(),
    all_locations: z.string().nullish(),
    regions: z.array(z.string()).nullish(),
    long_description: z.string().nullish(),
    one_liner: z.string().nullish(),
    team_size: z.number().nullish(),
    industry: z.string().nullish(),
    subindustry: z.string().nullish(),
    industries: z.array(z.string()).nullish(),
    tags: z.array(z.string()).nullish(),
    batch: z.string().nullish(),
    status: z.string().nullish(),
    isHiring: z.boolean().nullish(),
    url: z.string().nullish(),
  })
  .loose()

export type YcCompanyRecord = z.infer<typeof YcCompanyRecord>

export const YcMeta = z
  .object({
    last_updated: z.string(),
    companies: z.record(
      z.string(),
      z.object({ name: z.string(), count: z.number(), api: z.string() }).loose(),
    ),
  })
  .loose()

export type YcMeta = z.infer<typeof YcMeta>

/**
 * The source keys this loader persists, and the Company fields each one justifies.
 *
 * This table is the single definition of yc-oss provenance: `seed-loader.ts`
 * iterates it to write one `Evidence` row per key, and the traceability test
 * iterates it to assert every populated field has a citing row. One table used by
 * both is the point — a field added to the mapping without evidence, or evidence
 * written for a field nobody persists, cannot happen.
 */
export const YC_SOURCE_KEYS = {
  id: ['ycId'],
  name: ['displayName'],
  website: ['website', 'canonicalDomain'],
  batch: ['ycBatch'],
  all_locations: ['locations', 'countries'],
  team_size: ['teamSize'],
  tags: ['tags'],
  industries: ['tags'],
  one_liner: ['ycOneLiner'],
  long_description: ['ycLongDescription'],
  isHiring: ['ycIsHiring'],
  status: ['ycStatus'],
} as const satisfies Record<string, readonly string[]>

export type YcSourceKey = keyof typeof YC_SOURCE_KEYS

/**
 * yc-oss writes several offices into one string, separated by semicolons, each in
 * `City, Region, Country` form — verified against the recorded fixture. Splitting
 * on the semicolon yields the individual locations verbatim; nothing is reworded.
 */
export function splitLocations(allLocations: string | null | undefined): string[] {
  return (allLocations ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

/**
 * The country is the last comma-separated segment of a yc-oss location, so it is a
 * verbatim substring of `all_locations` rather than a lookup — which is what keeps
 * it traceable to the evidence excerpt that quotes that field.
 *
 * The spellings are the source's own and are NOT normalized here: "USA" and
 * "United States of America" both appear across yc-oss fields. Normalizing would
 * mean storing a string the source never wrote, in a system whose central rule is
 * that stored facts are traceable to what the source said. F2 owns country
 * normalization, at classification time, where it can record the mapping it used.
 *
 * A location that is only "Remote" names no country and contributes none.
 */
export function countriesFromLocations(locations: string[]): string[] {
  const out: string[] = []
  for (const location of locations) {
    const segments = location.split(',').map((s) => s.trim()).filter((s) => s !== '')
    const last = segments.at(-1)
    if (!last) continue
    if (last.toLowerCase() === 'remote') continue
    if (!out.includes(last)) out.push(last)
  }
  return out
}

export type YcOssSeedProviderOptions = {
  /** `hiring` (~1,480 companies) or `all` (~6,200). */
  feed?: YcFeed
  /** Stops after this many usable records. F1's target is 100-200 companies. */
  limit?: number
  now?: () => Date
}

export class YcOssSeedProvider implements SeedProvider {
  readonly slug = 'yc-oss'

  constructor(
    private readonly fetcher: GatedFetcher,
    private readonly opts: YcOssSeedProviderOptions = {},
  ) {}

  /** `meta.json` carries the index-wide `last_updated` stamp and the feed catalogue. */
  async readMeta(): Promise<YcMeta> {
    const fetched = await fetchJson(this.fetcher, YC_OSS_FEEDS.meta, {
      ...(this.opts.now ? { now: this.opts.now } : {}),
    })
    const parsed = YcMeta.safeParse(fetched.value)
    if (!parsed.success) {
      throw SourceError.unusable(YC_OSS_FEEDS.meta, `meta.json did not match the expected shape`)
    }
    return parsed.data
  }

  /**
   * `since` is honoured at FEED granularity, not per record, because yc-oss
   * publishes no per-record modification stamp — only the index-wide
   * `meta.last_updated`. Pretending otherwise would silently drop changed records,
   * so an unchanged index yields nothing and a changed one yields everything.
   */
  async *listCompanies(since?: Date): AsyncIterable<CompanySeed> {
    if (since) {
      const meta = await this.readMeta()
      const lastUpdated = new Date(meta.last_updated)
      if (!Number.isNaN(lastUpdated.getTime()) && lastUpdated <= since) return
    }

    const feed = this.opts.feed ?? 'hiring'
    const url = YC_OSS_FEEDS[feed]
    const fetched = await fetchJson(this.fetcher, url, {
      maxBytes: YC_FEED_MAX_BYTES,
      ...(this.opts.now ? { now: this.opts.now } : {}),
    })

    if (!Array.isArray(fetched.value)) {
      throw SourceError.unusable(url, 'feed was not a JSON array')
    }

    const limit = this.opts.limit ?? Number.POSITIVE_INFINITY
    let yielded = 0
    for (const raw of fetched.value) {
      if (yielded >= limit) return
      const parsed = YcCompanyRecord.safeParse(raw)
      // A single malformed record is skipped, not fatal: one bad row must not
      // cost the other 1,479.
      if (!parsed.success) continue

      yielded += 1
      yield toSeed(parsed.data, url, fetched.observedAt)
    }
  }
}

export function toSeed(
  record: YcCompanyRecord,
  sourceUrl: string,
  observedAt: Date,
): CompanySeed {
  const locations = splitLocations(record.all_locations)
  const tags = [...(record.tags ?? []), ...(record.industries ?? [])].filter(
    (tag, index, all) => tag.trim() !== '' && all.indexOf(tag) === index,
  )

  return {
    externalId: String(record.id),
    name: record.name,
    website: record.website ?? null,
    ...(record.batch ? { batch: record.batch } : {}),
    locations,
    countries: countriesFromLocations(locations),
    ...(typeof record.team_size === 'number' ? { teamSize: record.team_size } : {}),
    tags,
    ...(record.one_liner ? { oneLiner: record.one_liner } : {}),
    ...(record.long_description ? { longDescription: record.long_description } : {}),
    ...(typeof record.isHiring === 'boolean' ? { isHiring: record.isHiring } : {}),
    ...(record.status ? { lifecycleStatus: record.status } : {}),
    source: {
      url: sourceUrl,
      record: record as Record<string, unknown>,
      observedAt,
      // Hashed per RECORD, not per feed. A feed-level hash changes whenever any
      // one of ~1,480 companies changes, so it would mark every company as
      // changed on every run and make F2's change detection worthless.
      contentHash: contentHashOf(record),
    },
  }
}
