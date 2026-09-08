import { describe, expect, it } from 'vitest'
import {
  OUTREACH_CASE_NUMBER,
  decideOutreachCase,
  type OutreachFacts,
} from '../../src/core/policy/outreach-case.js'

const base: OutreachFacts = {
  hasRelevantPosting: false,
  hasClearApplicationRoute: false,
  applicationSubmitted: false,
  hasPublicRecruitingContact: true,
  speculativeEvidenceStrong: true,
}

/**
 * Part C names this "the single most important policy test in the suite": any path
 * to an outreach draft outside the three permitted cases must be rejected with a
 * reason code.
 */
describe('outreach-case predicate (Part C)', () => {
  it('case 1 — strong speculative lead with no relevant posting', () => {
    expect(decideOutreachCase(base)).toEqual({
      permitted: true,
      outreachCase: 'speculative_no_posting',
    })
  })

  it('case 2 — posting exists but the application route is unclear', () => {
    expect(
      decideOutreachCase({ ...base, hasRelevantPosting: true, hasClearApplicationRoute: false }),
    ).toEqual({ permitted: true, outreachCase: 'application_route_unclear' })
  })

  it('case 3 — follow-up after applying, with a public recruiting contact', () => {
    expect(
      decideOutreachCase({
        ...base,
        hasRelevantPosting: true,
        hasClearApplicationRoute: true,
        applicationSubmitted: true,
      }),
    ).toEqual({ permitted: true, outreachCase: 'post_application_followup' })
  })

  it('REJECTS a posted-role lead with a clear route and no application submitted', () => {
    // Part G's proving test: "Posted-role lead with no application -> outreach_not_permitted".
    // This is the exact path that turns an application-first funnel back into a
    // cold-email system, so it must fail closed.
    expect(
      decideOutreachCase({
        ...base,
        hasRelevantPosting: true,
        hasClearApplicationRoute: true,
        applicationSubmitted: false,
      }),
    ).toEqual({ permitted: false, reason: 'outreach_not_permitted' })
  })

  it('rejects every case when no public recruiting route exists', () => {
    for (const facts of [
      { ...base, hasPublicRecruitingContact: false },
      { ...base, hasPublicRecruitingContact: false, applicationSubmitted: true },
      { ...base, hasPublicRecruitingContact: false, hasRelevantPosting: true },
    ]) {
      expect(decideOutreachCase(facts)).toEqual({
        permitted: false,
        reason: 'no_public_recruiting_route',
      })
    }
  })

  it('rejects a speculative lead whose evidence did not clear the bar', () => {
    expect(decideOutreachCase({ ...base, speculativeEvidenceStrong: false })).toEqual({
      permitted: false,
      reason: 'weak_evidence',
    })
  })

  it('maps the three cases onto the plan numbering', () => {
    expect(OUTREACH_CASE_NUMBER).toEqual({
      speculative_no_posting: 1,
      application_route_unclear: 2,
      post_application_followup: 3,
    })
  })
})
