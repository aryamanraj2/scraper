import type { RoleTrackKey } from '../../../generated/prisma/enums.js'
import type { ReasonCodeValue } from '../../core/reason-codes/registry.js'
import type { MatchResult } from '../taxonomy/matcher.js'
import type { CountryResolution } from '../country/normalize.js'
import {
  SCORE_COMPONENTS,
  SCORE_VERSION_V1,
  bandFor,
  type ScoreBand,
  type ScoreComponentKey,
  type ScoreVersionSpec,
} from './score-version.js'

/**
 * The deterministic scorer.
 *
 * Pure: same input, same number, forever. That is not a style preference —
 * A11 freezes the weights so that reason codes can be reviewed qualitatively
 * instead, and A1 requires a stored score to be replayable against a later
 * threshold change. Neither works if scoring consults the clock, the network, or a
 * model. `now` is an input for exactly this reason.
 *
 * Every component returns its points AND the sentence that explains them. The F3
 * evidence viewer renders those sentences; a score whose reasons are unreadable is
 * useless to the human doing the accepting.
 */

export type ScoreInput = {
  now: Date

  /** Deterministic track match over the company's and postings' text. */
  match: MatchResult

  /**
   * Which precedence tier the matched text came from. H7 is the reason this
   * matters: yc-oss has no LICENSE and is a seed index only, so a track label
   * resting solely on the YC blurb is not corroborated by anything the employer
   * published themselves.
   */
  matchSources: {
    /** Matched text came only from yc-oss seed fields. */
    seedIndexOnly: boolean
    fromAts: boolean
    fromCompanyPage: boolean
  }

  hiring: {
    /** Latest observed open-posting count, or null if no board has ever been read. */
    openPostings: number | null
    /** B2's week-over-week delta, or null when there is only one observation. */
    jobCountDelta: number | null
    /** Open postings whose text matches the primary track. */
    relevantOpenRoles: number
    /** yc-oss `isHiring`. A seed-index claim (H7), so it counts for little alone. */
    ycIsHiring: boolean | null
  }

  applicationRoute: {
    /** A detected ATS board token — the strongest application route we can see. */
    hasBoardToken: boolean
    /** At least one Opportunity carries an official application URL. */
    hasRoleUrl: boolean
    /** A careers page was found, but no machine-readable board behind it. */
    hasCareersUrl: boolean
    /** The board was detected and the vendor then 404'd it (F1 §8.3). */
    boardDead: boolean
  }

  feasibility: {
    teamSize: number | null
    /** Postings or pages that mention an internship / new-grad programme. */
    internshipMentions: number
  }

  geography: {
    countries: CountryResolution
    /** A posting or page states remote or distributed working. */
    remoteEvidence: boolean
  }

  personalization: {
    /**
     * §8: "at least two specific, recent, non-marketing sources". Counted as
     * distinct Evidence rows from employer-published sources within the window.
     */
    specificSourceCount: number
    /** Distinct Evidence.sourceType values behind those rows. */
    distinctSourceTypes: number
  }

  freshness: {
    /** Age of the newest Evidence row, in days. Null when there is none. */
    newestEvidenceAgeDays: number | null
    /** Age of the most recently seen open posting, in days. */
    newestPostingAgeDays: number | null
  }

  risks: {
    /** Every open posting is past the freshness window. */
    allPostingsStale: boolean
    /** yc-oss lifecycle string, retained raw by F1 (§4.3). */
    lifecycleStatus: string | null
  }
}

export type ScoredComponent = {
  key: ScoreComponentKey
  points: number
  max: number
  /** Why these points. Rendered to the operator; never a bare number. */
  reason: string
}

export type RiskDeduction = {
  /** Stable key, so a deduction is greppable across versions. */
  key: string
  points: number
  reason: string
}

/**
 * Exactly what is persisted to `Lead.scoreComponents`. Deliberately self-contained:
 * A1's replay requirement means this JSON plus the `ScoreVersion` row must be
 * enough to recompute the total without re-reading a single Evidence row.
 */
