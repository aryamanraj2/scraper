# F5b — the posting body reaches the matcher

A small gated milestone between F5a and F6. Written 2026-09-12.
`MILESTONE_STAGE` is unchanged at `F5`: nothing here touches sending.

## 1. Why this exists

F5a fixed the database boundary. `Opportunity.description` exists and 2,528 rows
carry a body. Nothing read it. `src/intel/scoring/collect.ts:144` was still:

```ts
const text = [o.title, o.location].filter(Boolean).join(' — ')
```

So 188 of 4,615 opportunities carried a role track, 5 of them `ios_android`, and
zero of 57 qualified leads landed on that track — while the corpus held "Senior
iOS Engineer", "Software Engineer II, iOS, Growth" and "Senior/Software Engineer
II, Android" in plain text nobody was reading.

## 2. What shipped

| # | Item | State |
|---|---|---|
| 1 | `TextField.weight`, and the body as its own field | Built, measured, run |
| 2 | The title nominates, the body corroborates | Built |
| 3 | `ScoreVersion` bumped to `f5b-v2` | Built |
| 4 | `intel:run -- --seeded` | Built — see §6 |
| 5 | Allow entries for the 7 `host_denied` redirect targets | Built |
| 6 | What Indian companies actually use | Measured — see §8 |

600 tests, typecheck and lint clean, `verify:f0` through `verify:f5` green.

## 3. The weight, and why it is not a concatenation

The brief's instruction was to feed the body as its own `TextField` rather than
appending it to the title, and it was right for a reason worth writing down.

`confidenceFrom(specificCount, genericCount, negativeCount)` counts **distinct**
phrases. That is a fair measure of evidence only when the fields being counted
over are of comparable length and comparable density. A posting title is a dozen
words, every one of them about the job. A body in this corpus has a median length
of **6,152 characters** and a 90th percentile of **10,374**, most of it a company
overview, a benefits list and an EEO statement — text about the employer, printed
identically on every posting on the board. It will contain a track's whole
vocabulary by accident.

So `TextField` gains an optional `weight`, defaulting to 1, and `matchTrack`
credits a phrase **once, at the weight of the best field it was found in**. Best
rather than summed: "Swift" in a title and "Swift" again in that posting's body is
one fact restated, and summing would reward exactly the repetition
`confidenceFrom` was written to ignore.

Everything written before this change — titles, tag lists, ~500-character page
excerpts — is at weight 1, so the pre-F5b path is byte-for-byte the function it
was. There is a test pinning that.

### `POSTING_BODY_WEIGHT = 0.3`, measured not chosen

Run against all 2,528 real bodies:

| body weight | postings labelled (of 4,615) | title-labelled postings that FLIP | `ios_android` flips |
|---|---|---|---|
| title only | 453 | — | — |
| 0.2 | 750 | 10 of 265 | 0 |
| **0.3** | **1,064** | **19 of 265** | **0** |
| 0.4 | 1,337 | 27 of 265 | 0 |
| 1.0 | — | the body simply wins | — |

At 0.3, 246 of the 265 postings whose title alone already produced a label keep
exactly that label, and the 19 that move all move across the **swe/sde** boundary,
which shares one resume file (`backend.pdf`). 611 postings whose title says only
"Software Engineer II" gain a label they could not otherwise have had.

At the company level the effect is a lift, not a saturation. Median top-track
confidence over the 53 companies that hold bodies moves **0.55 → 0.71**, and *no*
company reaches ≥0.9 on all four tracks at any weight or cap tested. The "confident
garbage" failure the brief warned about does not appear, for a structural reason:
crediting each phrase once bounds a track's total at its vocabulary size.

## 4. The rule the measurement did not cover

The weight damps the body. It does not stop the body deciding, and there is one
place where the body must not decide.

`Opportunity.roleTrackId` is what F3 selects a resume against.
`ORCHESTRATOR-HANDOVER.md` §2 records that 16 packets once handed an iOS resume to
generalist roles — this is the same failure with the arrow reversed. An
adversarially dense body (a backend COMPANY OVERVIEW with thirteen distinct
backend phrases in 400 characters) flips "Senior iOS Engineer" to `sde` **even at
weight 0.3**. It did not appear in the corpus measurement because real bodies for
mobile roles are mobile-heavy — but "it does not happen in today's corpus" is not
a property, it is a coincidence.

