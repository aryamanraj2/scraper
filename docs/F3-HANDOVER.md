# F3 Handover — The Application Funnel

**Written:** 2026-09-09, at the end of the F2 session.
**For:** the next implementation session, which builds F3 and nothing else.
**Status of the repo when this was written:** F2 complete, 7/7 exit criteria met, 300 tests passing, F0+F1 committed (2 commits on `main`), F2 uncommitted.

---

## 0. Read these first, in this order

| File | What it is | Binding? |
|---|---|---|
| `handover.md` | The original brief. **§1's non-negotiable policies are binding and are not restated anywhere else.** | Yes, except where the plan overrides |
| `docs/architecture-plan.md` | The approved architecture plan, verbatim. Defect ids (A1–A12), verification ids (B1–B7), design (Part D), build order (Part F), tests (Part G), decisions (Part H). | **Yes — this is the implementation contract** |
| `docs/F1-HANDOVER.md` | What F0 built, F0's nine deviations, and the F1 task. Its §4 deviations are all still in force. | Yes |
| `docs/F2-HANDOVER.md` | What F1 built, F1's fifteen deviations, and the F2 task. Its §4 deviations are all still in force. | Yes |
| `docs/F3-HANDOVER.md` | This file. What F2 actually built, every deviation from the plan and why, and the F3 task. | Yes |
| `docs/handoff-llm-gateway.md` | How the LLM role works. **Now describes the gateway as BUILT**, with an "as built" section recording what implementation resolved. | Yes |
| `README.md` | Setup and the things that bite. | Informational |

Do not redesign the plan. Do not weaken its safeguards. Do not introduce scraping of gated platforms. Do not substitute unverified data sources for verified ones.

**Never edit `docs/architecture-plan.md`.** It is the original contract, reproduced verbatim so it stays auditable. Implementation decisions that depart from it are recorded in the handover for the milestone that made them — F0's in `F1-HANDOVER.md` §4, F1's in `F2-HANDOVER.md` §4, F2's in §4 below.

### The five rules that outrank convenience

Unchanged, and all five now have F0, F1 and F2 code standing on them:

1. **Never automate LinkedIn or any gated platform.** `handover.md` §1.4. Enforced at the transport layer by `FetchPolicyGate`, with tests asserting zero sockets — including that a *redirect* into a denied host is refused exactly as a direct request is.
2. **Never infer an email address, and never target founders/CEOs/executives.** §1.1, §1.2. **F2 still creates no `Contact` rows at all; F4 is the first milestone that may.** F3 creates none either — an `ApplicationPacket` needs no contact.
3. **Every network request goes through `FetchPolicyGate`.** No exceptions. The AST scanner fails the build. F2 added a POST path (§4.5) and it runs the identical preflight.
4. **Sending stays hard-disabled until F5** — enforced by `MILESTONE_STAGE` in source, not just an env var. It now reads `'F2'`; `resolveSendingEnabled()` still returns false.
5. **Provenance on every fact.** If a value in the database cannot be traced to an `Evidence` row with a verbatim excerpt and a source URL, it does not belong there. F2 extended this to page research: one row per matched track, each quoting the part of the page that justifies the label (§4.1).

---

## 1. What this system is, in one paragraph

A local, review-first system that turns a broad universe of startups into a small queue of internship opportunities across four tracks (iOS/Android, AI Engineer, SDE, SWE), prioritising India then remote-viable US/UK/EU. **The terminal action is an application, not an email** (Part C). The system prepares application packets; the user submits them by hand. Cold outreach is permitted in exactly three named cases and never sends without per-message human approval. It is deliberately not a bulk-email system.

---

## 2. Where the project stands

### F2 is complete

```
npm test          → 27 files, 300 tests passed
npm run typecheck → clean
npm run lint      → clean
npm run verify:f0 → 4/4 criteria met
npm run verify:f1 → 7/7 criteria met
npm run verify:f2 → 7/7 criteria met
```

| F2 exit criterion (Part F, F2 handover §8.5) | Evidence |
|---|---|
| Every score explainable from stored components | **69 scored leads** replayed from `score_components` + `ScoreVersion`, 0 mismatches (`verify:f2` criterion 1, run against `outreach_dev`) |
| Score sums to exactly 100 | `assertSumsTo100` runs at module load and is asserted per stored `ScoreVersion` row; the handover's own 97-point set is a test fixture that must throw |
| Research budget observably caps spend | Cap zero → `budget_exhausted` with no request issued, for both the static and Firecrawl tiers. On live data: **2 companies hit the 20-credit cap, 4 `budget_exhausted` refusals recorded** |
| Preflight refusals recorded, not retried around | Live counters: `robots_disallowed=50 host_denied=8 budget_exhausted=4 rate_limited=2`. A refusal inside the refresh window makes `nextAction` return `none` with the reason, never a retry |
| Source precedence is a hard floor | 13 policy tests; a browser task is unreachable by construction, and an unread ATS board always outranks page research |
| All F0/F1 invariants intact | `verify:f0` 4/4, `verify:f1` 7/7, AST scanner clean |
| Milestone bumped honestly | `MILESTONE_STAGE = 'F2'`; all five F2 codes driven through real paths in `test/policy/reason-code-coverage.test.ts` |

### The live corpus, after F2

The detection pass F1 left at 69 of 150 companies was **finished** (a user-approved live run), and it took ~25 minutes rather than the estimated hour — the real rate was closer to 6 companies/minute, not 1.4.

