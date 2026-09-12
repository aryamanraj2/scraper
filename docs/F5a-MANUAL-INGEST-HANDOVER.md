# F5a — manual ingest and operator-entered contacts

A small gated milestone between F5 and F6, not a full F-milestone. Written 2026-09-12.
`MILESTONE_STAGE` is unchanged at `F5`: nothing here touches sending.

## 1. Why this exists

The corpus was yc-oss only. 1,548 of 1,975 companies ended at `insufficient_evidence`,
and **zero of 57 qualified leads landed on the `ios_android` track**, so two of the
operator's four resumes had never once been selected. Widening the yc feed does not fix
that — `--feed all` is thirteen times the same US accelerator index. A different kind of
source does.

Cold email is the primary path and the target is contacts in the hundreds. Tier A
yielded 14.

## 2. What shipped

| # | Item | State |
|---|---|---|
| 1 | `ingest:seed -- --from-file <csv>` | Built, tested, run live |
| 2 | SmartRecruiters adapter | **Dropped.** See §3 |
| 3 | `contacts:import -- --file <csv>` | Built, tested |
| 4 | `run-contacts` yield denominator | Corrected — differently from how it was specified. See §5 |
| — | `Opportunity.description` | Added. See §4 |
| — | Per-company credit cap for qualified leads | Raised 20 → 200 (57 rows) |

588 tests, typecheck and lint clean, `verify:f0` through `verify:f5` green.

## 3. SmartRecruiters is closed to us, and B7 needs amending for a different reason

The milestone brief was right that the SmartRecruiters Posting API is public and
unauthenticated, that Indian companies at scale use it, and that B7's *"no India-native
ATS exposes a public feed"* leads to a wrong conclusion. SmartRecruiters is not
India-native and its feed is public.

It is still unreachable. `https://api.smartrecruiters.com/robots.txt` returns **200**
with:

```
User-agent: LinkedInBot
Allow: /v1/companies/

User-agent: *
Disallow: /
```

That is not a default and not an accident: they opened the exact path an adapter would
use to one named partner and closed it to everyone else. `FetchPolicyGate` refused it
live with `robots_disallowed`, which is non-negotiable #3 working as designed. Reading
it anyway would need a robots override, which would amend #3 and would be evasion under
`handover.md` §1.5.

The operator was given the choice with the evidence and chose to drop it.

Also checked, in case another host served the same data:

| Host | robots.txt | Result |
|---|---|---|
| `api.smartrecruiters.com` | 200, `Disallow: /` for `*` | Refused |
| `jobs.smartrecruiters.com` | 404 — no rules published | 301 away |
| `careers.smartrecruiters.com` | 200 but serves HTML (soft 404) | 302 to `careers.swiggy.com/#/`, a SPA on the customer's own domain |

**So B7's sentence should be amended to state the true obstacle**: it is not that no
public feed exists for Indian companies, it is that the vendor whose feed they use
forbids automated access to it. The practical consequence is the same and the next move
is unchanged — India needs its own source (Adzuna or data.gov.in) as its own gated
mini-milestone, per carry-forward #4.

## 4. The posting body is now stored

`Opportunity.description`, migration `20260912061138_opportunity_description`.

This was scoped in the brief as a property of the SmartRecruiters adapter — *"store the
body, do not repeat F1's mistake of keeping only the title"* — with the Greenhouse
carry-forward deferred to a later milestone. With the adapter dropped, doing nothing
would have meant item 1 attaching postings for ~170 newly seeded companies **and
discarding every body**, reproducing F1's mistake on fresh data inside the milestone
that named it. So the column landed here.

What it changes:

- All three existing adapters already returned the body. Greenhouse inlines it with
  `?content=true`, Lever as `descriptionPlain`, Ashby as `descriptionPlain`. Only the
  database boundary discarded it.
- `postingContentHash` has always included `content`, so **nothing churns and nothing
  backfills**. A posting whose content has not moved is still `content_unchanged`. The
  2,086 rows ingested before the column existed stay null until their board is next
  refreshed with an actual change.
- An adapter with no body writes `null`, not `''`, so "the board published nothing"
  stays distinguishable from "we did not ask".

Carry-forward #2 is therefore **half done**: new and changed postings now carry a body;
the existing corpus does not. Backfilling it means a `--postings-only` pass that forces
a re-read, which nothing currently does.

## 5. The yield denominator — the brief's diagnosis was wrong, the instinct was right

The brief said `run-contacts` prints "56 of 58 companies had a page read" when the real
number is ~45, and asked for the count to be companies with ≥1 page read.

**It already counted exactly that, and 56 is correct.** The audit log has 58 distinct
`contact.curated` subjects, 56 with `pagesRead > 0`, and the two at zero are Bitmovin
and GiveCampus — the two the brief itself names. No code change would have produced 45.