export type ScoreBreakdown = {
  scoreVersion: string
  components: ScoredComponent[]
  /** Sum of component points, before deductions. */
  subtotal: number
  risks: RiskDeduction[]
  /** Sum of deductions, capped at the version's maxRiskDeduction. */
  riskDeduction: number
  /** subtotal - riskDeduction, clamped to 0..100. */
  total: number
  band: ScoreBand
  primaryTrack: RoleTrackKey | null
  primaryTrackReason: string
  /** Reason codes this score raises. Empty for a clean queue-band score. */
  reasonCodes: ReasonCodeValue[]
  /** Country mapping applied, per F1 §4.12's requirement to record it. */
  countryMapVersion: string
}

/** The freshness window a posting stays "current" within. */
export const POSTING_FRESH_DAYS = 45
/** Beyond this a posting is treated as outdated regardless of the board. */
export const POSTING_STALE_DAYS = 90
/** Evidence older than this stops counting as "recent" for personalization. */
export const EVIDENCE_FRESH_DAYS = 60

/**
 * Minimum evidence to score at all. Below it the answer is `insufficient_evidence`
 * — a budget decision and re-entrant (D1), not a verdict on the company.
 */
export const MIN_SOURCES_TO_SCORE = 1

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Rounds to an integer, because a stored score is an Int column. */
function points(value: number, max: number): number {
  return clamp(Math.round(value), 0, max)
}

