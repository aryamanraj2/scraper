import { describe, expect, it } from 'vitest'
import {
  OUTREACH_CASE_NUMBER,
  decideOutreachCase,
  type OutreachFacts,
} from '../../src/core/policy/outreach-case.js'

/**
 * Base facts deliberately have `hasVerifiedContact: false`, so cases 1-3 are tested
 * exactly as they were before F4 added case 4. A test whose baseline silently opened
 * the new case would stop proving anything about the old ones.
 */
const base: OutreachFacts = {
  hasRelevantPosting: false,
  hasClearApplicationRoute: false,
  applicationSubmitted: false,
  hasPublicRecruitingContact: true,
  speculativeEvidenceStrong: true,
  hasVerifiedContact: false,
  leadQualified: true,
}

/**
 * Part C names this "the single most important policy test in the suite": any path to
 * an outreach draft outside the permitted cases must be rejected with a reason code.
 *
 * F4 added a fourth case by operator decision, which narrows `outreach_not_permitted`
 * rather than removing it. Both halves are pinned below.
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

  it('REJECTS a posted-role lead with a clear route, no application AND no verified contact', () => {
    // Part G's proving test, as amended by the operator's fourth case: "posted-role
    // lead with no application -> outreach_not_permitted" still holds whenever the
    // contact is not verified. This is the path that turns an application-first funnel
    // back into a cold-email system, so it must fail closed.
    expect(
      decideOutreachCase({
        ...base,
        hasRelevantPosting: true,
        hasClearApplicationRoute: true,
        applicationSubmitted: false,
        hasVerifiedContact: false,
      }),
    ).toEqual({ permitted: false, reason: 'outreach_not_permitted' })
  })

  it('case 4 — an availability inquiry, once the contact is VERIFIED', () => {
    expect(
      decideOutreachCase({
        ...base,
        hasRelevantPosting: true,
        hasClearApplicationRoute: true,
        applicationSubmitted: false,
        hasVerifiedContact: true,
      }),
    ).toEqual({ permitted: true, outreachCase: 'intern_availability_inquiry' })
  })

  it('case 4 never outranks case 3 — an application still produces a follow-up', () => {
    // Order matters: a follow-up references a submitted application, which is the
    // strongest message available. Checking case 4 first would silently downgrade it.
    expect(
      decideOutreachCase({
        ...base,
        hasRelevantPosting: true,
        hasClearApplicationRoute: true,
        applicationSubmitted: true,
        hasVerifiedContact: true,
      }),
    ).toEqual({ permitted: true, outreachCase: 'post_application_followup' })
  })

  it('case 4 requires a QUALIFIED lead, not merely a verified contact', () => {
    expect(
      decideOutreachCase({
        ...base,
        hasRelevantPosting: true,
        hasClearApplicationRoute: true,
        hasVerifiedContact: true,
        leadQualified: false,
      }),
    ).toEqual({ permitted: false, reason: 'outreach_not_permitted' })
  })

  it('an UNVERIFIED contact opens no case at all', () => {
    // This is what makes CONTACT_ALLOW_PATTERN_INFERENCE safe to expose: a
    // pattern-constructed address can become a candidate row, never a send target.
    for (const facts of [
      { ...base, hasRelevantPosting: true, hasClearApplicationRoute: true, hasVerifiedContact: false },
      { ...base, speculativeEvidenceStrong: false, hasVerifiedContact: false },
    ]) {
      const decision = decideOutreachCase(facts)
      expect(decision.permitted).toBe(false)
    }
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

  it('maps the four cases onto the plan numbering, plus the operator amendment', () => {
    expect(OUTREACH_CASE_NUMBER).toEqual({
      speculative_no_posting: 1,
      application_route_unclear: 2,
      post_application_followup: 3,
      intern_availability_inquiry: 4,
    })
  })
})
