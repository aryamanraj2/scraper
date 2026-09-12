import type { RoleTrackKey } from '../../../generated/prisma/enums.js'
import { GENERIC_TERMS, ROLE_TRACKS, type TrackVocabulary } from './role-tracks.js'

/**
 * The deterministic track matcher (`handover.md` §5.3, "Tech Matcher").
 *
 * Deterministic on purpose, and first rather than last: the plan's H10 requires
 * the pipeline to work with the LLM switched off, and F0's deviation §4.9 made the
 * LLM an operator session that runs on human time. A classifier that needs a model
 * to produce any answer at all would stall the whole funnel behind that session.
 * The `HandoffLlmGateway` path exists to REFINE a match, never to produce the
 * first one.
 *
 * ## The invariant
 *
 * A label is only ever applied where matched text supports it, and the matched
 * text travels with the label. `handover.md` §5.3: the matcher "records matched
 * snippets and confidence; it cannot use a label unsupported by text." So
 * `TrackMatch.snippets` is not diagnostics — it is the evidence for the claim, and
 * the F3 evidence viewer renders it.
 */

/** One occurrence of a vocabulary phrase, with enough context to be readable. */
export type MatchedSnippet = {
  /** The vocabulary phrase that matched. */
  term: string
  /** Verbatim window from the source text around the match. Never reworded. */
  snippet: string
  /** Which piece of source text this came from, e.g. 'posting:Senior iOS Engineer'. */
  field: string
  /** Generic terms are real matches that prove little on their own. */
  generic: boolean
}

export type TrackMatch = {
  track: RoleTrackKey
  /** 0..1. Derived from distinct specific terms; see `confidenceFrom`. */
  confidence: number
  /** Evidence for the label. Empty means no label. */
  snippets: MatchedSnippet[]
  /** Distinct non-generic phrases matched. The number that actually drives confidence. */
  specificTerms: string[]
  /** Distinct negative phrases matched — counter-evidence, recorded, not vetoing. */
  negativeTerms: string[]
}

export type TextField = {
  field: string
  text: string
  /**
   * How much one distinct phrase found in this field is worth, relative to a
   * phrase found in a posting title. Defaults to 1 — every field written before
   * F5b was a title, a tag list or a ~500-character page excerpt, and all of them
   * keep the weight the confidence curve was tuned against.
   *
   * It exists because `confidenceFrom` counts DISTINCT phrases, and that count is
   * only a fair measure of evidence when the fields being counted over are of
   * comparable length and comparable density. A 6,000-character job description
   * is neither: it will contain a track's whole vocabulary by accident of having
   * a "COMPANY OVERVIEW" and a "BENEFITS" section, and counting each of those
   * phrases as equal to the word "iOS" in a title would saturate every track at
   * once and label with high confidence from nothing. So a long, low-density
   * field declares itself as one, and its phrases are summed at that weight
   * instead of counted at 1.
   */
  weight?: number
}

/** Characters around a match kept in the snippet, each side. */
const SNIPPET_CONTEXT = 60

/**
 * Confidence is a function of how many DISTINCT specific phrases matched, not how
 * often any of them appeared. A careers page repeating "Swift" nine times is one
 * fact stated loudly; "Swift", "SwiftUI" and "Xcode" together are three facts.
 * Repetition is exactly what marketing copy does, so counting it would reward the
 * pages §6 warns about.
 *
 * Generic terms contribute a fraction of a specific term, and cannot on their own
 * reach the label floor: three generic hits still land below `MIN_CONFIDENCE`.
 *
 * The three arguments are named `…Count` because for a field set of titles, tags
 * and page excerpts they are exactly that. Since F5b they are sums of per-field
 * `TextField.weight` over the distinct phrases matched, which is the same number
 * whenever every field is at the default weight of 1, and is fractional when a
 * long low-density field (a job description body) is in the set. The curve itself
 * is unchanged: it was tuned against short titles and it is still being fed the
 * title's full contribution.
 */
export const MIN_CONFIDENCE = 0.3
const GENERIC_WEIGHT = 0.25

export function confidenceFrom(specificCount: number, genericCount: number, negativeCount: number): number {
  const positive = specificCount + genericCount * GENERIC_WEIGHT
  // Saturating rather than linear: the difference between one specific term and
  // three is large; between eight and ten it is noise.
  const raw = 1 - Math.exp(-positive / 2.5)
  // Counter-evidence damps, never vetoes: §6 treats negatives as "low-value
  // signals", and a company can genuinely be both a backend shop and hiring an
  // account manager.
  const damped = raw * Math.exp(-negativeCount / 4)
  return Math.round(Math.min(1, Math.max(0, damped)) * 100) / 100
}

/**
 * Word-boundary match, case-insensitive, on a phrase that may contain regex
 * metacharacters ("next.js", "ci/cd", "c++"). Built per call rather than cached in
 * a module-level map because the vocabulary is small and a stale cache here would
 * be a silent misclassification.
 */
function findOccurrences(haystack: string, phrase: string): number[] {
  const trimmed = phrase.trim()
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // \b does not work before or after a non-word character, so the boundary is only
  // asserted on the side that starts/ends with a word character. Both sides are
  // computed from the TRIMMED phrase: computing them from the raw phrase while
  // matching the trimmed one drops the boundary silently, which is how "go " ends
  // up matching "going".
  const left = /^\w/.test(trimmed) ? '\\b' : ''
  const right = /\w$/.test(trimmed) ? '\\b' : ''
  const re = new RegExp(`${left}${escaped}${right}`, 'gi')
  const out: number[] = []
  for (const m of haystack.matchAll(re)) {
    if (m.index !== undefined) out.push(m.index)
  }
  return out
}