export function scoreCompany(input: ScoreInput, spec: ScoreVersionSpec = SCORE_VERSION_V1): ScoreBreakdown {
  const w = spec.weights
  const reasonCodes = new Set<ReasonCodeValue>()
  const components: ScoredComponent[] = []
  const risks: RiskDeduction[] = []

  // --- role fit ------------------------------------------------------------
  // Confidence carries the component directly: it is already a saturating
  // function of distinct specific terms, which is the same thing §6 means by
  // "role/technology fit, with direct cited evidence".
  const primary = input.match.primary
  const best = input.match.matches[0]
  const roleFit = best ? w.role_fit * best.confidence : 0
  components.push({
    key: 'role_fit',
    points: points(roleFit, w.role_fit),
    max: w.role_fit,
    reason: best
      ? `${best.track} at confidence ${best.confidence} from ${best.specificTerms.length} specific term(s): ${best.specificTerms.slice(0, 6).join(', ')}`
      : 'no track label: no specific vocabulary matched any source text',
  })

  // H7: a label supported only by the YC blurb has no employer-published
  // corroboration behind it. It still scores — it is real text — but it cannot
  // support a personalized claim, which is what weak_evidence means.
  if (best && input.matchSources.seedIndexOnly) {
    reasonCodes.add('weak_evidence')
  }

  // --- hiring signal (B2) --------------------------------------------------
  // B2 replaced the excluded X API with ATS job-count deltas, so a rising count is
  // worth more than a static one: "this startup is adding engineers" is the fact
  // we actually want. A relevant open role is §6's "active relevant role gets
  // maximum points".
  let hiring = 0
  const hiringWhy: string[] = []
  if (input.hiring.relevantOpenRoles > 0) {
    hiring = w.hiring_signal
    hiringWhy.push(`${input.hiring.relevantOpenRoles} open role(s) matching the primary track`)
  } else if ((input.hiring.openPostings ?? 0) > 0) {
    hiring = w.hiring_signal * 0.6
    hiringWhy.push(`${input.hiring.openPostings} open posting(s), none matching the primary track`)
  } else if (input.hiring.ycIsHiring === true) {
    // A seed-index claim with no board behind it (H7). Worth something, not much.
    hiring = w.hiring_signal * 0.2
    hiringWhy.push('yc-oss reports the company as hiring; no board observed')
  } else {
    hiringWhy.push('no open postings observed')
  }
  const delta = input.hiring.jobCountDelta
  if (delta !== null && delta > 0) {
    hiring = Math.min(w.hiring_signal, hiring + w.hiring_signal * 0.2)
    hiringWhy.push(`ATS job count up ${delta} since the previous observation`)
  } else if (delta !== null && delta < 0) {
    hiring = Math.max(0, hiring - w.hiring_signal * 0.2)
    hiringWhy.push(`ATS job count down ${Math.abs(delta)} since the previous observation`)
  } else if (delta === null) {
    hiringWhy.push('no delta: fewer than two board observations')
  }
  components.push({
    key: 'hiring_signal',
    points: points(hiring, w.hiring_signal),
    max: w.hiring_signal,
    reason: hiringWhy.join('; '),
  })

  // --- application route (Part C) -----------------------------------------
  let route = 0
  let routeWhy: string
  if (input.applicationRoute.hasBoardToken && input.applicationRoute.hasRoleUrl) {
    route = w.application_route
    routeWhy = 'ATS board detected and at least one official application URL stored'
  } else if (input.applicationRoute.hasBoardToken) {
    route = w.application_route * 0.7
    routeWhy = 'ATS board detected; no open posting to apply to yet'
  } else if (input.applicationRoute.hasRoleUrl) {
    route = w.application_route * 0.7
    routeWhy = 'official application URL stored without a detected board'
  } else if (input.applicationRoute.hasCareersUrl) {
    route = w.application_route * 0.3
    routeWhy = 'careers page found, but no machine-readable board behind it'
  } else {
    routeWhy = 'no application route observed'
  }
  components.push({
    key: 'application_route',
    points: points(route, w.application_route),
    max: w.application_route,
    reason: routeWhy,
  })

  // --- internship feasibility ---------------------------------------------
  // §6: "small/medium growth-stage company, team fit, or prior early-career
  // evidence". Team size is the only structural proxy we hold at F2; an explicit
  // internship mention is direct evidence and outranks it.
  let feasibility = 0
  const feasWhy: string[] = []
  const size = input.feasibility.teamSize
  if (size !== null && size > 0) {
    if (size <= 50) {
      feasibility += w.internship_feasibility * 0.6
      feasWhy.push(`team of ${size}: growth-stage, where an intern is visible`)
    } else if (size <= 250) {
      feasibility += w.internship_feasibility * 0.4
      feasWhy.push(`team of ${size}: mid-size`)
    } else {
      feasibility += w.internship_feasibility * 0.15
      feasWhy.push(`team of ${size}: large, more process between an application and a person`)
    }
  } else {
    feasWhy.push('team size unknown')
  }
  if (input.feasibility.internshipMentions > 0) {
    feasibility += w.internship_feasibility * 0.4
    feasWhy.push(`${input.feasibility.internshipMentions} internship/new-grad mention(s) in source text`)
  }
  components.push({
    key: 'internship_feasibility',
    points: points(feasibility, w.internship_feasibility),
    max: w.internship_feasibility,
    reason: feasWhy.join('; '),
  })

  // --- geography (handover.md §1: India first, then remote-viable US/UK/EU) --
  const region = input.geography.countries.bestRegion
  const regionShare: Record<typeof region, number> = {
    india: 1, us: 0.7, uk: 0.7, eu: 0.7, other: 0.3,
  }
  let geo = w.geography * regionShare[region]
  const geoWhy = [
    region === 'other' && input.geography.countries.codes.length === 0
      ? 'no country resolved from the source strings'
      : `region ${region} from ${input.geography.countries.codes.join(', ') || 'no mapped code'}`,
  ]
  if (region !== 'india' && input.geography.remoteEvidence) {
    geo = Math.min(w.geography, geo + w.geography * 0.3)
    geoWhy.push('remote or distributed working stated in source text')
  } else if (region !== 'india' && !input.geography.remoteEvidence) {
    geoWhy.push('no remote-working evidence')
  }
  components.push({
    key: 'geography',
    points: points(geo, w.geography),
    max: w.geography,
    reason: geoWhy.join('; '),
  })

  // --- personalization -----------------------------------------------------
  // §8: "at least two specific, recent, non-marketing sources" for the opener.
  // Two is the bar, so two sources earn most of the component and further sources
  // add less; a single source cannot reach half.
  const srcs = input.personalization.specificSourceCount
  const personalization =
    srcs >= 2
      ? w.personalization * Math.min(1, 0.7 + 0.15 * (srcs - 2)) *
        (input.personalization.distinctSourceTypes >= 2 ? 1 : 0.85)
      : w.personalization * 0.3 * srcs
  components.push({
    key: 'personalization',
    points: points(personalization, w.personalization),
    max: w.personalization,
    reason:
      `${srcs} employer-published source(s) within ${EVIDENCE_FRESH_DAYS} days across ` +
      `${input.personalization.distinctSourceTypes} source type(s)` +
      (srcs < 2 ? '; §8 requires two for a personalized opener' : ''),
  })
  if (srcs < 2) reasonCodes.add('weak_evidence')

  // --- freshness -----------------------------------------------------------
  const age = input.freshness.newestEvidenceAgeDays
  const freshness =
    age === null ? 0 : age <= 7 ? w.freshness : age <= 30 ? w.freshness * 0.6 : age <= 90 ? w.freshness * 0.3 : 0
  components.push({
    key: 'freshness',
    points: points(freshness, w.freshness),
    max: w.freshness,
    reason: age === null ? 'no evidence recorded' : `newest evidence is ${age} day(s) old`,
  })

  // --- risk deductions (A1: separate from the 100) -------------------------
  // No `openPostings` guard here: that field is the latest BOARD COUNT, which is
  // null for a company whose board has never been read, while `allPostingsStale`
  // is computed from the Opportunity rows themselves and is already false when
  // there are none. Gating on the count made a stale posting invisible whenever
  // the count was missing — which is exactly the company most likely to have one.
  if (input.risks.allPostingsStale) {
    risks.push({
      key: 'stale_postings',
      points: 15,
      reason: `every open posting was last seen more than ${POSTING_STALE_DAYS} days ago`,
    })
    reasonCodes.add('outdated_role')
  }
  if (input.applicationRoute.boardDead) {
    risks.push({
      key: 'dead_board',
      points: 10,
      reason: 'the employer links an ATS board the vendor no longer serves',
    })
  }
  const lifecycle = input.risks.lifecycleStatus?.toLowerCase() ?? null
  if (lifecycle === 'inactive' || lifecycle === 'acquired') {
    risks.push({
      key: 'lifecycle',
      points: 25,
      reason: `yc-oss lifecycle status is "${input.risks.lifecycleStatus}"`,
    })
  }
  if (input.geography.countries.unmapped.length > 0 && input.geography.countries.codes.length === 0) {
    risks.push({
      key: 'unmapped_geography',
      points: 5,
      reason: `no country resolved from ${input.geography.countries.unmapped.length} source string(s): ${input.geography.countries.unmapped.slice(0, 3).join(', ')}`,
    })
  }

  const subtotal = components.reduce((a, c) => a + c.points, 0)
  const riskDeduction = Math.min(spec.maxRiskDeduction, risks.reduce((a, r) => a + r.points, 0))
  const total = clamp(subtotal - riskDeduction, 0, 100)
  const band = bandFor(total, spec.thresholds)

  if (band === 'reject') reasonCodes.add('low_relevance')

  return {
    scoreVersion: spec.label,
    components,
    subtotal,
    risks,
    riskDeduction,
    total,
    band,
    primaryTrack: primary?.track ?? null,
    primaryTrackReason: primary?.reason ?? 'no track cleared the confidence floor with a specific term',
    reasonCodes: [...reasonCodes].sort(),
    countryMapVersion: input.geography.countries.mapVersion,
  }
}

