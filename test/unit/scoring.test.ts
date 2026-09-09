import { describe, expect, it } from 'vitest'
import {
  SCORE_COMPONENTS,
  SCORE_VERSION_V1,
  assertSumsTo100,
  bandFor,
  sumWeights,
} from '../../src/intel/scoring/score-version.js'
import { reconstructTotal, scoreCompany, type ScoreInput } from '../../src/intel/scoring/score.js'
import { matchTracks } from '../../src/intel/taxonomy/matcher.js'
import { resolveCountries } from '../../src/intel/country/normalize.js'

const NOW = new Date('2026-09-09T00:00:00Z')

function input(overrides: Partial<ScoreInput> = {}): ScoreInput {
  return {
    now: NOW,
    match: matchTracks([{ field: 'company:one_liner', text: 'We build nothing in particular.' }]),
    matchSources: { seedIndexOnly: true, fromAts: false, fromCompanyPage: false },
    hiring: { openPostings: null, jobCountDelta: null, relevantOpenRoles: 0, ycIsHiring: null },
    applicationRoute: { hasBoardToken: false, hasRoleUrl: false, hasCareersUrl: false, boardDead: false },
    feasibility: { teamSize: null, internshipMentions: 0 },
    geography: { countries: resolveCountries([]), remoteEvidence: false },
    personalization: { specificSourceCount: 0, distinctSourceTypes: 0 },
    freshness: { newestEvidenceAgeDays: null, newestPostingAgeDays: null },
    risks: { allPostingsStale: false, lifecycleStatus: null },
    ...overrides,
  }
}

/** A company that should land in the queue band, for threshold tests. */
function strongInput(overrides: Partial<ScoreInput> = {}): ScoreInput {
  return input({
    match: matchTracks([
      { field: 'company:long_description', text: 'We ship SwiftUI on iOS with on-device Core ML inference.' },
      { field: 'posting:iOS Engineer Intern', text: 'Swift, UIKit and Xcode. Internship programme in Bengaluru.' },
    ]),
    matchSources: { seedIndexOnly: false, fromAts: true, fromCompanyPage: true },
    hiring: { openPostings: 12, jobCountDelta: 3, relevantOpenRoles: 2, ycIsHiring: true },
    applicationRoute: { hasBoardToken: true, hasRoleUrl: true, hasCareersUrl: true, boardDead: false },
    feasibility: { teamSize: 30, internshipMentions: 2 },
    geography: { countries: resolveCountries(['India']), remoteEvidence: true },
    personalization: { specificSourceCount: 4, distinctSourceTypes: 2 },
    freshness: { newestEvidenceAgeDays: 2, newestPostingAgeDays: 5 },
    risks: { allPostingsStale: false, lifecycleStatus: 'Active' },
    ...overrides,
  })
}

describe('A1: the scale exists', () => {
  it('sums to exactly 100', () => {
    expect(sumWeights(SCORE_VERSION_V1.weights)).toBe(100)
  })

  it('declares every component exactly once', () => {
    expect(Object.keys(SCORE_VERSION_V1.weights).sort()).toEqual([...SCORE_COMPONENTS].sort())
  })

  it('refuses a weight set that does not sum to 100', () => {
    expect(() =>
      assertSumsTo100({
        ...SCORE_VERSION_V1,
        label: 'broken-97',
        // handover.md §6's original list, which is exactly the defect A1 names.
        weights: {
          role_fit: 25, hiring_signal: 20, application_route: 15, internship_feasibility: 12,
          geography: 10, personalization: 10, freshness: 5,
        },
      }),
    ).toThrow(/sum to 97, not 100/)
  })

  it('refuses overlapping thresholds', () => {
    expect(() =>
      assertSumsTo100({ ...SCORE_VERSION_V1, label: 'bad-thresholds', thresholds: { queue: 55, research: 70 } }),
    ).toThrow(/thresholds overlap/)
  })

  it('keeps handover.md §6 thresholds against a real scale', () => {
    expect(SCORE_VERSION_V1.thresholds).toEqual({ queue: 70, research: 55 })
    expect(bandFor(70, SCORE_VERSION_V1.thresholds)).toBe('queue')
    expect(bandFor(69, SCORE_VERSION_V1.thresholds)).toBe('research')
    expect(bandFor(54, SCORE_VERSION_V1.thresholds)).toBe('reject')
  })

  it('A11: records the freeze gate in the version itself', () => {
    expect(SCORE_VERSION_V1.frozenUntilSends).toBe(100)
  })
})

describe('scoring is deterministic and bounded', () => {
  it('returns the same breakdown for the same input', () => {
    expect(scoreCompany(strongInput())).toEqual(scoreCompany(strongInput()))
  })

  it('never exceeds a component maximum', () => {
    const result = scoreCompany(strongInput())
    for (const c of result.components) {
      expect(c.points).toBeLessThanOrEqual(c.max)
      expect(c.points).toBeGreaterThanOrEqual(0)
    }
    expect(result.total).toBeLessThanOrEqual(100)
  })

  it('caps the risk deduction at the version maximum', () => {
    const result = scoreCompany(
      strongInput({
        applicationRoute: { hasBoardToken: true, hasRoleUrl: true, hasCareersUrl: true, boardDead: true },
        risks: { allPostingsStale: true, lifecycleStatus: 'Acquired' },
        geography: { countries: resolveCountries(['Remote']), remoteEvidence: false },
      }),
    )
    expect(result.riskDeduction).toBeLessThanOrEqual(SCORE_VERSION_V1.maxRiskDeduction)
  })

  it('keeps deductions out of the 100-point scale (A1)', () => {
    const clean = scoreCompany(strongInput())
    const risky = scoreCompany(strongInput({ risks: { allPostingsStale: true, lifecycleStatus: 'Active' } }))
    expect(risky.subtotal).toBe(clean.subtotal)
    expect(risky.total).toBe(clean.total - risky.riskDeduction)
  })

  it('explains every component in words, not just numbers', () => {
    for (const c of scoreCompany(strongInput()).components) {
      expect(c.reason.length).toBeGreaterThan(0)
    }
  })
})

