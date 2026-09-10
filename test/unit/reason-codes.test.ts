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

  it('marks the F3-owned codes as reachable and defers the rest', () => {
    const reachable = reachableReasonCodes('F3')
    // Everything F0, F1 and F2 could raise, plus F3's one: the code recorded when the
    // operator marks a packet submitted. It is the code that STOPS OUTREACH for an
    // opportunity — Part C case 3 permits a follow-up only after an application
    // exists, and F4's outreach predicate reads this state.
    expect(reachable.sort()).toEqual(
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
    // Nothing owned by a later milestone claims to be reachable now.
    expect(reachable).not.toContain('approval_hash_mismatch')
    expect(reachable).not.toContain('browser_blocked')
    // F4's four in particular: F3 creates no Contact and composes no draft, so none
    // of the codes that describe a contact route can be raised by anything yet.
    expect(reachable).not.toContain('outreach_not_permitted')
    expect(reachable).not.toContain('no_public_recruiting_route')
    expect(reachable).not.toContain('executive_only_contact')
    expect(reachable).not.toContain('legal_policy_mismatch')
  })
})
