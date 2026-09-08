/**
 * Shared across the three required ATS adapters (Part E: Greenhouse, Lever,
 * Ashby). Kept in its own module so no adapter imports another — they are
 * siblings, and a shared constant living inside one of them makes the other two
 * look like they depend on it.
 */

/**
 * ATS boards inline full job descriptions, so a large board runs to megabytes —
 * well past the research-page default. Raised deliberately here rather than
 * globally: the low default is what keeps an unexpected multi-megabyte response
 * from a research page a refusal instead of a memory spike.
 */
export const ATS_FEED_MAX_BYTES = 16 * 1024 * 1024

/**
 * Greenhouse and Ashby publish ISO-8601 timestamps; Lever publishes epoch
 * milliseconds and parses its own way. An unparseable date is `null`, never
 * `Invalid Date` — a NaN date written to `Opportunity.postedAt` would silently
 * defeat A8's freshness window.
 */
export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export function parseEpochMs(value: number): Date | null {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}
