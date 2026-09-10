import type { ContactDiscoveryMethod } from '../../../generated/prisma/enums.js'
import { normalizeCountry } from '../../intel/country/normalize.js'

/**
 * `legal_policy_mismatch` — and a careful account of what this check does and does
 * not claim.
 *
 * ## What B4 forbids
 *
 * B4 is unusually explicit. Primary-source research did **not** resolve whether
 * CAN-SPAM, PECR, UK GDPR or their analogues reach individual, human-approved
 * job-seeker outreach, and its instruction is to *"draw no conclusion in either
 * direction, and never rely on being out of scope."*
 *
 * So this module must not encode a legal conclusion. "Refuse EU contacts" would be
 * one — it asserts that a regime applies. "Permit EU contacts" would be the other,
 * and the more dangerous, because it asserts that none does.
 *
 * ## What it checks instead
 *
 * It gates **the amended path only**, which is the one thing that genuinely changed
 * under the operator's F4 scope note.
 *
 * §10.3 records the reasoning: B4's posture was reasoned about *role aliases at
 * hand-approved volume*. Named individuals, sourced from a third party, at
 * 1,000–2,000 scale is a different fact pattern — GDPR Art. 14's notice obligation
 * when data comes from somewhere other than the person — and B4's own closing line is
 * that an expansion like this *"must be re-examined with actual legal advice"*.
 *
 * Tier A is untouched. An address the employer published on their own careers page,
 * read through `FetchPolicyGate`, needs no amendment at all — `handover.md` §1.2 was
 * never in its way — so it never reaches this check.
 *
 * The claim this code makes is therefore narrow and, unlike the alternatives, true:
 *
 * > A contact obtained by a method the operator's amendment introduced, at a company
 * > in a region whose review has not been recorded as done, is refused until that
 * > review is recorded.
 *
 * It says nothing about whether any law applies. It says the operator has not yet
 * done the thing B4 told them to do, and that until they have, the system will not
 * act on the amendment in that region. Recording a review is a deliberate operator
 * act, which is what B4 asks for and what §10.5 defers out of F4.
 *
 * ## Why it is reachable today
 *
 * `Tier B` is a seam with a fake and no vendor (§10.5), so nothing produces a
 * `lookup_provider` contact in production. But the check runs on
 * `Contact.discoveryMethod`, which the fake and the pattern-inference flag both set —
 * so the code path is real, driven by real rows, and not a helper invoked by a test
 * to satisfy a counter.
 */

/**
 * Discovery methods the operator's amendment introduced. `page_published` is
 * deliberately absent: it predates the amendment and is what §1.2 always allowed.
 */
const AMENDED_METHODS = new Set<ContactDiscoveryMethod>(['lookup_provider', 'pattern_inferred'])

/**
 * Regions where a third-party-sourced contact needs the review B4 asks for before the
 * amendment is acted on.
 *
 * These are the regions §10.3 names as raising the different fact pattern, plus the
 * unknown case. **Unknown is included on purpose**: a country string the map could not
 * resolve is not evidence of a permissive jurisdiction, and F2 §4.11's rule — an
 * unrecognised country resolves to null and is recorded as unmapped, never guessed —
 * means unknown is common rather than exotic.
 */
const REVIEW_REQUIRED_REGIONS = new Set(['uk', 'eu', 'unknown'])

export type JurisdictionFacts = {
  /** How this system came to hold the address. */
  discoveryMethod: ContactDiscoveryMethod
  /** The company's country strings, exactly as the source published them (F1 §4.12). */
  countries: string[]
  /**
   * Regions the operator has recorded a completed review for. Empty until they do —
   * the default is "not reviewed", because B4's instruction is never to rely on being
   * out of scope, and an empty list is the only honest starting point.
   */
  reviewedRegions?: ReadonlySet<string>
}

export type JurisdictionDecision =
  | { permitted: true }
  | { permitted: false; reason: 'legal_policy_mismatch'; detail: string }

export function checkJurisdiction(facts: JurisdictionFacts): JurisdictionDecision {
  // Tier A, the working path, never reaches the amendment and is never gated by it.
  if (!AMENDED_METHODS.has(facts.discoveryMethod)) return { permitted: true }

  const reviewed = facts.reviewedRegions ?? new Set<string>()
  const regions = resolveRegions(facts.countries)

  const unreviewed = [...regions].filter((r) => REVIEW_REQUIRED_REGIONS.has(r) && !reviewed.has(r))
  if (unreviewed.length === 0) return { permitted: true }

  return {
    permitted: false,
    reason: 'legal_policy_mismatch',
    detail:
      `contact obtained by "${facts.discoveryMethod}" at a company in ${unreviewed.join(', ')}; ` +
      `the operator's §1.2 amendment has no recorded review for that region. ` +
      `This is not a finding that any regime applies (B4) — it is that the re-examination B4 asks for has not been recorded.`,
  }
}

/**
 * The company's regions, from the source's own country strings.
 *
 * A company with no resolvable country yields `unknown` rather than nothing, so an
 * unmapped string cannot become an implicit permit.
 */
function resolveRegions(countries: string[]): Set<string> {
  const regions = new Set<string>()
  for (const raw of countries) {
    const resolved = normalizeCountry(raw)
    // `region` is 'other' both for a country genuinely outside the priority regions
    // and for a spelling the table does not recognise, and those are different facts.
    // F2 §4.11 keeps the distinction: an unrecognised string has a null `code` and is
    // recorded as unmapped rather than guessed at. Only the second is `unknown` here,
    // because an unmapped string is not evidence of a permissive jurisdiction.
    regions.add(resolved.code === null ? 'unknown' : resolved.region)
  }
  if (regions.size === 0) regions.add('unknown')
  return regions
}