| Measure | End of F1 | End of F2 |
|---|---|---|
| Companies | 150 | 150 |
| With a detected ATS board | 20 (of 69 attempted) | **43 (of 150 attempted) — 29%** |
| `Opportunity` rows | 224 | **815** |
| `Evidence` rows | 2,199 | **3,033** (1,952 yc · 867 ats · 214 company_page) |
| `CompanySignal` rows | 166 | **359** (151 yc_profile · 52 job_posting · 140 careers_page · 16 ats_job_count_delta) |
| Scored leads | 0 | **69** |
| `LlmTask` rows | 0 | **21** (1 fulfilled, 1 rejected, 19 pending) |

**The 29% detection rate held on the full corpus.** F1 measured it on 69 companies and warned it was provisional; it is now measured on all 150 and came out the same.

### Score distribution (`ScoreVersion` `f2-v1`, thresholds queue 70 / research 55)

```
queue    (>=70)  21 leads
research (55-69)  4 leads
reject   (<55)   44 leads
                 --
                 69 scored, 81 refused as insufficient_evidence

min 28 · median 41 · max 91
```

By bucket: `20s=4  30s=26  40s=12  50s=4  60s=2  70s=12  80s=8  90s=1`.
By kind: `speculative=46  posted_role=23`. By primary track: `ai_engineer=38  swe=13  ios_android=11  sde=7`.

**Read the 81 refusals correctly.** They are not failures; they are `insufficient_evidence`, which D1 defines as re-entrant and a budget decision. They are companies whose public text describes a *product* and never an engineering stack — Stripe's "economic infrastructure for the internet", Cashfree's "next-gen digital payments provider for India". `handover.md` §5.3 forbids labelling a company from text that does not support the label, so the honest answer is "not enough evidence yet", and the company stays eligible for more research. This is the rule working, not the matcher failing.

**One number is uncomfortable and should be said plainly: exactly 1 of the 21 queue-band leads is an India company.** India is priority #1 and the corpus has only 6 Indian companies in it, because the yc-oss `hiring` feed at `--limit 150` is 123 USA companies. That is a *corpus* problem, not a scoring problem — see §8.4.

### Research spend

1,015 credits across 150 per-company envelopes (max 20, average 6.8) — all of them static page fetches. **Zero Firecrawl credits were spent**: no API key exists, so the escalation path never ran against the live vendor. See §4.7 for why that number is larger than the global cap the operator chose, and what to do about it.

### Nothing about F2 is committed

`git log` shows the two commits F0+F1 were committed in. Everything F2 wrote is in the working tree. The user commits when they choose.

### What F2 deliberately did NOT build

No `Contact`, no `ResearchBrief` rows (F2 queues the task; F3 writes the row — §7), no `Draft`, no `ApplicationPacket`, no UI, no optional adapter, no browser layer, and no Firecrawl live call.

---

## 3. Environment — read before running anything

### New pins in F2

| Package | Pin | Why this version, and why not `latest` |
|---|---|---|
| `@mozilla/readability` | `0.6.0` | `latest`, and the version Part E names. Pure extraction, no network, no install script. |
| `linkedom` | `0.18.13` | The DOM Readability runs against. **Chosen over jsdom deliberately** — see §4.2. `latest`; no install script; no transitive network client. |

Everything else is exactly as `F2-HANDOVER.md` §3 recorded it: `prisma`/`@prisma/client`/`@prisma/adapter-pg` `7.10.0`, `pg-boss` `12.30.0`, `undici` `7.29.1`, `tldts` `7.4.12`, `vitest` `4.1.11`, `typescript` `5.9.3`, `eslint` `10.10.0`, Node 22.16.0, PostgreSQL 17.

**No Firecrawl client was installed.** `@mendable/firecrawl-js` owns its own HTTP transport, and installing it would put a second network-capable client into the dependency tree reachable from research code — precisely what the three-layer ban on raw HTTP exists to prevent. The escalation is a hand-rolled request through `FetchPolicyGate.postJson` against the endpoint verified at implementation time (§4.5).

`npm audit` still reports the same 4 high-severity advisories in `prisma`'s own transitive tree (`deepmerge-ts`, `mysql2`). `npm audit fix --force` still wants `prisma@6`, which breaks pg-boss's `fromPrisma`. Left alone deliberately; neither package is a driver this project loads. **The two F2 additions introduced no new advisories.**

### Environment traps

All three from `F2-HANDOVER.md` §3 still apply — do not downgrade npm below 11.19.1; npm blocks install scripts and `package.json` carries an `allowScripts` block (neither new dependency needed an entry); and **`prisma migrate dev` does not reliably regenerate the client, so run `npm run db:generate` after any migration before trusting a test failure.**

New in F2, and worth stating because it bit twice: **`tsc --noEmit` is not run by `npm test`.** The suite passes through `vitest`, which transpiles without typechecking, so a Prisma query that is wrong at the type level runs fine in a test and fails `npm run typecheck`. `verify:f2` was written, run successfully, and only then found to be a type error. Run `npm run typecheck` before believing a tool is finished — the F1 lesson ("a green suite does not mean the CLI works") has a mirror image.

---

## 4. Deviations from the plan — every one, with its reason

F0's nine (`F1-HANDOVER.md` §4) and F1's fifteen (`F2-HANDOVER.md` §4) are all still in force and none were reverted. These are F2's. **Do not silently revert any of them; if you disagree, raise it with the user.**

