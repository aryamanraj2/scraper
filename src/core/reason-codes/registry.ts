import { ReasonCode } from '../../../generated/prisma/enums.js'
import { MILESTONE_STAGE, isAtOrAfter, type Milestone } from '../config/stage.js'

export { ReasonCode }
export type ReasonCodeValue = (typeof ReasonCode)[keyof typeof ReasonCode]

export type ReasonCodeEntry = {
  /** The milestone that makes this code reachable in running code. */
  milestone: Milestone
  /** Where the code is raised, in one line. */
  description: string
}

/**
 * The closed reason-code enum, annotated.
 *
 * Part G's coverage rule is "every reason code in the closed enum must be
 * reachable by a test" — a better completeness signal than line coverage. That
 * rule is only meaningful if it cannot be satisfied by forgetting. So:
 *
 *   - `test/unit/reason-codes.test.ts` asserts this registry and the Prisma enum
 *     are in exact bijection, in both directions. Adding a code to the schema
 *     without registering it fails the suite, and vice versa.
 *   - Each entry names the milestone that owns it. Codes owned by a shipped
 *     milestone must have a recorded test hit; codes owned by a future milestone
 *     are legitimately unreachable now and are recorded as such rather than
 *     silently exempted.
 *
 * Nothing here is free text: a reason recorded anywhere in the system is one of
 * these values.
 */
