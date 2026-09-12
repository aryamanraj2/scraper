/**
 * A1 and A11: the score, versioned.
 *
 * ## A1 — the handover's scale did not exist
 *
 * `handover.md` §6 lists component maxima of 25+20+15+12+10+10+5 = **97**, then
 * applies "minus 10-40" against an undeclared maximum, and calibrates thresholds
 * (queue 70+, research 55-69, reject <55) against the result. The plan's fix is
 * exact: component maxima summing to exactly 100, penalties moved into a separate
 * `risk_deduction`, and `score_components` stored as JSON against a `ScoreVersion`
 * so a later threshold change is replayable against historical leads.
 *
 * `assertSumsTo100` is called at module load, so a weight set that does not sum to
 * 100 fails at import rather than at scoring time.
 *
 * ## The one component that is not the handover's
 *
 * §6's third component is "valid public HR/Talent/careers route", worth 15. That
 * cannot be scored in F2: `Contact` rows do not exist until F4, so the component
 * would be structurally zero for every company in the pilot — which both caps
 * every score at 85 and calibrates a FROZEN weight set (A11) against a component
 * that will later become non-zero, changing every historical score's meaning.
 *
 * It is replaced by **official application route exists** — an ATS board token or
 * an `Opportunity.roleUrl`. This was a decision taken with the operator, and it
 * follows Part C: the terminal action is an application, not an email, so the
 * route that matters at qualification time is the one you apply through. B5
 * independently found the `careers@`-first premise unverified. F4 may add a
 * contact-route component, and doing so requires a NEW ScoreVersion rather than an
 * edit to this one.
 *
 * ## A11 — the weights are frozen
 *
 * Seven components against ~25 sends/week and a sub-10% reply rate is 0-3 positive
 * events; fitting weights on that degrades the system. `frozenUntilSends` records
 * the gate (>=100 sends) in the row itself, so the constraint is data an operator
 * can see rather than a paragraph in a document.
 */

/** Component keys. Order is display order and is stable across versions. */
export const SCORE_COMPONENTS = [
  'role_fit',
  'hiring_signal',
  'application_route',
  'internship_feasibility',
  'geography',
  'personalization',
  'freshness',
] as const

export type ScoreComponentKey = (typeof SCORE_COMPONENTS)[number]

export type ScoreWeights = Record<ScoreComponentKey, number>

export type ScoreThresholds = {
  /** handover.md §6: queue at 70+. */
  queue: number
  /** 55-69 is "research-needed"; below 55 is rejected automatically. */
  research: number
}

export type ScoreVersionSpec = {
  label: string
  weights: ScoreWeights
  thresholds: ScoreThresholds
  /** §6's "minus 10-40", now a bounded deduction against a declared scale. */
  maxRiskDeduction: number
  /** A11: no weight moves until this many sends have happened. */
  frozenUntilSends: number
}

export function sumWeights(weights: ScoreWeights): number {
  return Object.values(weights).reduce((a, b) => a + b, 0)
}

export function assertSumsTo100(spec: ScoreVersionSpec): ScoreVersionSpec {
  const total = sumWeights(spec.weights)
  if (total !== 100) {
    throw new Error(
      `ScoreVersion "${spec.label}" weights sum to ${total}, not 100. A1 exists because ` +
        `handover.md §6's components summed to 97 and its thresholds were calibrated ` +
        `against a scale that did not exist.`,
    )
  }
  const missing = SCORE_COMPONENTS.filter((k) => !(k in spec.weights))
  if (missing.length > 0) {
    throw new Error(`ScoreVersion "${spec.label}" is missing components: ${missing.join(', ')}`)
  }
  if (spec.thresholds.research >= spec.thresholds.queue) {
    throw new Error(`ScoreVersion "${spec.label}" thresholds overlap: research must be below queue.`)
  }
  return spec
}

/**
 * The F2 weight set. Frozen (A11).
 *
 * Derived from §6's list with the 3-point shortfall distributed to the two
 * components the operator's actual constraint cares about most — role fit, which
 * is the whole point of the four tracks, and personalization, which F4's drafting
 * depends on and which §8 requires two specific sources for.
 */
export const SCORE_VERSION_V1: ScoreVersionSpec = assertSumsTo100({
  label: 'f2-v1',
  weights: {
    role_fit: 26,               // §6: 25, +1
    hiring_signal: 20,          // §6: 20
    application_route: 15,      // §6: 15, repurposed — see the header
    internship_feasibility: 12, // §6: 12
    geography: 11,              // §6: 10, +1
    personalization: 11,        // §6: 10, +1
    freshness: 5,               // §6: 5
  },
  thresholds: { queue: 70, research: 55 },
  maxRiskDeduction: 40,
  frozenUntilSends: 100,
})

/**
 * F5b. Identical weights, identical thresholds, identical risk ceiling — and a new
 * label, because the label is the only handle a stored score has on how it was
 * computed.
 *
 * ## Why a bump when no weight moved
 *
 * `f2-v1` scored every company from posting TITLES. F5a added
 * `Opportunity.description`; F5b feeds that body to the matcher as its own
 * weighted field, which changes three inputs to the same arithmetic:
 *
 *   - `role_fit` reads `match.matches[0].confidence`, and the confidence now has
 *     body evidence in it. Median top confidence over the companies holding
 *     bodies moves 0.55 -> 0.71.
 *   - `hiring_signal` reads `relevantOpenRoles`, which counts open postings whose
 *     own text matches the primary track. Postings carrying a track go from 453 to
 *     1,064 corpus-wide, so this count moves for most companies with a board.
 *   - `internship_feasibility` and `geography` read `countTerms` over the field
 *     text, which now includes bodies — an "internship" or "remote" stated in a
 *     job description was previously invisible.
 *
 * `scoreCompany` is still pure and still deterministic. But the same company, with
 * no new row fetched, now scores differently — and `AuditLog` records the version
 * label against every `score.computed`. Leaving the label at `f2-v1` would put two
 * different totals for the same company under the same version in the audit trail,
 * which reads as a scorer that is not deterministic, and would make A11's "review
 * the reason codes instead of tuning the weights" impossible to do honestly: an
 * operator comparing this week's reasons against last week's would be comparing
 * two different functions labelled as one.
 *
 * A1's replay is unaffected either way — `reconstructTotal` works off the stored
 * components — which is precisely why the bump is cheap. It costs one row.
 *
 * The weights are NOT being re-tuned. A11's freeze holds; `frozenUntilSends` is
 * carried over unchanged, and it is the input derivation that moved, not the
 * response to it.
 */
export const SCORE_VERSION_V2: ScoreVersionSpec = assertSumsTo100({
  label: 'f5b-v2',
  weights: { ...SCORE_VERSION_V1.weights },
  thresholds: { ...SCORE_VERSION_V1.thresholds },
  maxRiskDeduction: SCORE_VERSION_V1.maxRiskDeduction,
  frozenUntilSends: SCORE_VERSION_V1.frozenUntilSends,
})

/**
 * The version new scores are computed under.
 *
 * Every call site that means "the current weight set" reads this. `SCORE_VERSION_V1`
 * stays exported and stays frozen: it is what historical `f2-v1` leads and audit
 * rows are replayed against, and editing it would rewrite their meaning.
 */
export const ACTIVE_SCORE_VERSION: ScoreVersionSpec = SCORE_VERSION_V2

export type ScoreBand = 'queue' | 'research' | 'reject'

export function bandFor(total: number, thresholds: ScoreThresholds): ScoreBand {
  if (total >= thresholds.queue) return 'queue'
  if (total >= thresholds.research) return 'research'
  return 'reject'
}