Two of them (§4.9, §4.10) are latent defects in earlier milestones that F2 was the first to exercise. F1 found three in F0; the pattern continued.

### 4.1 A page becomes several `Evidence` rows, one per matched track — not one row per page

**This is the single most consequential thing F2 learned, and it was found by measuring rather than by reasoning.**

`Evidence.excerpt` is `VARCHAR(500)` and verbatim. The obvious implementation stores the first 500 characters of a fetched page. The first live research pass did exactly that: **34 careers pages stored, and the number of scoreable companies went from 50 to 52.** The pages were fine; the excerpt was the problem. The opening 500 characters of an employer careers page are a hero headline and a values statement. The sentence that says "our mobile team writes Swift and Kotlin" is four screens down and never reached the matcher, so a genuinely mobile-first company scored as a company with no engineering evidence at all.

F1 hit the same wall from the other direction (§4.4 of its handover): a yc-oss record has ~13 fields and one 500-char row cannot honestly justify them, so it writes **one row per source key**. F2 applies the identical rule to pages: one row per **matched track**, each quoting the window of the page where that track's vocabulary actually appears, plus one `head` row so a page that matched nothing still has provenance.

After the change, on the same corpus: **69 scoreable companies, 21 in the queue band.**

Three properties this preserves:
- **Every window is a contiguous verbatim slice.** Nothing is reordered, joined, or appended. Boundaries are snapped outward to whitespace so a window does not start mid-word; snapping only ever moves a boundary, never inserts a character.
- **The label is always backed by a readable excerpt**, which is exactly what `handover.md` §5.3 asks for and what F3's evidence viewer needs.
- **`contentHash` is per (page content, key)**, so a track window and the head row are distinct facts about the same fetch and neither masks the other.

One anchoring bug is worth recording because it was silent: the window was first anchored on the matched *snippet*, which carries 60 characters of context on each side. That prefix is ordinary prose, and `indexOf` found an earlier copy of it — so the window landed nowhere near the match. It is anchored on the **term** now.

### 4.2 Readability runs on linkedom, not jsdom

Part E names `@mozilla/readability`; it does not name a DOM. jsdom is the usual host and was rejected for two reasons, in this order of weight:

1. **jsdom ships an HTTP stack.** It implements XMLHttpRequest and can load subresources. In a system whose central invariant is that `FetchPolicyGate` is the only path to the network — enforced by an ESLint rule, an AST scanner and transport-level socket assertions — adding a second network-capable engine to the research path is exactly the hole those three layers exist to close.
2. jsdom 30 requires Node `^22.22.2` and this machine runs 22.16.0, so the current release is not installable here regardless.

linkedom parses HTML and does nothing else: no fetch, no XHR, no script execution. The trade is that it is not the DOM Readability is tested against, so `test/policy/page-research.test.ts` pins the behaviour we depend on: article text survives, navigation and footers are dropped, unparseable markup returns `null` rather than throwing.

### 4.3 The 15-point "public HR/Talent/careers route" component was replaced

**A user decision, taken before any scoring code was written.**

`handover.md` §6's third component is "valid public HR/Talent/careers route", worth 15. It cannot be scored in F2: `Contact` rows do not exist until F4, so the component would be structurally zero for every company — which both caps every score at 85 and calibrates a **frozen** weight set (A11) against a component that later becomes non-zero, silently changing the meaning of every historical score.

It is replaced by **"official application route exists"** — an ATS board token, or an `Opportunity.roleUrl`. Part C already made the application the terminal action, so the route that matters at qualification time is the one you apply through; B5 independently found the `careers@`-first premise unverified.

**F4 may add a contact-route component. Doing so requires a NEW `ScoreVersion` label, never an edit to `f2-v1`.**

The resulting weight set, which sums to exactly 100 (A1):

| Component | F2 | `handover.md` §6 |
|---|---|---|
| `role_fit` | 26 | 25 |
| `hiring_signal` | 20 | 20 |
| `application_route` | 15 | 15 (repurposed) |
| `internship_feasibility` | 12 | 12 |
| `geography` | 11 | 10 |
| `personalization` | 11 | 10 |
| `freshness` | 5 | 5 |
| **Total** | **100** | 97 |

The three points A1 identified as missing went to role fit and personalization: the first is the whole point of the four tracks, and the second is what F4's drafting depends on.

### 4.4 The global research envelope is a real row now, and it is `npm run seed:budget`

F0's deviation §4.3 established that the global monthly envelope is the `ResearchBudget` row with `companyId = null`. **Nothing ever created it.** `checkBudget` refuses only when a row exists, so until F2 there was no global ceiling at all: per-company caps bounded each company, and nothing bounded their sum.

