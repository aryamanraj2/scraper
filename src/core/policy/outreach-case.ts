import { OutreachCase } from '../../../generated/prisma/enums.js'
import type { ReasonCodeValue } from '../reason-codes/registry.js'

/**
 * Part C, encoded as a policy predicate.
 *
 * The funnel terminates in an application, not an email. Cold outreach is
 * permitted in exactly three cases:
 *
 *   1. Strong speculative-growth lead with no relevant posting.
 *   2. Company where the public application route is unclear.
 *   3. Targeted follow-up AFTER applying, when a public recruiting contact exists.
 *
 * Any other path to an OutreachDraft is a policy violation and is rejected with
 * `outreach_not_permitted`. The plan calls this the single most important policy
 * test in the suite, so the predicate is pure and total: it takes facts, returns a
 * decision, and has no way to be satisfied by a caller's intent.
 *
 * The enum's ordinals are the plan's 1/2/3.
 */
export const OUTREACH_CASE_NUMBER: Record<OutreachCase, 1 | 2 | 3> = {
  [OutreachCase.speculative_no_posting]: 1,
  [OutreachCase.application_route_unclear]: 2,
  [OutreachCase.post_application_followup]: 3,
}

export type OutreachFacts = {
  /** A posting we consider relevant to one of the four tracks exists and is open. */
  hasRelevantPosting: boolean
  /** An official, usable application URL was found for that posting. */
  hasClearApplicationRoute: boolean
  /** The user has already submitted an application to this company/opportunity. */
  applicationSubmitted: boolean
  /** A public recruiting/careers contact exists, with source evidence. */
  hasPublicRecruitingContact: boolean
  /** The speculative-growth evidence cleared the qualification bar. */
  speculativeEvidenceStrong: boolean
}

export type OutreachDecision =
  | { permitted: true; outreachCase: OutreachCase }
  | { permitted: false; reason: ReasonCodeValue }

export function decideOutreachCase(facts: OutreachFacts): OutreachDecision {
  // Every case requires somewhere to send it. handover.md §8: if no public
  // recruiting route exists, keep the company researched but create no email lead.
  if (!facts.hasPublicRecruitingContact) {
    return { permitted: false, reason: 'no_public_recruiting_route' }
  }

  // Case 3 is checked first and deliberately: once an application exists, the
  // message references it, which makes it relationship correspondence rather than
  // cold mail — the highest-response category and the least exposed of the three.
  if (facts.applicationSubmitted) {
    return { permitted: true, outreachCase: OutreachCase.post_application_followup }
  }

  // Case 1: no relevant posting, but the growth evidence is strong.
  if (!facts.hasRelevantPosting) {
    return facts.speculativeEvidenceStrong
      ? { permitted: true, outreachCase: OutreachCase.speculative_no_posting }
      : { permitted: false, reason: 'weak_evidence' }
  }

  // Case 2: a posting exists but we could not find how to apply.
  if (!facts.hasClearApplicationRoute) {
    return { permitted: true, outreachCase: OutreachCase.application_route_unclear }
  }

  // A posted role with a clear application route and no application submitted is
  // the case the plan explicitly names as a violation: apply first.
  return { permitted: false, reason: 'outreach_not_permitted' }
}