So `matchOnePosting` adds a second rule: **the title nominates, the body
corroborates.** A posting's primary track is chosen from the tracks its TITLE
supports, at the confidence the title and body together produce. The body can
raise that confidence and can add tracks to the list used for "does this posting
match the company's primary track" — it cannot take the primary slot from a track
the title named.

A title with no specific vocabulary nominates nothing, and there the body decides
alone. That is the 611-posting case this milestone exists to unlock.

The rule lives in `collect.ts` rather than in `matchTracks`, because it is a fact
about postings, not about text: a title is the employer's own one-sentence answer
to "what is this job". The company-level match has no equivalent authority and
does not get the rule.

## 5. The ScoreVersion bump — yes, and this is why

**`f2-v1` → `f5b-v2`. Weights, thresholds and `maxRiskDeduction` are byte-identical.**

A11's freeze is untouched. No weight was re-tuned. What moved is the derivation of
the inputs, in three places:

- `role_fit` reads `match.matches[0].confidence`, which now has body evidence in it.
- `hiring_signal` reads `relevantOpenRoles`, which counts open postings whose own
  text matches the primary track. Postings carrying a track went 453 → 1,064
  corpus-wide, so this count moves for most companies with a board.
- `internship_feasibility` and `geography` read `countTerms` over the field text,
  which now includes bodies. An internship or a remote policy stated in a job
  description was previously invisible.

`scoreCompany` is still pure and still deterministic. But the same company, with
no new row fetched, now scores differently — and `AuditLog` records the version
label against every `score.computed`. Leaving the label at `f2-v1` would put two
different totals for one company under one version label in the audit trail, which
reads as a scorer that is not deterministic, and would make A11's "review the
reason codes rather than tune the weights" impossible to do honestly: an operator
comparing this week's reasons against last week's would be comparing two different
functions labelled as one.

A1's replay is unaffected either way — `reconstructTotal` works off the stored
components — which is precisely why the bump is cheap. It costs one row.

`SCORE_VERSION_V1` stays exported and stays frozen; it is what historical `f2-v1`
audit rows replay against. Call sites that mean "the current weight set" now read
`ACTIVE_SCORE_VERSION`.

## 6. `--research 170` would have researched the wrong 170

The brief asked for a live pass over "the 170 companies seeded from
`data/company-seed.csv` which are normalized with no research". That is not what
`--research 170` does, and after step 1 it could not have been:

- `intel:run`'s research pass selects `insufficient_evidence` companies
  **oldest-first**, then everything else oldest-first. The corpus is 1,975 yc-oss
  companies ingested before the seed file existed, so all 170 fetches would have
  landed on yc companies.
- After the free re-score in step 1, **no company is `normalized` any more** —
  every one is `researched` or `insufficient_evidence`. The status the brief
  selects on had already been consumed by the run that precedes it.

So `intel:run` gained `--seeded`. The discriminator is the Evidence row, not the
tag: `ingest:seed --from-file` writes `fetchedVia: 'user_hint'` for every field it
takes from the file and is the only writer that does. A `seed-*` tag identifies the
same 188 rows today, but a tag is a value a later source could also write.

The run was `npm run intel:run -- --research 170 --seeded`.

## 7. The runs, in the order they were made

### Step 1 — `npm run intel:run`. Free, no network, no credits.

```
Score version: f5b-v2 (weights sum to 100, thresholds {"queue":70,"research":55})
Scored 471 of 2145 companies (1674 refused as insufficient_evidence)
  queue 99 · research 13 · reject 359 · min 0, median 29, max 95
```

| | before | after | delta |
|---|---|---|---|
| opportunities with a `roleTrackId` | 188 | **1,064** | +876 |
| — `ios_android` | 5 | **38** | +33 |
| — `ai_engineer` | 49 | 362 | +313 |
| — `sde` | 59 | 320 | +261 |
| — `swe` | 75 | 344 | +269 |
| qualified leads | 57 | **99** | +42 |
| — `ios_android` qualified | **0** | **4** | +4 |
| companies scored | 358 | 471 | +113 |

**The milestone's question was answered before a single credit was spent.** Four
`ios_android` qualified leads exist:

| company | score | primary-track reason |
|---|---|---|
| `ouraring.com` | 89 | 7 specific terms: android, ios, kotlin, mobile app, mobile engineering, swift, ui |
| `fireblocks.com` | 87 | 8 specific terms: android, ios, kotlin, mobile app, mobile engineer, … |
| `duolingo.com` | 84 | 4 specific terms: android, ios, kotlin, swift |
| `dyneti.com` | 72 | 2 specific terms: android, ios |

