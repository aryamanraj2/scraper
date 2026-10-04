# F7 Handover — after the Controlled Pilot

> **DRAFT, written incrementally during F6.** Only §4 (deviations) and §10 (open
> questions) have content so far, recorded as each F6 build step landed so the reasoning
> is written down while it is fresh. §0–§3 and §5–§9 are completed at the end of F6.
> Section numbering follows the earlier handovers.

---

## 4. Deviations from the plan — every one, with its reason

F0's nine, F1's fifteen, F2's fifteen, F3's fifteen, F4's twelve and F5's fourteen are
all still in force and none were reverted. These are F6's. **Do not silently revert any
of them; if you disagree, raise it with the user.**

### 4.1 Lookup-provider `valid` verdicts verify a contact — SalesQL included

`docs/F6-DECISIONS.md` §3.1, an operator decision taken 2026-10-04. A `lookup_provider`
contact becomes `verified = true` when, and only when, its provider's `email_status`
was exactly `valid`. `accept_all`, blank and every other token stay unverified —
`accept_all` means the domain accepts every address, which is no verdict at all.

**The provenance basis the decision rests on, recorded because the operator asked for
it to be:** the SalesQL rows came from **SalesQL's own search database**, not from
browsing LinkedIn with SalesQL's browser extension. The rows' `source_url` column holds
LinkedIn profile URLs, as the vendor exports them; nothing in this system fetched them,
and the denylist refuses the host regardless. If that basis is ever found to be wrong,
the 39 SalesQL flips are the ones to revisit.

Built as two halves sharing one rule (`providerAttestsDeliverable` in
`src/outreach/contacts/import.ts`):

- **The importer** now reads an optional `email_status` column, so a future import
  cannot regress this.
- **A one-shot backfill** (`npm run contacts:verify-backfill`, dry run by default,
  `--write` to apply) reads the verdict out of each imported contact's Evidence excerpt —
  the importer had stored the operator's CSV line verbatim, verdict last — with the
  project's own CSV parser, because titles and notes carry quoted commas that
  `split(',')` would misread into a false `valid`. The parsed email must equal the
  contact's own address or the row is refused as `email_mismatch`; a truncated excerpt is
  refused. No second Evidence row is written; one `contact.verified_by_provider` audit row
  per flip names the contact, the evidence id and the verbatim verdict.

Measured, 2026-10-04: dry run 76 `valid` (hunter 17, snov 20, salesql 39) exactly as
predicted; written run **75 flips** (hunter 17, snov 19, salesql 39) because §4.3
retired one snov row first. Verified contacts 17 → **92**.

Hunter and Snov verdicts were cached around 2026-09-16; SMTP verdicts decay. Keep the
provider visible in every pilot report.

### 4.2 The pilot is 33 companies, not 50 and not 36

Part F asks for "a measured 50-company pilot"; `F6-DECISIONS.md` §3.1 measured 36. The
measured number after the backfill is **33 sendable qualified companies — 15 alias-only,
16 named-only, 2 with both**.

The 36 did not account for `jurisdiction.ts` (F5-HANDOVER §4.9), which refuses a
`lookup_provider` contact at a company in a region with no recorded review. Of the 48
provider-`valid` contacts at qualified companies, **8 are refused: Germany 5, Finland 2,
UK 1** — which removes three companies. The operator decided **not** to record a uk/eu
review: that is B4's re-examination and GDPR Art. 14's notice question, and it stays
deferred with Tier B. The corpus was deliberately not widened to make up the number.

### 4.3 The executive filter's "head of" rule was widened, and one contact retired

The F4 rule matched the literal `head of <function>`. A Snov export wrote Rapido's head
of talent as **"Head -Talent Acquisition"**, which passed. The rule is now `HEAD_OF_FUNCTION`
in `src/outreach/contacts/executive-filter.ts`: "head" as a whole word, then any
punctuation or whitespace, then an optional "of", then the same function words. Tests
pin "Head -Talent Acquisition", "Head: Engineering", "Head of Talent", "Head - Product",
"Head, People", and the negatives "Overhead", "Headspace", "Headless" in titles and
addresses.

