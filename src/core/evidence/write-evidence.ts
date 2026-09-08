import type { Db } from '../audit/audit-log.js'
import type { CompanySignalType, EvidenceSourceType } from '../../../generated/prisma/enums.js'

/** D5: "verbatim, <=500 chars, never paraphrased". The column enforces the length. */
export const MAX_EXCERPT_CHARS = 500

/**
 * The tier of D4's source precedence that produced a row, recorded on
 * `Evidence.fetchedVia` so an audit can show a cheaper sufficient source was not
 * skipped. F1 only ever produces the first tier; the rest are declared here so
 * later milestones do not invent parallel spellings.
 */
export const FETCHED_VIA = {
  structuredFeed: 'structured_feed',
  staticFetch: 'static_fetch',
  firecrawl: 'firecrawl',
  browserTask: 'browser_task',
  userHint: 'user_hint',
} as const

export type FetchedVia = (typeof FETCHED_VIA)[keyof typeof FETCHED_VIA]

export type EvidenceInput = {
  companyId?: string | null
  sourceUrl: string
  sourceType: EvidenceSourceType
  /** Verbatim. See `verbatimExcerpt` for the one transformation permitted. */
  excerpt: string
  contentHash: string
  observedAt: Date
  confidence: number
  fetchedVia: FetchedVia
}

/**
 * Provenance writer. Every fact this system stores points at one of these rows,
 * and `handover.md` §11's reconstruction criterion is only true if the excerpt is
 * what the source actually said.
 *
 * The excerpt is validated rather than trusted: an empty one is rejected outright,
 * because a row with no excerpt looks like provenance in a query and proves
 * nothing. Over-length text is rejected too — silently truncating here would let a
 * caller believe it stored a fact it did not, so truncation is the caller's
 * explicit decision via `verbatimExcerpt`.
 */
export async function writeEvidence(db: Db, input: EvidenceInput): Promise<{ id: string }> {
  const excerpt = input.excerpt
  if (excerpt.trim() === '') {
    throw new Error(`Evidence excerpt is empty for ${input.sourceUrl}; provenance must quote the source.`)
  }
  if (excerpt.length > MAX_EXCERPT_CHARS) {
    throw new Error(
      `Evidence excerpt is ${excerpt.length} chars for ${input.sourceUrl}; the limit is ` +
        `${MAX_EXCERPT_CHARS}. Use verbatimExcerpt() to take a verbatim prefix deliberately.`,
    )
  }
  const row = await db.evidence.create({
    data: {
      companyId: input.companyId ?? null,
      sourceUrl: input.sourceUrl,
      sourceType: input.sourceType,
      excerpt,
      contentHash: input.contentHash,
      observedAt: input.observedAt,
      confidence: input.confidence,
      fetchedVia: input.fetchedVia,
    },
    select: { id: true },
  })
  return row
}

/**
 * A verbatim prefix of `text`, at most `MAX_EXCERPT_CHARS`.
 *
 * A prefix is still verbatim — it is the source's own words in the source's own
 * order. Nothing is appended: an ellipsis would be a character the source did not
 * write, sitting in a column whose whole purpose is that its contents were not
 * altered. Callers that need the full text keep it on its own column and cite this
 * excerpt as the opening of it.
 */
export function verbatimExcerpt(text: string, limit = MAX_EXCERPT_CHARS): string {
  const trimmed = text.trim()
  return trimmed.length <= limit ? trimmed : trimmed.slice(0, limit)
}

export type CompanySignalInput = {
  companyId: string
  evidenceId: string
  signalType: CompanySignalType
  observedAt: Date
  confidence: number
  numericValue?: number | undefined
}

/**
 * §4.5 of the F1 handover: `CompanySignal` keeps its `handover.md` §4 name but no
 * longer carries its own source URL or excerpt — provenance lives on the referenced
 * `Evidence` row only, so the two cannot disagree.
 */
export async function writeCompanySignal(db: Db, input: CompanySignalInput): Promise<{ id: string }> {
  return db.companySignal.create({
    data: {
      companyId: input.companyId,
      evidenceId: input.evidenceId,
      signalType: input.signalType,
      observedAt: input.observedAt,
      confidence: input.confidence,
      numericValue: input.numericValue ?? null,
    },
    select: { id: true },
  })
}
