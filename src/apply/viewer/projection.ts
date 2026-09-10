import type { Db } from '../../core/audit/audit-log.js'
import { FETCHED_VIA, type FetchedVia } from '../../core/evidence/write-evidence.js'

/**
 * The evidence viewer's projection.
 *
 * ## `handover.md` §16, which is a policy and not a style rule
 *
 * > *Browser-derived and API-derived facts must display identically in the evidence
 * > viewer, including source, timestamp, excerpt, and confidence.*
 *
 * The failure it prevents is subtle and one-directional. If a fact fetched through a
 * browser (or Firecrawl, or any escalation tier) renders with a badge, a caveat, or
 * one fewer field than a fact from an official feed, the reviewer starts discounting
 * it — or, worse, starts trusting the feed-derived one *more than its excerpt
 * warrants* because it looks more official. Provenance is the excerpt and the URL, not
 * the pipe the bytes came down.
 *
 * So this function is written to make the property structural rather than remembered:
 *
 *  - **One return type, every field always present.** No optional field, no field
 *    that only some tiers populate. A `browser_task` row and a `structured_feed` row
 *    produce objects with the identical key set, in the identical order.
 *  - **The only thing `fetchedVia` selects is a human-readable label**, from a table
 *    that is total over the union — so a new tier cannot render as a blank.
 *  - **No tier-conditional formatting, ordering, or emphasis anywhere.** There is
 *    deliberately no `isTrusted`, no `tierRank`, no `warning` field for a UI to hang
 *    a badge on, because the moment one exists someone will render it.
 *
 * `fetchedVia` itself is still returned. Hiding it would be the opposite error: an
 * auditor must be able to see which tier produced a row (D4 asks that the record show
 * a cheaper sufficient source was not skipped). The requirement is that the viewer
 * treat the tiers alike, not that it conceal them.
 */

export type EvidenceView = {
  evidenceId: string
  sourceUrl: string
  sourceType: string
  fetchedVia: string
  /** Display label. The ONLY value on this object that varies with the tier. */
  fetchedViaLabel: string
  observedAt: string
  excerpt: string
  confidence: number
}

/**
 * Total over every `fetchedVia` the system declares, including tiers no milestone has
 * produced yet — a label lookup that can miss is a blank in the UI, which is a
 * difference in how a tier displays.
 */
export const FETCHED_VIA_LABELS: Record<FetchedVia, string> = {
  [FETCHED_VIA.structuredFeed]: 'Official feed',
  [FETCHED_VIA.staticFetch]: 'Employer page',
  [FETCHED_VIA.firecrawl]: 'Rendered page',
  [FETCHED_VIA.browserTask]: 'Browser session',
  [FETCHED_VIA.userHint]: 'Operator-supplied',
}

export function labelForFetchedVia(via: string): string {
  return FETCHED_VIA_LABELS[via as FetchedVia] ?? via
}

export type EvidenceRow = {
  id: string
  sourceUrl: string
  sourceType: string
  fetchedVia: string
  observedAt: Date
  excerpt: string
  confidence: number | { toNumber(): number }
}

/**
 * One row in, one shape out. Note there is no branch on `fetchedVia` other than the
 * label: that absence is the requirement.
 */
export function projectEvidence(row: EvidenceRow): EvidenceView {
  return {
    evidenceId: row.id,
    sourceUrl: row.sourceUrl,
    sourceType: row.sourceType,
    fetchedVia: row.fetchedVia,
    fetchedViaLabel: labelForFetchedVia(row.fetchedVia),
    observedAt: row.observedAt.toISOString(),
    excerpt: row.excerpt,
    confidence: typeof row.confidence === 'number' ? row.confidence : row.confidence.toNumber(),
  }
}

/** The key set every projected row carries, in order. Asserted by test. */
export const EVIDENCE_VIEW_KEYS: readonly (keyof EvidenceView)[] = [
  'evidenceId',
  'sourceUrl',
  'sourceType',
  'fetchedVia',
  'fetchedViaLabel',
  'observedAt',
  'excerpt',
  'confidence',
]

export async function loadEvidenceViews(db: Db, ids: string[]): Promise<EvidenceView[]> {
  if (ids.length === 0) return []
  const rows = await db.evidence.findMany({
    where: { id: { in: ids } },
    orderBy: { observedAt: 'desc' },
    select: {
      id: true,
      sourceUrl: true,
      sourceType: true,
      fetchedVia: true,
      observedAt: true,
      excerpt: true,
      confidence: true,
    },
  })
  return rows.map(projectEvidence)
}

// ---------------------------------------------------------------------------
// Score reasons — the other half of what a reviewer reads
// ---------------------------------------------------------------------------

/**
 * F2 stored a score's *reasons*, not only its number: every component's points, its
 * maximum, the sentence explaining it, the risk deductions, the reason codes, the
 * country map version, and the matched snippets per track. The F3 handover asks the
 * viewer to render those sentences, because they were written to be read by a human.
 *
 * This projects them without recomputing anything. A11 freezes the weights so reason
 * codes can be reviewed qualitatively, and A1 requires a stored score to replay from
 * `score_components` alone — a viewer that re-derived a component would be showing
 * the reviewer something other than what was stored.
 */
export type ScoreComponentView = {
  key: string
  points: number
  max: number
  reason: string
}

export type ScoreView = {
  total: number | null
  subtotal: number | null
  riskDeduction: number | null
  band: string | null
  scoreVersion: string | null
  primaryTrack: string | null
  primaryTrackReason: string | null
  countryMapVersion: string | null
  components: ScoreComponentView[]
  risks: { key: string; points: number; reason: string }[]
  reasonCodes: string[]
  tracks: { track: string; confidence: number; specificTerms: string[]; snippets: string[] }[]
}

type RawComponents = {
  total?: number
  subtotal?: number
  riskDeduction?: number
  band?: string
  scoreVersion?: string
  primaryTrack?: string
  primaryTrackReason?: string
  countryMapVersion?: string
  components?: { key: string; points: number; max: number; reason: string }[]
  risks?: { key: string; points: number; reason: string }[]
  reasonCodes?: string[]
  tracks?: { track: string; confidence: number; specificTerms?: string[]; snippets?: string[] }[]
}

export function projectScore(scoreComponents: unknown): ScoreView {
  const raw = (scoreComponents ?? {}) as RawComponents
  return {
    total: raw.total ?? null,
    subtotal: raw.subtotal ?? null,
    riskDeduction: raw.riskDeduction ?? null,
    band: raw.band ?? null,
    scoreVersion: raw.scoreVersion ?? null,
    primaryTrack: raw.primaryTrack ?? null,
    primaryTrackReason: raw.primaryTrackReason ?? null,
    countryMapVersion: raw.countryMapVersion ?? null,
    components: (raw.components ?? []).map((c) => ({
      key: c.key,
      points: c.points,
      max: c.max,
      reason: c.reason,
    })),
    risks: (raw.risks ?? []).map((r) => ({ key: r.key, points: r.points, reason: r.reason })),
    reasonCodes: raw.reasonCodes ?? [],
    tracks: (raw.tracks ?? []).map((t) => ({
      track: t.track,
      confidence: t.confidence,
      specificTerms: t.specificTerms ?? [],
      snippets: t.snippets ?? [],
    })),
  }
}