`tools/seed-global-budget.ts` opens it, defaulting to 1,000 credits (Firecrawl's free tier, B6a) for the current month. An existing row is never overwritten — `creditsSpent` lives on it, and resetting a cap mid-month hands back budget already consumed.

### 4.5 `FetchPolicyGate` gained a POST path

Every F0/F1 source is a GET. Firecrawl's scrape endpoint is `POST https://api.firecrawl.dev/v2/scrape` — verified against the vendor's API reference at implementation time, along with its `Authorization: Bearer` header, its `{ url, formats, onlyMainContent }` body and its `{ success, data: { markdown, metadata } }` response.

So `rawPostJson` was added to `raw-client.ts` and `FetchPolicyGate.postJson` to the gate. **The preflight is identical** — host policy, terms, robots, rate policy and both budget envelopes, in the same order — because what the preflight protects is the host and the spend, and a host does not become fetchable by changing the verb. Two deliberate narrowings: one method and a JSON body only (there is no general request builder), and **no redirect following for a POST at all**, because replaying a request body against a host the preflight has not seen is not something this system should be able to do.

`api.firecrawl.dev` was added to `SEED_ALLOW_HOSTS` with a note. Nothing else was added to the allowlist; F1's §4.14 rule stands.

### 4.6 A failed ATS detection exhausts tier 1 rather than pinning a company there

D4's floor says a browser task can never be chosen "while an unread ATS feed exists". A company with no board token has no feed at all — and the first implementation returned `detect_ats` for it forever, which pinned all 107 boardless companies at tier 1 and starved them of the page research that is their only remaining source. That was visible immediately in a live run: the runner reported `none` for company after company that plainly needed a careers page read.

"Unread" and "absent" are different things. A recorded `ats.detection_failed` inside a 30-day window now exhausts the tier and lets tier 2 run. The window is longer than the page window on purpose: a company that publishes no board link today is unlikely to publish one next week, and detection is the expensive half of ingestion.

### 4.7 One credit unit covers both research tiers — and that has a consequence worth reading

A static page fetch and a Firecrawl plain scrape both cost **1 credit**. That is what makes Part G's proving test — "cap zero → all research no-ops with `budget_exhausted`" — true of the *whole* research path rather than only its paid half.

The consequence is that the unit conflates a free fetch with a paid one. F2's backfill spent **1,015 credits, none of them money**: every one was a static fetch, and Firecrawl was never called. The operator set the global envelope at 1,000 to match Firecrawl's free tier, and a 1,000-credit month would have blocked F2's own backfill.

Steady state is fine — 150 companies at one page each weekly is ~600 credits/month, comfortably inside 1,000 — so the cap is left where the operator set it. But **F3 should split the accounting**: a vendor-scoped counter for Firecrawl credits alongside the unified research counter, so "how much free work did we do" and "how much of the paid allowance is left" stop being the same number. The schema has room (`billedUsdSpent` is unused and sits at zero, since the handoff LLM costs nothing).

### 4.8 A delta of `null` means unknown, and is never scored as zero

B2's job-count delta needs two observations. A company whose board has been read once has no delta, and treating that as "no growth" would penalise every newly-detected board for the crime of being new. `latestJobCountDelta` returns `null`, the scorer reports "no delta: fewer than two board observations", and the hiring component neither gains nor loses. Only 16 of 43 boards have two reads today, so this is the common case, not the edge case.

The delta signal cites the **newer** observation's `Evidence` row — the one whose excerpt quotes the count that moved — and the full derivation (both signal ids, both evidence ids, both counts, both timestamps) goes to `AuditLog`. Writing an `Evidence` row for a number we computed would put a value into the provenance table that no source ever published.

Measured deltas after two board reads a day apart: `0,1,2,0,0,0,-1,0,0,0,0,0,0,0,0,0`. Mostly flat, which is the correct reading at a one-day interval — the signal is designed for a weekly cadence.

### 4.9 `tools/verify-f1.ts` read a lifecycle state as a permanent property *(latent F1 defect)*

Two separate bugs in the same file, both of which made a shipped milestone's verifier fail the moment a later milestone did its job:

1. It asserted `MILESTONE_STAGE === 'F1'`. F2's exit criteria require both `MILESTONE_STAGE = 'F2'` **and** `verify:f1` green, which an equality check makes contradictory. Now `isAtOrAfter(MILESTONE_STAGE, 'F1')`.
2. It counted `Company.status === 'normalized'`. D1's lifecycle runs `discovered → normalized → researching → { researched | insufficient_evidence | excluded }`, so F2's scorer legitimately moves every company out of that status — and the criterion reported **0 of 150** on the first run after scoring. It now counts "normalized or later" and prints the status breakdown.

**Generalise this: a verifier for a shipped milestone must keep passing at every later stage, or it stops being a regression test.** `verify-f2.ts` is written that way.

### 4.10 The stale-posting deduction was gated on a count that is usually missing *(latent, caught by the coverage test)*

`outdated_role` was raised only when `allPostingsStale && openPostings > 0`, where `openPostings` is the latest *board count* signal. A company with an open `Opportunity` row but no board-count observation — which is every company whose postings arrived before the count signal existed, and every company whose board read failed — has `openPostings === null`, so a genuinely stale posting raised nothing.

`allPostingsStale` is computed from the `Opportunity` rows themselves and is already false when there are none, so the guard was both redundant and wrong. Removed. The reason-code coverage test caught it, which is what that test is for.

### 4.11 Country normalization is a lookup over spellings that were actually published

F1's §4.12 handed F2 country normalization and required the mapping to be recorded. `src/intel/country/normalize.ts` is a table keyed on the spellings the corpus actually contains (`USA`, `United States of America`, `India`, `Republic of India`, …), and every resolution carries the source's own string, the ISO code, the priority region, and `COUNTRY_MAP_VERSION`. `score_components` stores the map version, so a later table change is auditable against historical scores.

**An unrecognised string resolves to `null` and is recorded as unmapped — never guessed.** A wrong guess here promotes a company into India's priority band or demotes it out of one. `"Remote"`, which yc-oss writes as a location, names no country and is unmapped by design.

A test asserts the table agrees with F1's `isIndiaCompany` on every spelling that helper accepts, so a company cannot get an India-sized research envelope and a non-India score.

### 4.12 Injection detection blocks at ingestion, not at prompt assembly

Part G's control is "page text is data-only; no tool-calling LLM in the research path". F2 draws the line earlier than the prompt: a page whose text is shaped like instructions to an agent **never becomes an `Evidence` row at all**.

Blocking at assembly time would mean remembering to filter in every later place an excerpt is quoted — a research brief, a draft's personalization sentence, an application answer. There is one place to filter and it is the moment the text arrives. The proving test asserts zero `Evidence`, zero `CompanySignal`, zero `Contact` and zero `Lead` writes, with one `AuditLog` row carrying `injection_detected` and the matched phrase (metadata on an audit row, which nothing quotes and no prompt reads).

The patterns are deliberately narrow — "ignore" alone is a normal English word; "ignore all previous instructions" is not something a careers page says to a reader. The test pins both directions: five hostile strings detected, four benign ones ("we ignore vanity metrics", "our engineers act as owners", "send us your resume", "we use a Postgres database and export reports weekly") not.

### 4.13 The matcher's vocabularies contain their own generic terms

`handover.md` §6's rule is that a YC company with "AI" in its name is not an AI Engineer target. The first implementation satisfied that test by not having "ai" in the vocabulary at all — so the test passed for the wrong reason, and the mechanism was never exercised.

Generic terms (`ai`, `ml`, `mobile`, `api`, `cloud`, `software engineer`, …) are now **in** the vocabularies and marked generic. They match, they are recorded, and they are worth a quarter of a specific term — so three generic hits still land below the label floor while one specific term plus context clears it. A test asserts every generic term is reachable from some vocabulary, so the list cannot rot into decoration.

Two related decisions: confidence rises with **distinct** specific terms rather than occurrences (repetition is what marketing copy does), and negative keywords **damp** rather than veto (a company can genuinely be a backend shop and be hiring an account manager).

`go` is deliberately absent from the SDE vocabulary. The language name is a common English word, and a word-boundary match on it fires on ordinary prose; `golang` is the unambiguous spelling. A Go shop that never writes "golang" is a miss we accept over a false positive on every careers page that says "go".

### 4.14 `Opportunity.roleTrackId` is set from the posting's own title, never inherited

F3 selects a track-tailored resume per posting. A posting that inherits its company's primary track would get the wrong resume whenever a mobile-first company posts a backend role — which is most of them. Each `Opportunity` is matched on its own title and location, and rows whose own text supports no track keep `roleTrackId = null`. **73 of 815 postings currently carry a track**, which is low because F1 stores a posting's title, location and URL but not its body (see §8.3).

### 4.15 One lead per company per campaign cycle, enforced by lookup rather than by index

D3's partial unique indexes are on `send_attempt`, where A2's invariant actually lives. There is no equivalent index for `Lead`, so `scoreCompanyAndPersist` looks for an existing lead in the cycle and updates it rather than creating a second row. Re-scoring after a vocabulary or weight change is therefore idempotent, which matters because that is the operation an operator will run most often.

---

## 5. F2 as built — the map

New in F2 (everything F0 and F1 built is unchanged and listed in their handovers' §5):

```
prisma/migrations/
  20260909061117_llm_task/         LlmTask + LlmTaskStatus (docs/handoff-llm-gateway.md)
src/core/policy/
  http/raw-client.ts               MODIFIED: rawPostJson (§4.5)
  fetch-policy-gate.ts             MODIFIED: postJson, same five-step preflight
  host-lists.ts                    MODIFIED: api.firecrawl.dev allow entry
src/core/config/config.ts          MODIFIED: FIRECRAWL_API_KEY (optional)
src/core/config/stage.ts           MODIFIED: MILESTONE_STAGE = 'F2'
src/core/llm/
  tasks.ts                         task-kind registry: Zod schema per kind, JSON Schema derivation,
                                   citation collection
  handoff-gateway.ts               NullLlmGateway, HandoffLlmGateway, fulfilTask, claimNextTask, rejectTask
src/intel/
  taxonomy/role-tracks.ts          the four tracks' positive/negative vocabularies (§4.13)
  taxonomy/matcher.ts              deterministic matching, snippets, confidence, A12 tie-break
  taxonomy/seed-tracks.ts          projects the vocabularies into RoleTrack rows
  country/normalize.ts             §4.11 — the recorded country mapping
  scoring/score-version.ts         the frozen weight set; assertSumsTo100 runs at import
  scoring/score.ts                 the PURE scorer, and reconstructTotal (A1's replay)
  scoring/collect.ts               gathers ScoreInput from stored rows; no network
  scoring/run.ts                   ScoreVersion + Lead persistence, audit per reason code
  signals/job-count-delta.ts       B2's delta, computed from stored signals (§4.8)
  signal-graph.ts                  D4 precedence as a hard floor; budget as a precondition
  research/actions.ts              shared audit action names
  research/readability.ts          linkedom + Readability (§4.2)
  research/page-excerpts.ts        §4.1 — one verbatim window per matched track
  research/injection.ts            §4.12 — instruction-shaped text, detected deterministically
  research/page-research.ts        D4 tier 2 end to end, through fetchPage
  research/firecrawl.ts            D4 tier 3, flag off, credit-budgeted
  brief/queue-brief.ts             queues a research brief for a qualified lead
test/
  unit/track-matcher.test.ts  unit/country-normalize.test.ts  unit/scoring.test.ts
  integration/scoring-persistence.test.ts  integration/llm-handoff.test.ts
  integration/firecrawl-escalation.test.ts
  policy/page-research.test.ts  policy/signal-graph-precedence.test.ts
tools/
  run-intelligence.ts              the F2 artifact. LIVE only with --research N
  llm.ts                           the llm:list / next / fulfil / reject CLI
  seed-role-tracks.ts  seed-global-budget.ts
  verify-f2.ts                     the seven exit criteria, reported individually
  verify-f1.ts                     MODIFIED: §4.9's two fixes
```

### The invariants F2 adds

Alongside every F0 and F1 invariant:

**The scorer is pure.** `score.ts` takes a `ScoreInput` and returns a breakdown; it reads no clock, no database and no network (`now` is an input). A11 freezes the weights so reason codes can be reviewed qualitatively instead, and A1 requires a stored score to replay — neither survives a scorer that consults anything.

**A stored score replays from `score_components` + `ScoreVersion` alone.** `reconstructTotal` recomputes the total without the inputs, and refuses a component the version does not declare or one that exceeds its maximum. `verify:f2` runs it against every scored lead in the live database.

**A `ScoreVersion` row is never rewritten.** Changing a weight means a new label. Updating a stored version would change the meaning of every score already computed under it, which is the exact failure the table exists to prevent.

**The source precedence is structural, not advisory.** Tiers are evaluated in order and the first tier with an available action wins. Expected value orders candidates *within* a tier only — the candidate list is built per tier rather than pooled, because a single global ranking with a cost term is how a cheap structured feed loses to an expensive page fetch that looks promising. `browser_task` is declared in the return type and never returned.

**Budget is a precondition, not a tier.** A company with no headroom gets `budget_exhausted` before any tier is considered, so a capped month costs zero preflights rather than one per company.

**A refusal inside the refresh window is a stop, not a slower retry.** The signal graph returns `none` and names the reason code. There is no code path that re-attempts a host that refused.

**Page text is data.** It is scanned for instruction shapes before it can become an `Evidence` row, and a match writes nothing but an audit row.

---

## 6. The reason-code mechanism — you WILL need to touch this

`src/core/reason-codes/registry.ts` maps all 39 codes to the milestone that owns them, and two tests make Part G's coverage rule mechanical:

- `test/unit/reason-codes.test.ts` asserts registry↔Prisma-enum bijection in both directions, plus an **explicitly enumerated list** of the codes reachable at `'F2'` (and, still, at `'F1'` and `'F0'` — bumping the stage adds codes, it never reclassifies one that already shipped).
- `test/policy/reason-code-coverage.test.ts` holds a `scenarios` table that drives each reachable code through its **real code path** and asserts the produced reason, then asserts `Object.keys(scenarios) === reachableReasonCodes('F2')`.

Both hardcode `'F2'` on purpose, so bumping the stage cannot silently pass.

### F3's obligation here

F3 owns **one** code: `application_submitted`.

So F3 must:

1. Set `MILESTONE_STAGE = 'F3'` in `src/core/config/stage.ts`.
2. Add a scenario for `application_submitted` to `test/policy/reason-code-coverage.test.ts`, driving the **real** packet code — a packet marked submitted, and the effect that has on the lead — not a hand-constructed call to a helper.
3. Change the hardcoded `'F2'` references to `'F3'` and extend the expected list in `test/unit/reason-codes.test.ts`.

If you skip step 1, the coverage test still passes and the milestone is a lie. If you do step 1 without 2 and 3, the tests fail loudly — which is the intent.

`application_submitted` is the code that **stops outreach for an opportunity**. It is not decoration on a UI button: Part C's case 3 permits a follow-up *after* applying, and F4's outreach predicate will read this state. Record it where the packet is marked submitted, with an audit row, or F4 inherits a hole.

### Ownership of all 39 codes

| Milestone | Codes |
|---|---|
| **F0** ✅ | `budget_exhausted` `host_denied` `kill_switch_account` `kill_switch_domain` `kill_switch_global` `rate_limited` `robots_disallowed` `sending_disabled` `terms_prohibited` |
| **F1** ✅ | `content_unchanged` `duplicate` `source_unavailable` |
| **F2** ✅ | `injection_detected` `insufficient_evidence` `low_relevance` `outdated_role` `weak_evidence` |
| **F3** ← you | `application_submitted` |
| **F4** | `executive_only_contact` `legal_policy_mismatch` `no_public_recruiting_route` `outreach_not_permitted` |
| **F5** | `approval_hash_mismatch` `breaker_open` `cap_exceeded` `duplicate_company` `duplicate_contact` `hard_bounce` `opt_out` `profile_incomplete` `replied` `soft_bounce` `stale_at_send` `suppressed` `user_paused` `wrong_contact` |
| **F7** | `browser_blocked` `browser_needs_user` `browser_policy_rejected` |

---

## 7. `HandoffLlmGateway` — built, and what F3 inherits

**Full spec, now including an "as built" section: `docs/handoff-llm-gateway.md`. Read it — do not re-derive it.**

The four things that must stay true are unchanged and now have code standing on them:

1. **The app never calls a model.** `HandoffLlmGateway.enqueue()` writes an `LlmTask` row and returns. `complete()` — the `LlmGateway` interface shape — queues and then throws `LlmTaskPendingError`, because there is no honest value to return.
2. **The session never fetches.** A task payload quotes `Evidence` rows that `FetchPolicyGate` already captured: id, source URL, source type, `fetchedVia`, observed date, verbatim excerpt. One direction.
3. **Validation lives in the CLI.** `llm:fulfil` validates against the registered Zod schema, asserts every cited `evidenceId` is in `allowedEvidenceIds`, and refuses output that `redact()` would change. All three were exercised on live data this session — including a deliberate forged citation, refused with `uncited_evidence`.
4. **Everything deterministic stays deterministic** regardless of whether any of this runs (H10).

### What F3 inherits, concretely

- **21 briefs are queued, 19 still pending.** Drain them with `npm run llm:next`.
- **Nothing consumes a fulfilled task's `output` yet.** F2 queues and validates; **writing an accepted brief into the `ResearchBrief` table is F3's job.** Copy `citedEvidenceIds` straight from the validated output rather than re-deriving them — validation has already proved they are in the allowed set.
- Add a task kind by adding a Zod schema to `LLM_TASK_SCHEMAS`. The CLI, the validation and the citation rule are kind-agnostic. `promptVersion` must stay unique across kinds.
- H10 still binds: **F3's packets must be generatable with the LLM backlog untouched.** A prefilled answer that has no brief behind it is left empty for the operator, never blocked.

---

## 8. F3 — the task

> **Plan, Part F, verbatim:** *F3 — Application funnel (the payload — first real user value). `ApplicationPacket` generation: track-tailored resume selection, official application link, prefilled answers drawn only from `ApprovedClaim`; dashboard queues; evidence viewer; accept/defer/reject. → 30 reviewable application packets with full provenance. **You can start applying here, before any email exists.***

### 8.1 What to build

1. **`ApplicationPacket` generation.** The table exists (D2). One packet per `(opportunity, resume version)`: the official application URL, the selected resume, prefilled answers, and the evidence behind every claim. **H8: the system prepares, the user submits. Never auto-submit** — Greenhouse's authenticated submission endpoint exists and is deliberately not used.
2. **Track-tailored resume selection.** `RoleTrack.defaultResumeVersionId` is the seam and is deliberately left `null` by the seeder — it is operator data. `ResumeVersion` and `ApprovedClaim` are empty tables; F3 is where the operator's four resumes and their approved claims first enter the system.
3. **Prefilled answers drawn ONLY from `ApprovedClaim`.** This is the same mechanism as the citation rule: an answer that cites no approved claim is a schema error, not a review finding.
4. **Dashboard queues and the evidence viewer.** `handover.md` §9's queues, and §16's requirement that browser-derived and API-derived facts display **identically** — source, timestamp, excerpt, confidence. `Evidence.fetchedVia` already distinguishes `structured_feed`, `static_fetch` and `firecrawl`; keep it accurate and render it the same way for all three.
5. **Accept / defer / reject**, writing the lead's state and a reason code.
6. **Write accepted `LlmTask` output into `ResearchBrief`** (§7).

### 8.2 Do NOT build in F3

No contacts (F4 is the first milestone that may create one), no drafts, no outreach predicate wiring, no sending, no optional adapter (F2a, each behind its own verification gate, default off), no browser layer (F7).

### 8.3 What F2 learned that changes F3

- **`Opportunity.roleUrl` survives scoring untouched** — asserted by test, because F3 applies through it.
- **Only 73 of 815 postings carry a `roleTrackId`.** F1 stores a posting's title, location and URL but **not its body**, so the matcher sees titles only. A posting called "Software Engineer II, Growth" carries less track evidence than its description would. If F3 needs better per-posting track assignment, the cheapest fix is to store the posting body Greenhouse already returns in `content` — it is fetched and discarded today. That is an F1-owned change; do it deliberately, with a migration, and note the `Evidence` excerpt implications (§4.1's per-key rule applies).
- **21 leads are in the queue band and 4 in the research band**, which is short of the 30 packets Part F asks for. Two honest routes: widen the corpus (§8.4), or generate packets for the 55–69 band as "research-needed", which `handover.md` §6 explicitly contemplates. **Do not lower the threshold to manufacture the number** — A11 freezes the weights and thresholds during the pilot.
- **A score's reasons are stored, not just its number.** `Lead.scoreComponents` carries every component's points, its maximum, the sentence explaining it, the risk deductions, the reason codes, the country map version, and the matched snippets per track. The evidence viewer should render those sentences; they were written to be read by a human.
- **`tsc --noEmit` is not part of `npm test`.** Run `npm run typecheck` before believing a tool works (§3).
- **A verifier for a shipped milestone must keep passing at later stages** (§4.9). Write `verify-f3.ts` with `isAtOrAfter`, and never assert on a lifecycle state a later milestone will legitimately advance.

### 8.4 The corpus question F3 should put to the user

**One of 21 queue-band leads is in India, and India is priority #1.** The cause is upstream of scoring: the corpus is 150 companies from the yc-oss `hiring` feed, of which 123 are USA and 6 are India. The scorer gives India the full geography component and gave the one Indian company that cleared the bar a top-band score — the ranking works; the input is thin.

Three options, in increasing cost, none of which F2 took unilaterally:

1. **Ingest more of the feed.** `npm run ingest:seed -- --feed all --limit 600` widens the universe; detection runs at ~6 companies/minute, so 600 companies is about 90 minutes unattended and resumable.
2. **Enable an India-specific optional adapter** — Adzuna or data.gov.in (F2a, B7). Each needs its own verification gate, fixtures, and host allow entry before it may be enabled.
3. **Accept that India converts more slowly** and plan for it, which is what B7 already told us to expect.

### 8.5 F3 exit criteria

| Criterion | How to demonstrate |
|---|---|
| 30 reviewable application packets | Count in `outreach_dev` after a real run |
| Every packet fully reconstructible from evidence | A test that walks a packet and asserts every claim traces to an `ApprovedClaim` or an `Evidence` row |
| Prefilled answers come only from `ApprovedClaim` | A test that an answer citing no approved claim is refused |
| Browser- and API-derived facts display identically | A test over the viewer's projection for each `fetchedVia` value |
| `Opportunity.roleUrl` is the official application URL | Inspection plus a test |
| Nothing auto-submits | Inspection: no code path posts to an ATS submission endpoint (H8) |
| All F0/F1/F2 invariants intact | `npm test`, `verify:f0`, `verify:f1`, `verify:f2` all still green |
| Milestone bumped honestly | `MILESTONE_STAGE = 'F3'`, `application_submitted` reachable through a real path |

Add a `verify:f3` script alongside the other three, following the same shape.

---

## 9. What F3 must hand to F4

Write `docs/F4-HANDOVER.md` at the end of the F3 session, following this file's structure:

1. **§0 read-first list** — add `docs/F3-HANDOVER.md`. Never edit `docs/architecture-plan.md`.
2. **§2 status** — F3 exit criteria with real numbers (how many packets, how many companies they cover, how many the operator accepted), plus `npm test` and every `verify:*` output.
3. **§3 environment** — any new pins and *why not `latest`*, in the same table shape.
4. **§4 deviations** — every decision where the plan was ambiguous or wrong, with reasoning. **This section is the most valuable one; do not compress it.** Include latent defects in earlier milestones that F3 was the first to exercise — F1 found three in F0, F2 found two in F1, and the pattern will continue.
5. **§5 map** — new modules and the invariants they add.
6. **§6 reason codes** — F4 owns `executive_only_contact`, `legal_policy_mismatch`, `no_public_recruiting_route`, `outreach_not_permitted`. Spell out the same three-step obligation.
7. **§7 `HandoffLlmGateway`** — update `docs/handoff-llm-gateway.md` if F3's use of it resolves anything, particularly around `ResearchBrief` persistence.
8. **§8 the F4 task** — from Part F, plus what F3 learned that changes it.

### F4 preview, so F3 can prepare the ground

Part F: contact curator (role aliases default, published University Recruiting second); `ResearchBrief`; constrained composer with per-sentence `evidenceId`; Quality Gate with versioned checks; approval flow computing `approval_hash`; the three-case outreach predicate. → 30 citation-backed drafts, zero external sends.

Things F3 can make F4 easier by getting right:

- **`application_submitted` must be a real state transition**, not a UI flag. Part C case 3 permits a follow-up only *after* an application exists, and F4's predicate reads it.
- **The approval flow's field list is A7's hash input.** F3's packet is the first thing with a "the human approved exactly this" shape; keep the approved artefact immutable once accepted, so F4 can hash an equivalent structure without redesigning it.
- **`ApprovedClaim` is the only source of candidate facts** in both F3's answers and F4's drafts. Model it once, properly, in F3.

---

## 10. Open questions for the user

Carry these forward until answered.

1. **Firecrawl student credits — still unclaimed, and now the only untested path in F2.** The escalation is built, flag-gated, budget-charged and fixture-tested, but has never spoken to the live API. When the key lands: set `FIRECRAWL_API_KEY`, run `npm run intel:run -- --research 5` against companies whose pages came back unusable (18 of them today), and record the result. That is the smoke test F2 could not run.
2. **The research-credit unit conflates free fetches with paid ones** (§4.7). F2 spent 1,015 credits, all of them free static fetches, against a global envelope the operator set at 1,000 to match Firecrawl's free tier. Steady state fits; the accounting should still be split in F3.
3. **India coverage is 6 companies of 150, and 1 of 21 queue-band leads** (§8.4). This is the highest-value open question in the project right now, and it is a corpus decision, not a code decision.
4. **Git** — F0+F1 are two commits on `main`; all of F2 is uncommitted. The user commits on their own schedule. This is now one milestone of uncommitted work rather than three.
5. **Two duplicate `company_page` `Evidence` rows exist per page researched before §4.1 landed.** The excerpt scheme changed mid-milestone, so the head row's `contentHash` changed with it and the old row was not superseded. Both are verbatim and harmless; a cleanup is a one-line delete of `company_page` rows whose hash was computed under the old scheme, if the noise ever matters.
6. ~~Public-suffix-list dependency~~ — **closed in F1** (`tldts`).
7. ~~`ResearchBudget` seeding~~ — **closed in F1** (at ingestion); the *global* envelope is closed in F2 (§4.4).
8. ~~When to build `HandoffLlmGateway`~~ — **closed.** Built in F2, proven end to end on live data.
9. ~~The unfinished detection pass~~ — **closed.** Finished this session: 43 boards from 150 companies, 29%.