The 38 `ios_android` postings sit at 11 companies: duolingo (11), n26 (5),
eightsleep (4), ouraring (4), sentry (4), sarvam.ai (3), fireblocks (3), and one
each at amplitude, linear, monzo, cohere.

**A ceiling worth knowing.** Only **38 of 4,615** postings in this corpus mention
iOS, Android, mobile, Swift, Kotlin, Flutter or React Native **in the title at
all**. `ios_android` is small because the corpus is a US-accelerator-shaped corpus,
not because the matcher is failing. Widening `ios_android` means a different
source, not a different weight.

### Step 2 — `npm run intel:run -- --research 170 --seeded`. LIVE.

```
Researching 170 companies seeded from data/company-seed.csv (LIVE, through FetchPolicyGate)
  static_fetch:stored=126  static_fetch:unusable=21  static_fetch:refused=12
  read_ats_board=4  none=7
Scored 523 of 2145 companies (1622 refused)
  queue 99 · research 14 · reject 410
```

Cost: **200 credits, 6,508 → 6,708 of 50,000.**

**It reached no new `ios_android` qualified lead, and no new qualified lead at
all.** 52 more companies became scoreable (471 → 523) and every one of them landed
in `reject` or `qualifying`. The four `ios_android` leads are step 1's, obtained
free.

Of the 188 seed-file companies: 105 now `researched`, 83 still
`insufficient_evidence`. 45 are qualified, 5 qualifying, 55 rejected.

**India, specifically.** 71 seeded Indian companies: 25 `researched`, 46
`insufficient_evidence`. Three are qualified — `sarvam.ai` (89, swe),
`paytm.com` (85, ai_engineer), `fi.money` (87, sde) — and two are in the research
band, `razorpay.com` (67) and `cashfree.com` (55, `ios_android`). The remaining 20
that scored at all landed at 29–45, well under the 55 floor. The seed file moved
India from 0 qualified leads to 3, out of 99.

The 12 static-fetch refusals were `zomato.com`, `myntra.com`, `sliceit.com`,
`madstreetden.com`, `gupshup.io`, `kukufm.com`, `whoop.com`, `neon.tech`,
`timescale.com`, `rungalileo.io`, `runwayml.com`, `meliopayments.com`.

### Step 3 — `npm run contacts:curate -- --all --max-pages 5`. LIVE. Last.

Run last on purpose, per the brief: curation only touches qualified leads, so
running it first would have re-measured the same 57 US/YC companies. It ran
against 99, of which 42 were new.

99 companies, ~2.5 minutes each (five paths at the 5-second same-host spacing,
times redirect hops). **207 credits, 6,708 → 6,915**, shared with the §8 probe that
ran alongside it.

```
  companies attempted      100
  pages actually read for   99
  cut short by the cap       2   <- under-measured, NOT zero-yield
  walked to the end         97
  with at least 1 contact   17
  with a ROLE ALIAS         17 (17 of the fully walked)
  yielded zero              82
  total contacts            17
  by page kind             {"careers":11,"footer":3,"contact":2,"other":1}
  by contact type          {"careers_alias":14,"talent_alias":3}
  executives rejected        0
  refusals by reason       {"injection_detected":9}
```

Pages actually read per company: 5 for 19 companies, 4 for 27, 3 for 23, 2 for
13, 1 for 15, 0 for 2. The raised cap did its job.

**The bounds, as a floor and a ceiling:**

- Rating all 99 measured companies gives **17%** — a FLOOR, because 2 were never
  fully asked.
- Rating the 97 walked to the end gives **18%** — a CEILING, because the curator
  stops on its first hit, so yielding is partly a *cause* of being fully walked
  and the fully-walked subset is biased upward by construction.

**The two bounds are one point apart across 99 companies.** That is the
difference between this run and F5a's: there, 42 of 56 were cut short and the
floor and ceiling were 25% and 50%. Here the measurement closed.

**The number moved down, not up.** F5a recorded 25% as the figure the vendor
decision rested on, and said it was not a measurement. Measured properly — cap
raised, five paths, 99 companies — it is **17%**. Asking the question more
completely made the answer worse, which is the opposite of what a truncated
sample usually does and is worth stating plainly: the 42 newly qualified
companies contributed 3 contacts between them.

Every one of the 17 is a role alias. Zero named individuals, zero executives
offered and rejected. 14 `careers_alias`, 3 `talent_alias`. Mean, median and max
contacts per company are all 1 — no company published more than one route.

