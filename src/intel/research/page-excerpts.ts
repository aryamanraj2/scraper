import { MAX_EXCERPT_CHARS, verbatimExcerpt } from '../../core/evidence/write-evidence.js'
import { matchTracks, type MatchResult } from '../taxonomy/matcher.js'
import { FIELD_PREFIX } from '../scoring/collect.js'

/**
 * Which verbatim windows of a fetched page become `Evidence` rows.
 *
 * ## The problem this exists to solve
 *
 * `Evidence.excerpt` is `VARCHAR(500)` and verbatim, and a careers page is
 * routinely 5,000. Storing the first 500 characters is honest provenance but bad
 * evidence: the opening of an employer page is a hero headline, and the sentence
 * that actually says "Swift, Kotlin, and a mobile team in Bengaluru" is four
 * screens down. Scored from the prefix alone, a genuinely mobile-first company
 * looks like a company with no engineering evidence at all — which is what the
 * first live F2 run showed: 34 pages stored, two extra companies scoreable.
 *
 * ## The fix, following the precedent F1 already set
 *
 * F1 §4.4 hit the same wall with the yc-oss record and resolved it by writing one
 * `Evidence` row **per source key** rather than one per company, because a single
 * 500-char row cannot honestly justify thirteen fields. The same reasoning applies
 * here: one row per **matched track**, each quoting the window of the page where
 * that track's vocabulary actually appears, plus one row for the head of the page
 * so a page that matched nothing still has provenance.
 *
 * Each window is a contiguous verbatim slice of the extracted text. Nothing is
 * reordered, nothing is joined, nothing is appended — a window is the source's own
 * words in the source's own order, which is what makes `handover.md` §11's
 * reconstruction criterion true.
 *
 * The result is that a track label is always backed by an excerpt a human can read
 * and check, which is exactly what §5.3 asks for: "records matched snippets and
 * confidence; it cannot use a label unsupported by text."
 */

export type PageExcerpt = {
  /** Stable key for the row: 'head', or the track whose window this is. */
  key: string
  /** A contiguous verbatim slice of the extracted page text. */
  text: string
}

/**
 * A window of `limit` characters containing `index`, snapped outward to whitespace
 * so it does not start or end mid-word.
 *
 * Snapping only ever moves the boundary; it never inserts a character. A window
 * that begins mid-sentence is still exactly what the page said.
 */
function windowAround(text: string, index: number, limit = MAX_EXCERPT_CHARS): string {
  if (text.length <= limit) return text

  // A little context before the match, most of the budget after it: the sentence
  // that names a technology is usually followed by the detail worth reading.
  const start = Math.max(0, index - Math.floor(limit * 0.25))
  const end = Math.min(text.length, start + limit)
  let slice = text.slice(start, end)

  if (start > 0) {
    const firstSpace = slice.indexOf(' ')
    if (firstSpace > 0 && firstSpace < 40) slice = slice.slice(firstSpace + 1)
  }
  if (end < text.length) {
    const lastSpace = slice.lastIndexOf(' ')
    if (lastSpace > slice.length - 40) slice = slice.slice(0, lastSpace)
  }
  return slice.trim()
}

/**
 * The excerpts to store for one page.
 *
 * Always at least one row (the head), plus one per matched track, deduplicated by
 * text so a page whose whole content fits in 500 characters produces one row rather
 * than five copies of itself.
 */
export function pageExcerpts(text: string, url: string): { excerpts: PageExcerpt[]; match: MatchResult } {
  const match = matchTracks([{ field: `${FIELD_PREFIX.page}${url}`, text }])
  const excerpts: PageExcerpt[] = [{ key: 'head', text: verbatimExcerpt(text) }]
  const seen = new Set([excerpts[0]!.text])

  for (const track of match.matches) {
    // The first SPECIFIC term is the anchor: a generic term like "platform" says
    // nothing about where the real evidence is on the page.
    const firstSpecific = track.snippets.find((s) => !s.generic) ?? track.snippets[0]
    if (!firstSpecific) continue
    // Anchor on the TERM, not on the snippet. A snippet carries context either
    // side, so its own prefix is ordinary prose that may well occur earlier on the
    // page — anchoring on it lands the window nowhere near the match.
    const index = text.toLowerCase().indexOf(firstSpecific.term.toLowerCase())
    const window = windowAround(text, index >= 0 ? index : 0)
    if (window === '' || seen.has(window)) continue
    seen.add(window)
    excerpts.push({ key: track.track, text: window })
  }

  return { excerpts, match }
}