function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - SNIPPET_CONTEXT)
  const end = Math.min(text.length, index + length + SNIPPET_CONTEXT)
  // Whitespace is collapsed because HTML-extracted text carries newlines and runs
  // of spaces that make a snippet unreadable. The WORDS are untouched.
  return text.slice(start, end).replace(/\s+/g, ' ').trim()
}

/**
 * A phrase is counted once, at the weight of the BEST field it was found in.
 *
 * Best rather than summed, because the unit of evidence is still the distinct
 * phrase — "Swift" in a title and "Swift" again in that posting's body is one
 * fact, restated. Summing would reward exactly the repetition `confidenceFrom`
 * exists to ignore, and would also make a phrase's value depend on how many
 * postings a company happens to have open.
 */
function creditTerm(into: Map<string, number>, term: string, weight: number): void {
  if (weight > (into.get(term) ?? 0)) into.set(term, weight)
}

function totalWeight(terms: ReadonlyMap<string, number>): number {
  let sum = 0
  for (const weight of terms.values()) sum += weight
  return sum
}

function matchTrack(vocab: TrackVocabulary, fields: readonly TextField[]): TrackMatch {
  const snippets: MatchedSnippet[] = []
  const specific = new Map<string, number>()
  const generic = new Map<string, number>()
  const negatives = new Map<string, number>()

  for (const { field, text, weight = 1 } of fields) {
    if (!text) continue
    for (const term of vocab.positive) {
      const hits = findOccurrences(text, term)
      if (hits.length === 0) continue
      const isGeneric = GENERIC_TERMS.has(term)
      creditTerm(isGeneric ? generic : specific, term, weight)
      // One snippet per term per field: the point is to show the reader the claim
      // is supported, not to dump every occurrence.
      snippets.push({
        term,
        snippet: snippetAround(text, hits[0]!, term.length),
        field,
        generic: isGeneric,
      })
    }
    for (const term of vocab.negative) {
      // Counter-evidence is weighted the same way. A body that mentions an
      // account manager is weaker counter-evidence than a title that IS one, for
      // the same reason the positive side is weighted: it may be a sentence about
      // a different team in a shared boilerplate section.
      if (findOccurrences(text, term).length > 0) creditTerm(negatives, term, weight)
    }
  }

  return {
    track: vocab.key,
    confidence: confidenceFrom(totalWeight(specific), totalWeight(generic), totalWeight(negatives)),
    snippets,
    specificTerms: [...specific.keys()].sort(),
    negativeTerms: [...negatives.keys()].sort(),
  }
}

export type MatchResult = {
  /** Tracks that cleared the floor AND have at least one specific term. */
  matches: TrackMatch[]
  /** Every track's raw computation, including the ones that did not qualify. */
  considered: TrackMatch[]
  /** The one track a Lead would carry, and the recorded reason (A12). */
  primary: { track: RoleTrackKey; reason: string } | null
}

/**
 * Classifies a company or posting from text alone.
 *
 * Two independent conditions gate a label, and the second is the one that answers
 * §6's "a YC company with 'AI' in its name is not automatically an AI Engineer
 * target": confidence must clear the floor, AND at least one matched phrase must
 * be specific rather than generic. A company called "Foo AI" whose entire corpus
 * says "AI" matches only a generic term, so it gets no label — not a weak one.
 */
export function matchTracks(fields: readonly TextField[]): MatchResult {
  const considered = ROLE_TRACKS.map((vocab) => matchTrack(vocab, fields))
  const matches = considered
    .filter((m) => m.specificTerms.length > 0 && m.confidence >= MIN_CONFIDENCE)
    .sort((a, b) => b.confidence - a.confidence || a.track.localeCompare(b.track))

  return { matches, considered, primary: choosePrimary(matches) }
}

/**
 * A12: "primary-track tie-break unspecified" is listed as a remaining gap in the
 * plan, and `Lead.primaryTrackReason` exists because the choice must be recorded
 * rather than implicit.
 *
 * Highest confidence wins. A tie is broken by the number of distinct specific
 * terms, then by the declared track order in `ROLE_TRACKS` — which is stable, so
 * two runs over the same text always agree. Determinism matters more than which
 * track wins a tie: A11 requires scores to be replayable.
 */
function choosePrimary(matches: readonly TrackMatch[]): { track: RoleTrackKey; reason: string } | null {
  if (matches.length === 0) return null
  const [best, second] = matches
  if (!second || best!.confidence > second.confidence) {
    return {
      track: best!.track,
      reason: `highest confidence ${best!.confidence} on ${best!.specificTerms.length} specific term(s): ${best!.specificTerms.join(', ')}`,
    }
  }
  const tied = matches.filter((m) => m.confidence === best!.confidence)
  const winner = [...tied].sort(
    (a, b) =>
      b.specificTerms.length - a.specificTerms.length ||
      ROLE_TRACKS.findIndex((t) => t.key === a.track) - ROLE_TRACKS.findIndex((t) => t.key === b.track),
  )[0]!
  return {
    track: winner.track,
    reason: `tie at confidence ${best!.confidence} between ${tied.map((t) => t.track).join(', ')}; broke on specific-term count then declared track order`,
  }
}
