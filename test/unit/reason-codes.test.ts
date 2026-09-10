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

  it('marks the F4-owned codes as reachable and defers the rest', () => {
    const reachable = reachableReasonCodes('F4')
    // Everything F0-F3 could raise, plus F4's four. Three of them describe a contact
    // route and could not exist before this milestone created the first `Contact`;
    // the fourth, `outreach_not_permitted`, has had a fully unit-tested predicate
    // since F0 and has been unreachable that whole time because nothing composed a
    // draft. F4 is where Part G's most important policy test finally runs against a
    // real path.
    expect(reachable.sort()).toEqual(
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
    // Nothing owned by a later milestone claims to be reachable now.
    expect(reachable).not.toContain('browser_blocked')
    // F5's fourteen in particular. F4 composes and approves, but sends nothing — so
    // every code that describes a transmission or its outcome is still unreachable,
    // including `approval_hash_mismatch`, whose check F4 built and tested but whose
    // raising belongs to D6's send gate.
    expect(reachable).not.toContain('approval_hash_mismatch')
    expect(reachable).not.toContain('hard_bounce')
    expect(reachable).not.toContain('suppressed')
    expect(reachable).not.toContain('cap_exceeded')
    expect(reachable).not.toContain('stale_at_send')
  })
})