The backfill re-runs the filter on every row **before** flipping it, because verifying a
contact is what lets a draft reach them, so the filter as it stands today decides. The
one row it now refuses, the Rapido talent-acquisition contact, was set `retired` with a
`contact.retired_executive` audit row (`reasonCode: executive_only_contact`, rule named,
address not recorded). Rapido is not a qualified company, so the pilot was never exposed;
the fix is for the boundary, not the pilot.

**Directors were deliberately not added.** The operator's boundary is founders, CEOs,
C-suite and VPs; "Director of Engineering" titles pass, and the operator skips any they
do not want at per-message approval. Two are at qualified companies: Strava's "Senior
Director of Engineering" (sendable) and N26's (refused by §4.2's jurisdiction check).

### 4.4 `verify:f4` asserted "no executive stored" when its intent is "no executive targetable"

The F5-HANDOVER §4.9 shape, a fourth time: a shipped verifier failed **because a later
milestone did its job.** Criterion 4 ran the filter over every stored contact and
required zero hits; §4.3 correctly kept the refused row as `retired` rather than deleting
it — the record of the decision is worth more than a clean count — and the criterion
went to 12/13.

What §1.1 needs is that no executive can be **targeted**. Criterion 4 now passes a
flagged contact only if it is `retired` **and** carries its `contact.retired_executive`
audit row, and fails on **any** other status. `suppressed` deliberately does not satisfy
it: suppression is a decision about a recipient's wishes or a bounce, not about §1.1, and
letting it stand in would let an executive pass because they once bounced.

Two properties pinned alongside, in `test/policy/contact-verification-backfill.test.ts`:
re-importing a retired contact's address — under the executive title or a benign one —
never resets it to `active` and never creates a second row (the importer refuses the
first and reports `already_present` for the second); and the composer selects
`status: 'active'` contacts only, so a retired row is unreachable from a draft.

**Small, for whoever touches audit metadata next:** the sink-side redactor masks any
metadata key containing "token". The backfill's audit field is `verdict`, not
`verdictToken`, for that reason; the first version recorded `[REDACTED]`.

### 4.5 The message carries no opt-out line — `signoff.plain@2` *(departs from B4 and H6)*

`docs/F6-DECISIONS.md` §3.2, an operator decision taken 2026-10-04. B4 lists "an easy way
to decline" among its voluntarily adopted controls, and H6 swaps RFC 8058's header for "a
plain human opt-out line". F4 built that line into `signoff.plain@1`: *"If you'd rather I
didn't write again, say so and I won't."* The operator wants the mail to read as
hand-written, and a decline line is what makes a one-off note read as a campaign.

`signoff.plain@2` renders the operator's name and nothing else, and the composer uses it
for every new draft. Nothing replaces the line, and there is still no `List-Unsubscribe`
header (H6 is unchanged on that). What the decision rests on:

- **The reply is the opt-out.** `classifyReply` reads "stop", "not interested", "remove
  me" and the rest as `opt_out`, favouring recall over precision (F6-HANDOVER §4.6), and
  an opt-out writes the HMAC suppression. Losing the prompt means a recipient's "no" now
  arrives unprompted and in their own words, so that classifier carries more weight than
  it did. Its patterns were already written for unprompted phrasings and did not change.
- **One message per person** (§3.3 of the decisions file). Nothing automated follows, so
  a recipient who ignores the mail never hears from the system again.

**`signoff.plain@1` stays registered and its text must never change.** All four drafts
in `outreach_dev` cite it. `validateComposition` refuses an unregistered `templateId`, so
removing it would fail them at the Quality Gate and in `verify:f4`. The approval hash
covers the stored sentence text and `templateId`, not a re-rendering, so it recomputes
whatever the registry holds. A test pins both renderings and an approved `@1` draft
verifying after `@2` landed. Those four drafts move to `@2` when step 3 re-composes them.

Mutation-checked: renaming `@1` in the registry fails both `@1` tests.

---

## 10. Open questions — carried forward (F6 additions so far)

1. **Paribus is Ramp.** The `Paribus` company row has canonical domain `ramp.com`
   (yc-oss lists it Acquired, website `ramp.com`), and two provider-`valid` contacts at
   `@ramp.com` hang off it, now verified. A draft to them would say "Paribus". It is the
   `tempo.fit` shape (F5-HANDOVER §4.7) arriving from the seed index rather than from
   board detection. Not exposed in the pilot — Paribus has no qualified lead — but the
   row is wrong. No action taken in F6, by operator instruction.
