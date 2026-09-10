/**
 * §10.7 — how many contacts at one company may become drafts.
 *
 * ## The tension this resolves
 *
 * D3's partial unique index `one_first_touch_per_company_per_cycle` permits exactly
 * one first-touch send per company per cycle. Under it, Tier A and Tier B cannot both
 * fire at one company, so Tier B adds quality but **no volume** — which matters when
 * the target is 1,000–2,000 contacts.
 *
 * The operator's decision: *"keep it 1 per small company and 2 for a decent one."*
 *
 * ## The threshold, and that it is a judgement call
 *
 * `teamSize >= 100` → 2 slots; otherwise 1; unknown → 1.
 *
 * The reasoning, recorded because the next session may want to move it: at 100+ there
 * is usually a real recruiting function, so a second route reaches a genuinely
 * different human. Below that, two messages is a visible fraction of the company and
 * reads as spray — which is the failure mode `handover.md` §2 built this system to
 * avoid. Measured against the 21 qualified companies, the line falls between
 * AssemblyAI (65) and Eight Sleep (100), giving 2 slots to 16 of 21.
 *
 * **Unknown team size gets one slot, not two.** A missing value is not evidence of a
 * large company, and the failure directions are not symmetric: one message too few
 * costs a lead, one too many costs the sender's reputation at a company small enough
 * to notice.
 *
 * ## Where the real ceiling lives
 *
 * Here is *policy*. The hard ceiling belongs in the database, on `send_attempt`, where
 * A2's invariant lives — and F5 owns that table. §10.7's SQL sketch replaces the
 * company index with one over `(company_id, campaign_cycle, touch_slot)`, so the
 * database caps at two whatever this file says. `Draft.touchSlot` exists now so that
 * migration has a column to key on and F4's drafts already carry the right value.
 *
 * A2's per-contact index is untouched by any of this: one first touch per human per
 * cycle, regardless of track, remains exactly as D3 wrote it.
 */

/** Companies at or above this head count get a second slot. §10.7's judgement call. */
export const SECOND_SLOT_TEAM_SIZE = 100

/** The maximum any company may ever have, whatever the policy above decides. */
export const MAX_SLOTS_PER_COMPANY = 2

export function slotsForCompany(teamSize: number | null | undefined): 1 | 2 {
  if (teamSize === null || teamSize === undefined) return 1
  return teamSize >= SECOND_SLOT_TEAM_SIZE ? 2 : 1
}

/**
 * Which contacts at a company may become drafts, in the order they should be used.
 *
 * H2's tier ordering: role aliases are the default, a published University Recruiting
 * or Talent named contact is second. B5 found the `careers@`-first premise unverified,
 * so this ordering is a starting position the pilot measures, not a finding — which is
 * why the yield gap is an open question rather than a settled one.
 *
 * Unverified contacts are excluded outright. An unverified contact opens no outreach
 * case at all (`outreach-case.ts`), so admitting one here would produce a draft that
 * the predicate then refuses — a wasted row and a confusing audit trail.
 */
export type SlotCandidate = {
  id: string
  contactType: string
  verified: boolean
}

const TIER_ORDER: Record<string, number> = {
  university_recruiting: 0,
  talent_alias: 1,
  careers_alias: 2,
  named_talent: 3,
  named_employee: 4,
}

export function selectContactSlots(
  contacts: SlotCandidate[],
  teamSize: number | null | undefined,
): { contactId: string; touchSlot: number }[] {
  const eligible = contacts
    .filter((c) => c.verified)
    .sort((a, b) => {
      const rank = (TIER_ORDER[a.contactType] ?? 99) - (TIER_ORDER[b.contactType] ?? 99)
      // Ties break on id so a re-run selects the same contacts rather than reshuffling
      // the operator's review queue — F3 §4.4's rule, for the same reason.
      return rank !== 0 ? rank : a.id.localeCompare(b.id)
    })

  const slots = Math.min(slotsForCompany(teamSize), MAX_SLOTS_PER_COMPANY)
  return eligible.slice(0, slots).map((c, i) => ({ contactId: c.id, touchSlot: i }))
}