describe('every score is replayable from stored components (F2 exit criterion)', () => {
  it('reconstructs the same total from score_components + ScoreVersion', () => {
    for (const built of [strongInput(), input(), strongInput({ feasibility: { teamSize: 900, internshipMentions: 0 } })]) {
      const scored = scoreCompany(built)
      // Round-trip through JSON, because that is how it reaches the database.
      const stored = JSON.parse(JSON.stringify({ components: scored.components, risks: scored.risks }))
      const replayed = reconstructTotal(stored, SCORE_VERSION_V1)
      expect(replayed.total).toBe(scored.total)
      expect(replayed.subtotal).toBe(scored.subtotal)
      expect(replayed.riskDeduction).toBe(scored.riskDeduction)
      expect(replayed.band).toBe(scored.band)
    }
  })

  it('refuses to replay a component the version does not declare', () => {
    expect(() =>
      reconstructTotal(
        { components: [{ key: 'contact_route' as never, points: 5, max: 15, reason: 'x' }], risks: [] },
        SCORE_VERSION_V1,
      ),
    ).toThrow(/not part of ScoreVersion/)
  })

  it('refuses to replay a component that exceeds its maximum', () => {
    expect(() =>
      reconstructTotal(
        { components: [{ key: 'freshness', points: 99, max: 5, reason: 'x' }], risks: [] },
        SCORE_VERSION_V1,
      ),
    ).toThrow(/against a maximum of 5/)
  })
})

describe('the reasons a score raises', () => {
  it('raises low_relevance below the reject threshold', () => {
    const result = scoreCompany(input())
    expect(result.band).toBe('reject')
    expect(result.reasonCodes).toContain('low_relevance')
  })

  it('raises outdated_role when every open posting is past the stale window', () => {
    const result = scoreCompany(strongInput({ risks: { allPostingsStale: true, lifecycleStatus: 'Active' } }))
    expect(result.reasonCodes).toContain('outdated_role')
    expect(result.risks.map((r) => r.key)).toContain('stale_postings')
  })

  it('raises weak_evidence when the track label rests only on the YC seed index (H7)', () => {
    const result = scoreCompany(
      strongInput({ matchSources: { seedIndexOnly: true, fromAts: false, fromCompanyPage: false } }),
    )
    expect(result.reasonCodes).toContain('weak_evidence')
  })

  it('raises weak_evidence when §8’s two-source bar is not met', () => {
    const result = scoreCompany(
      strongInput({ personalization: { specificSourceCount: 1, distinctSourceTypes: 1 } }),
    )
    expect(result.reasonCodes).toContain('weak_evidence')
  })

  it('raises nothing when the lead is strong', () => {
    expect(scoreCompany(strongInput()).reasonCodes).toEqual([])
  })
})

describe('component behaviour worth pinning', () => {
  it('gives India the full geography component (handover.md §1 priority)', () => {
    const india = scoreCompany(strongInput({ geography: { countries: resolveCountries(['India']), remoteEvidence: false } }))
    const other = scoreCompany(strongInput({ geography: { countries: resolveCountries(['Japan']), remoteEvidence: false } }))
    const g = (r: ReturnType<typeof scoreCompany>) => r.components.find((c) => c.key === 'geography')!.points
    expect(g(india)).toBe(SCORE_VERSION_V1.weights.geography)
    expect(g(other)).toBeLessThan(g(india))
  })

  it('lets remote evidence lift a non-India company, per §1’s remote-viable ordering', () => {
    const g = (remote: boolean) =>
      scoreCompany(strongInput({ geography: { countries: resolveCountries(['USA']), remoteEvidence: remote } }))
        .components.find((c) => c.key === 'geography')!.points
    expect(g(true)).toBeGreaterThan(g(false))
  })

  it('rewards a rising ATS job count over a falling one (B2)', () => {
    const h = (delta: number | null) =>
      scoreCompany(strongInput({ hiring: { openPostings: 12, jobCountDelta: delta, relevantOpenRoles: 0, ycIsHiring: true } }))
        .components.find((c) => c.key === 'hiring_signal')!.points
    expect(h(4)).toBeGreaterThan(h(null))
    expect(h(-4)).toBeLessThan(h(null))
  })

  it('gives a relevant open role the maximum hiring signal (§6)', () => {
    const result = scoreCompany(strongInput())
    expect(result.components.find((c) => c.key === 'hiring_signal')!.points).toBe(
      SCORE_VERSION_V1.weights.hiring_signal,
    )
  })

  it('scores an application route without contacts, which F4 has not built yet', () => {
    const route = (r: Partial<ScoreInput['applicationRoute']>) =>
      scoreCompany(
        strongInput({
          applicationRoute: { hasBoardToken: false, hasRoleUrl: false, hasCareersUrl: false, boardDead: false, ...r },
        }),
      ).components.find((c) => c.key === 'application_route')!.points
    expect(route({ hasBoardToken: true, hasRoleUrl: true })).toBe(SCORE_VERSION_V1.weights.application_route)
    expect(route({ hasCareersUrl: true })).toBeGreaterThan(0)
    expect(route({})).toBe(0)
  })

  it('a strong India lead with a live board reaches the queue band', () => {
    expect(scoreCompany(strongInput()).band).toBe('queue')
  })
})