**The verdict text still says NO VERDICT**, because it refuses whenever any
company was truncated and 2 were. That logic was left alone deliberately.
Collapsing two converged bounds into "buy" or "don't buy" is the vendor decision
itself, and it is the operator's, not this milestone's. What the milestone owes
is the number, and the number is 17–18%.

#### One report defect fixed on the way

`companiesTruncatedByBudget` counted `budget_exhausted` refusals over the whole
audit log, so truncation was permanent: a company cut short under F4's cap of 20
stayed truncated after F5a raised the cap to 200 and this run walked it to the
end. The report first printed **44 of 99** and refused a verdict on that basis —
declining to answer a question it had just finished answering. It now counts only
refusals belonging to the company's latest walk, and prints 2.

F5a §5 added that counter so a yield would not be quoted from pages nobody
fetched. Left as it was it produced the mirror error, discarding a measurement
that had actually been made.

**Still stale, and left as a carry-forward:** the `preflight refusals` line is
unscoped in time and still reads `budget_exhausted: 100` next to `cut short by
the cap 2`. Those are not in conflict — one is all-time, one is this walk — but a
reader cannot tell that from the output.

## 8. What Indian companies actually use

### The free query could not be answered, and that is itself the finding

The brief asked for the `no board signature` failures to be queried "against their
stored careers URLs". **There are no stored careers URLs.** `Company.careersUrl` is
null for every one of them — detection failing is precisely what stops it being
written — and the corpus holds `company_page` Evidence for 2 of the 80. The ATS
detector keeps no copy of a page it could not read a signature from: the only
residue is `AuditLog.metadata.attempts`, which records *the URL tried and the cause*,
and nothing of the page.

The operator's own `ats_guess` column is no help either: of 71 Indian rows in
`data/company-seed.csv`, **65 say `unknown`**, 5 say greenhouse and 1 says custom.

So the question was answered by re-reading the pages. Read-only, through
`FetchPolicyGate`, against a wide vendor list used **for reporting only** — no
`Company.atsSlug` is written, no Evidence is stored, no adapter is built. 108
companies, 86 of them read successfully, output in
`data/india-ats-probe-report.csv` (git-ignored, it is run output). It ran alongside
step 3 — zero host overlap with the 99 qualified companies, verified before
starting — so its credit cost is not separable from step 3's in the global counter;
the two together spent 207.

Two counts, because they answer different questions: **80** companies where
`no board signature` was the *governing* cause under F5a's precedence order (F5a
reported 81; the one-row difference is a company whose detail string leads with a
different cause), and **108** companies where at least one attempt returned
`no board signature`. The probe used the second.

### The answer

**57 Indian companies read. Zero Greenhouse. Zero Lever.**

| vendor | n | companies |
|---|---|---|
| **Darwinbox** | **5** | leadsquared, darwinbox, pharmeasy, unacademy, porter |
| Keka | 2 | jupiter.money, zluri |
| TurboHire | 2 | navi, setu |
| Freshteam | 2 | haptik, locus |
| Workday | 2 | browserstack, uniphore |
| Recruiterbox / Trakstar | 2 | whatfix, moengage |
| `mailto:` and nothing else | 2 | cashfree, nykaa |
| LinkedIn jobs link | 2 | chargebee, vedantu |
| Ashby | 1 | atlan |
| SmartRecruiters | 1 | freshworks |
| param.ai | 1 | practo |
| Wellfound | 1 | decentro |
| Google Form | 1 | vedantu |
| **no vendor string at all** | **24** | custom portal, or JS-rendered |
| unreadable | 10 | |

Against 51 non-India companies from the same failure set: Greenhouse 3, mailto 2,
and one each of Lever, Ashby, Workable, Phenom, Eightfold, Notion, Typeform — with
28 showing no vendor string.

### What it means

**B7's sentence needs amending a second time.** F5a corrected it from "no public
feed exists" to "the vendor forbids automated access". Neither is the shape of the
problem here. The problem is that **Indian companies are on a different set of
vendors entirely** — and the largest of them, Darwinbox, is India-native, which is
exactly the category B7 said did not exist.

**Darwinbox is the adapter to scope next**, and it is the only one the data
nominates: 5 of the 33 Indian companies where any vendor was identifiable, against
2 each for Keka, TurboHire, Freshteam and Workday. It is also the one whose
customer list is Indian by construction, so an adapter compounds with every future
India source rather than only serving these five.

