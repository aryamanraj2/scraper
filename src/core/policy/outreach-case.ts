import { OutreachCase } from '../../../generated/prisma/enums.js'
import type { ReasonCodeValue } from '../reason-codes/registry.js'

/**
 * Part C, encoded as a policy predicate — plus the operator's fourth case (F4).
 *
 * The plan's Part C permits cold outreach in exactly three cases:
 *
 *   1. Strong speculative-growth lead with no relevant posting.
 *   2. Company where the public application route is unclear.
 *   3. Targeted follow-up AFTER applying, when a public recruiting contact exists.
 *
 * **F4 adds a fourth, by operator decision**, superseding the narrow reading of Part C:
 *
 *   4. `intern_availability_inquiry` — a short question about internship availability,
 *      permitted when a **verified** contact exists at a qualified company, whatever
 *      the posting situation.
 *
 * ## Why case 4 is evaluated last
 *
 * Case 3 messages reference a submitted application, which makes them relationship
 * correspondence rather than cold mail — Part C calls that "the highest-response
 * category available and the one least exposed to every concern in B4". If case 4 were
 * checked first it would swallow every lead where an application already exists and
 * silently downgrade the best message this system can send. So the order is: 3, then
 * 1, then 2, then 4.
 *
 * ## What case 4 costs, stated plainly
 *
 * Before F4, a posted role with a clear application route and no application was a
 * **policy violation** — the plan's instruction was "apply first". Case 4 permits a
 * message there, provided the contact is verified. `outreach_not_permitted` therefore
 * narrows to: a posted role, a clear route, no application, and a contact that exists
 * but is **not verified**. That is a real narrowing and it was the operator's call; it
 * is not an accident of refactoring, and the test that pins it is Part G's most
 * important one.
 *
 * ## Why verification is the gate
 *
 * An unverified contact is one this system did not read off the employer's own page
 * and did not receive from a verified provider — in practice, a pattern-inferred
 * address. Those open **no** case at all. That is what makes
 * `CONTACT_ALLOW_PATTERN_INFERENCE` safe to expose: the flag can produce candidate
 * rows for the operator to confirm by hand, and they can never become a send target on
 * their own.
 */
export const OUTREACH_CASE_NUMBER: Record<OutreachCase, 1 | 2 | 3 | 4> = {
  [OutreachCase.speculative_no_posting]: 1,
  [OutreachCase.application_route_unclear]: 2,
  [OutreachCase.post_application_followup]: 3,
  [OutreachCase.intern_availability_inquiry]: 4,
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
  /**
   * A contact exists whose address this system read off a published page or received
   * from a verified provider — never one it constructed. Case 4's precondition.
   */
  hasVerifiedContact: boolean
  /** The lead cleared the scorer's queue threshold. Case 4's other precondition. */
  leadQualified: boolean
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

  // Case 3 first, deliberately: once an application exists the message can reference
  // it, which is the strongest and least exposed thing this system can send.
  if (facts.applicationSubmitted) {
    return { permitted: true, outreachCase: OutreachCase.post_application_followup }
  }

  // Case 1: no relevant posting, but the growth evidence is strong.
  if (!facts.hasRelevantPosting) {
    if (facts.speculativeEvidenceStrong) {
      return { permitted: true, outreachCase: OutreachCase.speculative_no_posting }
    }
    // Thin evidence and no posting. Case 4 can still carry it if the contact is
    // verified — the message is a question about availability, not a claim about the
    // company, so it does not rest on evidence the way a speculative pitch does.
    return internInquiryOr(facts, 'weak_evidence')
  }

  // Case 2: a posting exists but we could not find how to apply.
  if (!facts.hasClearApplicationRoute) {
    return { permitted: true, outreachCase: OutreachCase.application_route_unclear }
  }

  // A posted role with a clear route and no application. Under Part C alone this was
  // a violation — apply first. Case 4 permits an availability inquiry here IF the
  // contact is verified and the lead qualified; otherwise the original refusal stands.
  return internInquiryOr(facts, 'outreach_not_permitted')
}

function internInquiryOr(facts: OutreachFacts, otherwise: ReasonCodeValue): OutreachDecision {
  if (facts.hasVerifiedContact && facts.leadQualified) {
    return { permitted: true, outreachCase: OutreachCase.intern_availability_inquiry }
  }
  return { permitted: false, reason: otherwise }
}