But the number was still being mis-quoted into the buy/don't-buy decision, for a reason
one level down. Of those 56 measured companies, **42 had their path walk cut short by
our own per-company research cap**, not by the employer running out of pages. The
curator tries up to five paths and stops on `budget_exhausted`, which is correct — there
is no headroom and every further page costs more — but a company refused at `/contact`
because its 20-credit envelope ran out has not been asked the question the report claims
to answer. Calling it zero-yield states a fact about the employer on the strength of a
page we declined to fetch. That is the same error `companiesMeasured` was introduced to
prevent, one level in.

**And the obvious repair is a second wrong number.** The curator stops the moment it
finds a recruiting route, so a company that yields on `/careers` spends one credit and
can never be truncated, while a company that yields nothing keeps walking until the cap
stops it. Yielding is a *cause* of being fully walked, so the fully-walked rate is
biased upward by construction.

So the report now carries both bounds and refuses the verdict:

```
  companies attempted      58
  pages actually read for  56
  cut short by the cap     42   <- under-measured, NOT zero-yield
  walked to the end        14   <- biased towards yielders; see the verdict
  with a ROLE ALIAS        14 (7 of the fully walked)

  VERDICT: NO VERDICT — the yield has not been measured. ... Rating all 56 gives 25%,
  which is a FLOOR ... Rating the 14 walked to the end gives 50%, which is a CEILING ...
  Raise the per-company credits cap and re-run the curator before quoting a rate to a
  vendor decision.
```

**The practical consequence: the 25% that F4 reported, and the "Tier A cannot reach the
target at any plausible corpus size — buy a vendor" verdict that followed from it, is
not a measurement.** The cap is now 200 for every qualified company. Re-running
`contacts:curate --all` is what produces a number worth quoting, and it should happen
before any vendor money moves.

## 6. `--from-file`, in detail

```
npm run ingest:seed -- --from-file data/company-seed.csv
npm run ingest:seed -- --from-file data/company-seed.csv --seed-only
npm run ingest:seed -- --from-file data/company-seed.csv --report out.csv
```

Header: `name,domain,hq_country,headcount_band,tracks,ats_guess,notes`. Required:
`name,domain`.

It is a different **source**, not a different pipeline. Canonicalization, the
`Evidence`-per-field rule, `ensureDerivedCompanyHost`, `ensureCompanyResearchBudget`,
ATS detection and the posting ingest are all the existing code, unchanged.

### Decisions worth knowing

**It is a hint, and is written as one.** `Evidence.sourceType` is `user_hint`,
`fetchedVia` is `user_hint`, confidence is **0.5** — one notch below yc-oss's 0.6, on
the grounds that yc-oss at least has a publisher who could be wrong in public. Nothing
from this file is citable without re-verification.

**`ats_guess` is never written to `Company.atsSlug`.** The detector decides. The guess
is kept on its own `Evidence` row, and the run reports where the two disagreed — which
is the only thing a guess is good for.

**No `CompanySignal` is written.** `CompanySignalType` is a closed enum of things
*observed* about a company — `yc_profile`, `careers_page`, `job_posting`. A typed line is
none of them, and filing it under the nearest value would put a false claim about origin
into the table the scorer reads.

**The upsert only ever adds** (`upsertOperatorSeededCompany`). Eighteen of the 188 rows
were already in the corpus, some already scored. The yc upsert writes the whole yc field
set every pass and resets `status` to `normalized`; running it over these rows would have
blanked `ycBatch`, `ycOneLiner`, `teamSize` and `ycStatus` with nulls the file does not
have, and reversed F2 and F3's work. So: `status` on create only, `website` filled only
when absent, `displayName` never overwritten, `countries` and `tags` unioned, `ycId`
never claimed.

**`tracks` and `headcount_band` land on `Company.tags`**, namespaced `seed-track:` and
`seed-headcount:`. They are on the Company rather than only on Evidence because the whole
point of `tracks` is to answer *"which of these should have produced an `ios_android`
lead and did not"*, and that is a query.

**Detection is scoped to the file's companies**, not the corpus. The corpus-wide pass
re-attempts every previously-failed company, which at 2,145 companies is hours of
requests that teach nothing.

**A failed detection is a finding.** About 120 of the 188 domains have never been
verified against anything, so a detection failure is the expected signal for a typo. Every
one is reported with its cause, to stdout and to `data/seed-ingest-report.csv` (git-ignored;
it is run output). Causes seen live include `HTTP 403`, `robots_disallowed`,
`no board signature` and `Headers Overflow Error` — four different problems that a
"dropped 120 rows" summary would have flattened into one.

### Seed result, live

```
seen 188, created 170, updated 18, unchanged 0, skipped 0
companies 1,975 -> 2,145
India per-company envelopes at 45 credits (H5): 70
```