**But 24 of 57 published no vendor string at all**, which no adapter reaches. That
is the larger group, and it is the honest ceiling on how far ATS detection can go
in India. Whatever India source F5a carry-forward #3 buys — Adzuna, data.gov.in —
it is not made redundant by a Darwinbox adapter.

**No adapter was built.** The brief said not to, and the probe deliberately writes
nothing: this is the input to the decision, not the decision.

## 9. Not done, deliberately

- **No lookup provider.** Tier B is still a seam. No vendor, no key, no host
  entry, no live call.
- **No pattern inference.** Still `CONTACT_ALLOW_PATTERN_INFERENCE=false`.
- **No SmartRecruiters.** Closed on robots; F5a §3 records the finding.
- **No adapter for Workday, Workable or param.ai.** The allow entries let
  detection record the vendor. Nothing parses their payloads.
- **No `MILESTONE_STAGE` change.** Still `F5`.
- **No backfill of `Opportunity.description`** over the 2,087 rows that predate
  F5a. Unchanged from F5a carry-forward #2.

## 10. Live state after this milestone

```
companies      2,145   (523 researched, 1,622 insufficient_evidence)
opportunities  4,615   (2,528 with a body, 1,064 with a role track)
qualified      99      (swe 38, ai_engineer 31, sde 26, ios_android 4)
contacts       17      (all role aliases, all page_published)
credits        6,915 / 50,000
MILESTONE_STAGE  F5, unchanged
```

Credits spent this milestone: **407.** Step 1 was free.

## 11. Carry-forwards

1. **The Hunter decision is now unblocked.** Tier A's measured yield is **17%
   floor, 18% ceiling** across 99 companies, with the bounds converged and every
   contact a role alias rather than a person. The tool refuses the verdict on a
   technicality (2 truncated companies); the number itself is no longer in doubt.
   `verdictFromRate` would place 17% in its lowest band. Read a vendor's terms
   before the seam is exercised — `handover.md` §1.2 as amended.
2. **Scope a Darwinbox adapter.** §8: 5 of the 33 Indian companies where a vendor
   was identifiable, against 2 each for Keka, TurboHire, Freshteam and Workday,
   and zero for Greenhouse and Lever. It is India-native, which is the category
   B7 said did not exist. Check for a public unauthenticated feed and read robots
   first — SmartRecruiters is the cautionary case (F5a §3).
3. **India still needs its own source**, and §8 sharpens why rather than
   replacing it: **24 of 57** Indian companies published no vendor string at all.
   No adapter reaches those. Adzuna or data.gov.in, as its own gated
   mini-milestone.
4. **Backfill `Opportunity.description`** for the 2,087 rows that predate F5a.
   Unchanged from F5a #2 and now worth more: the body is read, so every backfilled
   row is a posting that can carry a track. Needs a forced re-read; a plain
   `--postings-only` pass reports `content_unchanged` and writes nothing.
5. **Split the research budget counter.** Unchanged from the F5 handover and now
   three milestones old. A free static fetch and a paid vendor credit still share
   one envelope, and F5b spent 407 of it on fetches that cost no money.
6. **Scope `preflightRefusalsByReason` in time**, the way
   `companiesTruncatedByBudget` now is. It prints an all-time count beside a
   per-walk one with no way for a reader to tell them apart (§7, step 3).
7. **The `ios_android` ceiling is the corpus, not the matcher.** Only 38 of 4,615
   postings mention a mobile technology in the title. Four qualified leads is
   close to everything this corpus contains. More mobile leads means a source that
   indexes mobile employers, not another weight.
8. **`List-Unsubscribe: <mailto:...>`** in `src/outreach/mail/mime.ts` — the one
   remaining opt-out gap the operator named for F6. Not touched here.

## 12. Amendments to earlier documents

- **B7, second amendment.** F5a corrected "no India-native ATS exposes a public
  feed" to "the vendor whose feed they use forbids automated access". §8 shows
  neither is the shape of the problem: Indian companies are on a **different set
  of vendors**, led by **Darwinbox**, which is India-native. The practical
  conclusion is unchanged — India needs its own source — but the reason on record
  was wrong twice.
- **`ORCHESTRATOR-HANDOVER.md` §7 carry-forward 2** ("store the Greenhouse posting
  body") is now fully discharged for new and changed postings. F5a stored it; F5b
  reads it. The backfill (#4 above) is what remains.
- **F5a §5's 25%** should not be quoted again. §7 step 3 supersedes it with 17–18%
  measured over 99 companies.