/**
 * A1's replay requirement, as executable code: recompute the total from what was
 * stored, without the inputs.
 *
 * This is what makes "every score explainable from stored components" true rather
 * than aspirational — and it is what lets a future ScoreVersion's thresholds be
 * applied to historical leads without re-researching a single company.
 */
export function reconstructTotal(
  stored: Pick<ScoreBreakdown, 'components' | 'risks'>,
  spec: ScoreVersionSpec,
): { subtotal: number; riskDeduction: number; total: number; band: ScoreBand } {
  const known = new Set<string>(SCORE_COMPONENTS)
  for (const component of stored.components) {
    if (!known.has(component.key)) {
      throw new Error(`Stored component "${component.key}" is not part of ScoreVersion ${spec.label}.`)
    }
    const max = spec.weights[component.key]
    if (component.points > max) {
      throw new Error(
        `Stored component "${component.key}" holds ${component.points} points against a maximum of ${max} in ${spec.label}.`,
      )
    }
  }
  const subtotal = stored.components.reduce((a, c) => a + c.points, 0)
  const riskDeduction = Math.min(spec.maxRiskDeduction, stored.risks.reduce((a, r) => a + r.points, 0))
  const total = clamp(subtotal - riskDeduction, 0, 100)
  return { subtotal, riskDeduction, total, band: bandFor(total, spec.thresholds) }
}