export const REASON_CODE_REGISTRY: Record<ReasonCodeValue, ReasonCodeEntry> = {
  // --- D4 fetch preflight (F0) -------------------------------------------
  host_denied: {
    milestone: 'F0',
    description: 'Host is on the permanent denylist, or is unknown with no derived-company allow entry.',
  },
  robots_disallowed: {
    milestone: 'F0',
    description: 'robots.txt disallows our user-agent for this exact path, or is missing/unparseable for a non-allowlisted host.',
  },
  terms_prohibited: {
    milestone: 'F0',
    description: 'Host is recorded as prohibiting automated access; robots.txt permission does not override stated terms.',
  },
  rate_limited: {
    milestone: 'F0',
    description: 'Per-host token bucket is empty; a published crawl-delay or rate limit beats our default.',
  },
  budget_exhausted: {
    milestone: 'F0',
    description: 'The company research budget or the monthly cap has no headroom.',
  },

  // --- D6 send gate (F5, except the two enforceable now) ------------------
  approval_hash_mismatch: {
    milestone: 'F5',
    description: 'approval_hash recomputed from live rows differs from the value frozen at human approval.',
  },
  suppressed: {
    milestone: 'F5',
    description: 'A suppression matches email_hmac at contact, domain, or global scope.',
  },
  profile_incomplete: {
    milestone: 'F5',
    description: 'Candidate profile is missing a field from the enumerated send-enable list.',
  },
  stale_at_send: {
    milestone: 'F5',
    description: 'Cited evidence exceeded max_evidence_age_days, or a posted role failed live re-confirmation.',
  },
  outreach_not_permitted: {
    milestone: 'F4',
    description: 'Draft path falls outside Part C cases 1-3.',
  },
  cap_exceeded: {
    milestone: 'F5',
    description: 'Daily or per-domain send cap reached.',
  },
  breaker_open: {
    milestone: 'F5',
    description: 'Circuit breaker tripped on hard-bounce rate or an operator action.',
  },
  duplicate_contact: {
    milestone: 'F5',
    description: 'A first touch already exists for this contact in this campaign cycle (D3).',
  },
  duplicate_company: {
    milestone: 'F5',
    description: 'A first touch already exists for this company in this campaign cycle (D3).',
  },
  sending_disabled: {
    milestone: 'F0',
    description: 'Build stage is below F5, the env flag is unset, or a kill switch is engaged.',
  },

  // --- qualification / rejection (F2, F3) ---------------------------------
  no_public_recruiting_route: {
    milestone: 'F4',
    description: 'No public careers alias or published recruiting contact exists for the company.',
  },
  executive_only_contact: {
    milestone: 'F4',
    description: 'Only founder/CEO/executive contacts were found; these are never targeted.',
  },
  outdated_role: {
    milestone: 'F2',
    description: 'The posting is past its freshness window or no longer listed.',
  },
  weak_evidence: {
    milestone: 'F2',
    description: 'Evidence is too thin or too generic to support a personalized claim.',
  },
  low_relevance: {
    milestone: 'F2',
    description: 'Score fell below the reject threshold for the active ScoreVersion.',
  },
  duplicate: {
    milestone: 'F1',
    description: 'The record resolves to a company or opportunity already ingested.',
  },
  legal_policy_mismatch: {
    milestone: 'F4',
    description: 'A jurisdiction or policy check refused the lead.',
  },
  insufficient_evidence: {
    milestone: 'F2',
    description: 'Research budget ran out before enough evidence accumulated. Re-entrant, not a verdict.',
  },

  // --- outcomes (F5, F6) --------------------------------------------------
  hard_bounce: { milestone: 'F5', description: 'Permanent delivery failure; suppresses the contact.' },
  soft_bounce: { milestone: 'F5', description: 'Transient delivery failure; must NOT permanently suppress (A12).' },
  opt_out: { milestone: 'F5', description: 'Recipient asked not to be contacted; permanent suppression.' },
  wrong_contact: { milestone: 'F5', description: 'Recipient reported they are not the right route.' },
  replied: { milestone: 'F5', description: 'A reply arrived; cancels any pending follow-up.' },
  application_submitted: { milestone: 'F3', description: 'The user submitted the application; stops outreach for that opportunity.' },
  user_paused: { milestone: 'F5', description: 'Operator paused this lead, company, or the whole queue.' },

  // --- research (F2) ------------------------------------------------------
  source_unavailable: { milestone: 'F1', description: 'The source returned an error or an unusable payload.' },
  content_unchanged: {
    // Moved F2 -> F1. The F1 handover's ownership table put this in F2, but §8.2.4
    // of the same document requires F1's posting ingest to "hit content_unchanged
    // via contentHash rather than churn rows" — so it is reachable from F1's real
    // path, and the registry records where a code IS raised, not where it was
    // expected to be. See docs/F2-HANDOVER.md §6.
    milestone: 'F1',
    description: 'Content hash matched the stored value; no reclassification needed.',
  },
  injection_detected: {
    milestone: 'F2',
    description: 'Fetched page text contained instruction-shaped content; recorded as data, never executed.',
  },

  // --- kill switch (F0) ---------------------------------------------------
  kill_switch_global: { milestone: 'F0', description: 'Global kill switch engaged.' },
  kill_switch_domain: { milestone: 'F0', description: 'Kill switch engaged for a recipient domain.' },
  kill_switch_account: { milestone: 'F0', description: 'Kill switch engaged for a sender identity.' },

  // --- browser layer (F7 seam; deferred per D4) ---------------------------
  browser_needs_user: { milestone: 'F7', description: 'Browser task hit a login, CAPTCHA, or consent prompt and stopped.' },
  browser_blocked: { milestone: 'F7', description: 'Browser task hit a non-allowlisted host or a disallowed action.' },
  browser_policy_rejected: { milestone: 'F7', description: 'Browser task spec failed the policy gateway before starting.' },
}

export const ALL_REASON_CODES = Object.values(ReasonCode) as ReasonCodeValue[]

/** Codes that running code at the current build stage is expected to be able to raise. */
export function reachableReasonCodes(stage: Milestone = MILESTONE_STAGE): ReasonCodeValue[] {
  return ALL_REASON_CODES.filter((code) =>
    isAtOrAfter(stage, REASON_CODE_REGISTRY[code].milestone),
  )
}

export function describeReasonCode(code: ReasonCodeValue): string {
  return REASON_CODE_REGISTRY[code].description
}
