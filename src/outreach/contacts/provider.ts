import type { ContactType } from '../../../generated/prisma/enums.js'

/**
 * Tier B — the verified-lookup seam. **Built in F4, deliberately not exercised.**
 *
 * ## Status, stated so nobody mistakes the seam for a decision
 *
 * The operator's F4 scope note amends `handover.md` §1.2 to permit verified lookup
 * providers, and then instructs that the amendment be left **written down and
 * unexercised** this milestone: no vendor chosen, no terms read, no host allow entry,
 * no live call. Tier A — addresses read off the employer's own pages — is the working
 * path, and it needs no amendment at all.
 *
 * So this file is an interface and a fixture-backed fake. Enabling a real provider is
 * a separate, reviewed act that must do what the plan requires of every optional
 * adapter (Part E): *"endpoint live, terms read, rate policy recorded, fixtures
 * captured, `FetchPolicyGate` entry added"*.
 *
 * ## Two things a future implementer must not get wrong
 *
 * **A provider is not a licence to skip the executive filter.** Whatever a vendor
 * returns goes through `isExecutiveContact` exactly as a scraped address does.
 * `handover.md` §1.1 is not amended by anything in the F4 scope note — the operator
 * kept the exclusion explicitly, and it is the boundary of the broadened policy.
 *
 * **A provider call is a network call**, so it goes through `FetchPolicyGate` like
 * everything else. There is no client here and there must never be one: the adapter
 * receives a gate. That is why this interface takes no transport of its own.
 */

export type VerifiedContactQuery = {
  companyId: string
  canonicalDomain: string
  companyName: string
  /** What the caller is looking for. A provider that cannot filter returns everything. */
  wanted: 'role_alias' | 'recruiting_person' | 'any_non_executive'
  limit: number
}

export type VerifiedContactResult = {
  email: string
  /** The provider's own confidence that the address deliverable, 0..1. */
  confidence: number
  /** Published title, when the provider has one. Fed to the executive filter. */
  title: string | null
  fullName: string | null
  /** The provider's own evidence URL, when it publishes one. */
  sourceUrl: string | null
  suggestedType: ContactType
}

export interface VerifiedContactProvider {
  readonly slug: string
  /** False when no key is configured. Callers must check before spending anything. */
  readonly enabled: boolean
  lookup(query: VerifiedContactQuery): Promise<VerifiedContactResult[]>
}

/**
 * H9's floor for an absent optional adapter: present, disabled, and correct.
 *
 * The pipeline must be right with every optional capability missing, so the default
 * implementation returns nothing rather than throwing. A caller that treats "no
 * provider" as an error would make Tier B a dependency instead of an enhancement.
 */
export class DisabledContactProvider implements VerifiedContactProvider {
  readonly slug = 'disabled'
  readonly enabled = false

  lookup(): Promise<VerifiedContactResult[]> {
    return Promise.resolve([])
  }
}

/**
 * A fake with a fixed table, for contract tests. Part G requires every adapter to be
 * exercised against **both** a real-with-fixtures implementation and a fake; this is
 * the fake half, and it is all F4 has because no real one exists yet.
 */
export class FakeContactProvider implements VerifiedContactProvider {
  readonly slug = 'fake'
  readonly enabled = true

  constructor(private readonly table: Record<string, VerifiedContactResult[]> = {}) {}

  lookup(query: VerifiedContactQuery): Promise<VerifiedContactResult[]> {
    return Promise.resolve((this.table[query.canonicalDomain] ?? []).slice(0, query.limit))
  }
}