## 7. `contacts:import`, in detail

```
npm run contacts:import -- --file data/contacts.csv
npm run contacts:import -- --file data/contacts.csv --provider apollo.io --dry-run
```

Header: `domain,email,full_name,title,contact_type,provider,source_url,notes`. Required:
`domain,email`.

**This is Tier B's data without Tier B's integration.** No request is made, no vendor
terms are accepted by this code, no host allow entry exists and no provider seam is
exercised. A person read Apollo's free tier in a browser and typed the results.

Consequences, all deliberate:

- `verified = false` on every row, always. An unverified contact opens **no** outreach
  case, so importing a thousand of these cannot cause a single send. That is what makes
  the path safe to have.
- `discoveryMethod = 'lookup_provider'`, `sourcePageKind = null`. Null rather than
  `other`, so an imported row cannot enter the Tier A yield report as if a page had been
  read — the report filters on `page_published`, and there is a test pinning that.
- The `Evidence` row cites **the provider and the operator**, not a page:
  `operator-entry://apollo.io/<operator>`. Deliberately not an `https://` URL — every
  other value in that column is something this system fetched, and a provider's
  marketing URL there would claim a fetch that never happened. The excerpt is the
  operator's own CSV line, verbatim, which is the whole of what the source said. Any
  provider link the operator noted travels inside that quote.
- Confidence 0.5.

Three refusals, each reported rather than dropped:

- **Executive** — every row goes through `isExecutiveContact`, title and local part.
  `handover.md` §1.1 is not amended by anything in this milestone. The refused address is
  not recorded anywhere, including the audit row, for the same reason `curate.ts` does
  not record it.
- **Off-domain** — a `gmail.com` address is a personal account, another company's is
  someone else's employee. A provider export contains more of both than a careers page.
- **Unknown company** — a domain not already in the corpus is reported, not created.
  Inventing a Company from a contact list produces a row with no research, no score and
  no evidence, existing only to hold an address. Seed first.

`named_employee` **is** accepted here, where Tier A refuses it. Not an inconsistency:
Tier A refuses it because an address found loose on a company page is as likely to be a
support desk as a person, and Tier A stores recruiting routes only. A row on this list is
a named individual the operator looked up on purpose, and the F4 amendment made any
current employee valid — founders, CEOs, C-suite and VPs excluded, which is the executive
filter's job and runs first.

`data/contacts*.csv` is git-ignored. `origin` is a public GitHub repository, and A10
requires a contact to be erasable; a copy in git history is the one place an erasure
cannot reach.

## 8. Other changes

**The CSV reader** (`src/ingest/file/csv.ts`) is hand-written, ~60 lines, no dependency.
The failure it exists to prevent is a quoted comma shifting every column after it, which
in these two files surfaces as a *wrong domain* or a *wrong email address* rather than as
an error. A row whose field count does not match the header is reported with its line
number, never padded or truncated.

**`SeedLoaderOptions.upsert`** is a new seam on `runSeedIngest`. Canonicalization, the
within-run duplicate check, the skip accounting and the audit trail are identical for
every seed source; what differs is which columns a source may write. The yc path is
byte-for-byte the code it was.

**`CompanySeed.origin`** (`'yc' | 'operator_file'`, defaults to `'yc'`) is the
discriminator that decides Evidence `sourceType` and whether `ycId` is claimed.

## 9. Not done, deliberately

- **No lookup provider integration.** Tier B is still a seam. No vendor, no key, no host
  entry, no live call.
- **No pattern inference.** Still `CONTACT_ALLOW_PATTERN_INFERENCE=false`. The next
  milestone needs the `Contact` row to record *which confirmed address a pattern was
  derived from*, so one bounce invalidates the whole derived set — there is no column for
  that yet.
- **No `MILESTONE_STAGE` change.** Still `F5`.
- **No backfill of `Opportunity.description`** over the existing 2,086 rows.

## 10. Carry-forwards, updated

1. **Re-run `contacts:curate --all` now the cap is 200.** The 25% Tier A yield is not a
   measurement and the vendor decision currently rests on it. This is the cheapest
   high-value action available and it blocks the Hunter decision.
2. **Backfill `Opportunity.description`** for the existing corpus. Needs a forced
   re-read; a plain `--postings-only` pass will report `content_unchanged` and write
   nothing.
3. **India still needs its own source.** SmartRecruiters is closed (§3). Adzuna or
   data.gov.in, as its own gated mini-milestone, never bolted into another.
4. **Re-score the 170 newly seeded companies.** They are `normalized` with no research;
   `intel:run` is what moves them, and whether any reaches the `ios_android` track is the
   question this milestone was built to answer.
5. **Split the research budget counter** — unchanged from the F5 handover, and §5 is what
   it costs when a free static fetch and a paid vendor credit share one envelope.
