import { describe, expect, it } from 'vitest'
import {
  ALL_REASON_CODES,
  REASON_CODE_REGISTRY,
  ReasonCode,
  reachableReasonCodes,
} from '../../src/core/reason-codes/registry.js'
import { MILESTONE_ORDER } from '../../src/core/config/stage.js'

/**
 * F0 exit criterion: "reason-code enum complete."
 *
 * Part G's coverage rule is that every reason code must be reachable by a test.
 * That rule is worthless if a new code can be added without anyone noticing, so
 * the bijection below is the mechanical part: schema and registry must agree in
 * both directions, or the suite fails.
 */
describe('reason-code registry', () => {
  it('covers every enum member', () => {
    const missing = ALL_REASON_CODES.filter((code) => !(code in REASON_CODE_REGISTRY))
    expect(missing, `codes in the Prisma enum with no registry entry: ${missing.join(', ')}`).toEqual([])
  })

  it('contains no entry that is not an enum member', () => {
    const enumValues = new Set<string>(ALL_REASON_CODES)
    const extra = Object.keys(REASON_CODE_REGISTRY).filter((k) => !enumValues.has(k))
    expect(extra, `registry entries with no matching enum member: ${extra.join(', ')}`).toEqual([])
  })

  it('assigns every code a known milestone and a description', () => {
    for (const code of ALL_REASON_CODES) {
      const entry = REASON_CODE_REGISTRY[code]
      expect(MILESTONE_ORDER, `${code} has an unknown milestone`).toContain(entry.milestone)
      expect(entry.description.length, `${code} has no description`).toBeGreaterThan(10)
    }
  })

  it('is a closed enum — no free-text reason is representable', () => {
    // The Prisma enum is the DB constraint; this asserts the TS surface matches it
    // exactly, so a caller cannot smuggle a string past the type system.
    expect(Object.keys(ReasonCode).sort()).toEqual([...ALL_REASON_CODES].sort())
  })

  it('marks the F5-owned codes as reachable and defers the rest', () => {
    const reachable = reachableReasonCodes('F5')
    // Everything F0-F4 could raise, plus F5's fifteen — the fourteen the F4 handover
    // named, and `recipient_not_owned`, added in F5 as the 40th code.
    //
    // The enum is closed and a new value costs a migration and an owner, so F4 §4.11
    // was right to map gate failures onto existing codes rather than invent one. This
    // is the case with no analogue: Part F's F5 deliverable is "verified sends to
    // owned inboxes ONLY", and folding that refusal into `sending_disabled` would make
    // the single most safety-critical refusal in the milestone indistinguishable, in
    // every counter and every audit row, from "the operator has not set the env flag".
    expect(reachable.sort()).toEqual(
      [
        'application_submitted',
        'approval_hash_mismatch',
        'breaker_open',
        'budget_exhausted',
        'cap_exceeded',
        'content_unchanged',
        'duplicate',
        'duplicate_company',
        'duplicate_contact',
        'executive_only_contact',
        'hard_bounce',
        'host_denied',
        'injection_detected',
        'insufficient_evidence',
        'kill_switch_account',
        'kill_switch_domain',
        'kill_switch_global',
        'legal_policy_mismatch',
        'low_relevance',
        'no_public_recruiting_route',
        'opt_out',
        'outdated_role',
        'outreach_not_permitted',
        'profile_incomplete',
        'rate_limited',
        'recipient_not_owned',
        'replied',
        'robots_disallowed',
        'sending_disabled',
        'soft_bounce',
        'source_unavailable',
        'stale_at_send',
        'suppressed',
        'terms_prohibited',
        'user_paused',
        'weak_evidence',
        'wrong_contact',
      ].sort(),
    )
    // F4's own set stays exactly what it was: bumping the stage adds codes, it never
    // reclassifies one that already shipped.
    expect(reachableReasonCodes('F4').sort()).toEqual(
      [
        'application_submitted',
        'budget_exhausted',
        'content_unchanged',
        'duplicate',
        'executive_only_contact',
        'host_denied',
        'injection_detected',
        'insufficient_evidence',
        'legal_policy_mismatch',
        'no_public_recruiting_route',
        'outreach_not_permitted',
        'kill_switch_account',
        'kill_switch_domain',
        'kill_switch_global',
        'low_relevance',
        'outdated_role',
        'rate_limited',
        'robots_disallowed',
        'sending_disabled',
        'source_unavailable',
        'terms_prohibited',
        'weak_evidence',
      ].sort(),
    )
    // F3's own set stays exactly what it was: bumping the stage adds codes, it never
    // reclassifies one that already shipped.
    expect(reachableReasonCodes('F3').sort()).toEqual(
      [
        'application_submitted',
        'budget_exhausted',
        'content_unchanged',
        'duplicate',
        'host_denied',
        'injection_detected',
        'insufficient_evidence',
        'kill_switch_account',
        'kill_switch_domain',
        'kill_switch_global',
        'low_relevance',
        'outdated_role',
        'rate_limited',
        'robots_disallowed',
        'sending_disabled',
        'source_unavailable',
        'terms_prohibited',
        'weak_evidence',
      ].sort(),
    )
    // F2's own set stays exactly what it was.
    expect(reachableReasonCodes('F2').sort()).toEqual(
      [
        'budget_exhausted',
        'content_unchanged',
        'duplicate',
        'host_denied',
        'injection_detected',
        'insufficient_evidence',
        'kill_switch_account',
        'kill_switch_domain',
        'kill_switch_global',
        'low_relevance',
        'outdated_role',
        'rate_limited',
        'robots_disallowed',
        'sending_disabled',
        'source_unavailable',
        'terms_prohibited',
        'weak_evidence',
      ].sort(),
    )
    // F1's own set stays exactly what it was.
    expect(reachableReasonCodes('F1').sort()).toEqual(
      [
        'budget_exhausted',
        'content_unchanged',
        'duplicate',
        'host_denied',
        'kill_switch_account',
        'kill_switch_domain',
        'kill_switch_global',
        'rate_limited',
        'robots_disallowed',
        'sending_disabled',
        'source_unavailable',
        'terms_prohibited',
      ].sort(),
    )
    // F0's own set stays exactly what it was: bumping the stage adds codes, it
    // never reclassifies one that already shipped.
    expect(reachableReasonCodes('F0').sort()).toEqual(
      [
        'budget_exhausted',
        'host_denied',
        'kill_switch_account',
        'kill_switch_domain',
        'kill_switch_global',
        'rate_limited',
        'robots_disallowed',
        'sending_disabled',
        'terms_prohibited',
      ].sort(),
    )
    // Nothing owned by a later milestone claims to be reachable now. F7's browser
    // layer is the only set left after F5 — D4 defers it, and the seam is types only.
    expect(reachable).not.toContain('browser_blocked')
    expect(reachable).not.toContain('browser_needs_user')
    expect(reachable).not.toContain('browser_policy_rejected')
    expect(reachableReasonCodes('F7').sort()).toEqual(
      [...reachable, 'browser_blocked', 'browser_needs_user', 'browser_policy_rejected'].sort(),
    )
  })
})
