# F5 Handover — Send Readiness

**Written:** 2026-09-11, at the end of the F4 session.
**For:** the next implementation session, which builds F5 and nothing else.
**Status of the repo when this was written:** F4 complete, 13/13 exit criteria met,
446 tests passing, typecheck and lint clean. F0–F3 committed (`7f469fe`); **all of F4
is uncommitted.**

> ### If you read nothing else
>
> 1. **F4 is finished.** Do not rebuild it. 4 `Contact` rows, 4 `Draft` rows, 1
>    approved with a frozen `approval_hash`.
> 2. **`MILESTONE_STAGE` now reads `'F4'`.** Raising it to `'F5'` is what unlocks
>    sending, and it is the single most consequential line in this repository. Do it
>    only when §8's exit criteria are actually met.
> 3. **The Tier A yield number the operator asked for is in §2.** It answers the
>    vendor question, and the answer is uncomfortable.
> 4. **Three things block a send and none of them is code**: the resumes are
>    `file://` paths, the corpus is 21 qualified companies, and the sending domain has
>    no SPF/DKIM/DMARC yet.

---

## 0. Read these first, in this order

| File | What it is | Binding? |
|---|---|---|
| `handover.md` | The original brief. **§1's non-negotiable policies are binding and are not restated anywhere else.** §1.2 is amended by the operator — see `docs/F4-HANDOVER.md` §10.3 and §4.4 below. | Yes, except where the plan overrides |
| `docs/architecture-plan.md` | The approved architecture plan, verbatim. Defect ids (A1–A12), verification ids (B1–B7), design (Part D), build order (Part F), tests (Part G), decisions (Part H). | **Yes — this is the implementation contract** |
| `docs/F1-HANDOVER.md` | What F0 built, F0's nine deviations. | Yes |
| `docs/F2-HANDOVER.md` | What F1 built, F1's fifteen deviations. | Yes |
| `docs/F3-HANDOVER.md` | What F2 built, F2's fifteen deviations. | Yes |
| `docs/F4-HANDOVER.md` | What F3 built, F3's fifteen deviations, **and §10, the operator's volume-outreach scope amendment**, which is still binding. | Yes |
| `docs/F5-HANDOVER.md` | This file. What F4 actually built, its deviations, and the F5 task. | Yes |
| `docs/handoff-llm-gateway.md` | How the LLM role works. Carries an **"As built (F4)"** section: the `outreach_draft@1` kind and the two-sided allow-set under a message. | Yes |
| `README.md` | Setup and the things that bite. | Informational |

Do not redesign the plan. Do not weaken its safeguards. Do not introduce scraping of
gated platforms. Do not substitute unverified data sources for verified ones.

**Never edit `docs/architecture-plan.md`.** It is the original contract, reproduced
verbatim so it stays auditable. Implementation decisions that depart from it are
recorded in the handover for the milestone that made them — F0's in `F1-HANDOVER.md`
§4, F1's in `F2-HANDOVER.md` §4, F2's in `F3-HANDOVER.md` §4, F3's in
`F4-HANDOVER.md` §4, F4's in §4 below.

### The rules that outrank convenience

Unchanged, and all of them now have F0–F4 code standing on them:

1. **Never automate LinkedIn or any gated platform.** `handover.md` §1.4. Enforced at
   the transport layer by `FetchPolicyGate`, with tests asserting zero sockets —
   including that a redirect into a denied host is refused exactly as a direct request
   is.
2. **Never target founders, CEOs, C-suite or VPs.** §1.1 is **not** amended; the
   operator kept the exclusion explicitly and it is the boundary of the whole
   broadening. `src/outreach/contacts/executive-filter.ts` enforces it and fails
   closed on ambiguity. `verify:f4` re-runs it over every stored contact.
3. **Never infer an email address as a targeting method.** Pattern inference is
   flag-gated OFF, writes `verified = false`, and an unverified contact opens **no**
   outreach case. F4 made that true through the real composer, not only in the
   predicate's unit tests.
4. **Every network request goes through `FetchPolicyGate`.** The AST scanner covers
   `src/`, `test/`, `tools/` and `app/`, `.ts` and `.tsx`.
5. **Sending stays hard-disabled until F5**, enforced by `MILESTONE_STAGE` in source.
   **F5 is the milestone that changes this. See §8.6 before you do.**
6. **Provenance on every fact, on both sides.** `Evidence` bounds what may be said
   about the company, `ApprovedClaim` what may be said about the candidate. In F4 both
   became per-sentence and both are enforced at a choke point.
7. **The system prepares applications; it never submits them** (H8, irreversible).

---

## 1. What this system is, in one paragraph

A local, review-first system that turns a broad universe of startups into a queue of
internship opportunities across four tracks (iOS/Android, AI Engineer, SDE, SWE),
prioritising India then remote-viable US/UK/EU. The terminal action is an
**application**; cold outreach is permitted in four named cases and never sends
without per-message human approval. Per the operator's F4 amendment the outreach half
targets volume — 1,000–2,000 verified contacts — with per-sentence evidence citation
as the stated edge over template spray.

---

## 2. Where the project stands

### F4 is complete

```
npm test          → 34 files, 446 tests passed
npm run typecheck → clean (backend and UI configs both)
npm run lint      → clean
npm run verify:f0 → 4/4     npm run verify:f1 → 7/7
npm run verify:f2 → 7/7     npm run verify:f3 → 11/11
npm run verify:f4 → 13/13
```

| F4 exit criterion | Evidence |
|---|---|
| Citation-backed drafts exist | **4 drafts**: 1 approved with a frozen `approval_hash`, 3 held by the gate awaiting their judgment sentences |
| Every gated draft passes the per-sentence citation rule | Every company sentence cites `Evidence`, every candidate sentence cites an `ApprovedClaim`; validated against the live rows, not just in unit tests |
| No `Contact` without an `Evidence` row | 4 contacts, 0 without provenance. `Contact.evidenceId` is a required column, so it cannot happen |
| No founder/CEO/executive contact | The real filter re-run over every stored contact: 0 executives |
| No draft targets an unverified contact | 0, and an unverified contact opens no outreach case at all |
| `approval_hash` frozen and compared byte-for-byte | 1 approved draft; six red-team tests prove edits to body, resume **file**, recipient and citations each invalidate it |
| Zero external sends | `resolveSendingEnabled({envFlag:true}) = false`; 0 `SendAttempt` rows; no mail transport anywhere in `src/`, `app/` or `tools/` |
| Tier A yield reported (§10.6) | §2.2 below |
| Milestone bumped honestly | `MILESTONE_STAGE = 'F4'`; all four F4 codes driven through **real** paths |

### 2.1 The live corpus, after F4

| Measure | End of F3 | End of F4 |
|---|---|---|
| Companies | 150 | 150 |
| Qualified leads | 21 | 21 |
| `ApplicationPacket` | 37 | 37 |
| `Contact` | 0 | **4** |
| `Draft` | 0 | **4** (1 approved · 3 gate_failed) |
| `Evidence` | 3,033 | 3,041 |
| `LlmTask` | 21 | 26 (2 fulfilled, 22 pending, 1 rejected, 1 claimed) |

### 2.2 The Tier A yield number — the answer to the operator's question

> §10.6: *"Contacts found per company, how many companies yielded zero, and which page
> types produced them. **That number decides whether a paid provider is worth buying,
> and right now nobody has it.**"*

Now somebody has it. Live, across all 21 qualified companies, up to 5 pages each:

```
companies attempted      21
pages actually read for  19    <- the yield denominator
with at least 1 contact   4
with a ROLE ALIAS         4    (21% of measured)
yielded zero             15
total contacts            4
by page kind             careers 3 · contact 1
executives rejected       0
preflight refusals       rate_limited 8 · budget_exhausted 15
```

**The four addresses are `info@geckorobotics.com`, `info@maymobility.com`,
`info@nanonets.com` and `hello@tempo.fit`.**

Read that carefully, because it is worse than 21% suggests: **not one of the nineteen
companies published a dedicated recruiting alias.** No `careers@`, no `jobs@`, no
`talent@`, no university-recruiting address. All four hits are general-purpose company
inboxes, which `classify.ts` accepts as a fallback route *"when nothing better
exists"*. Zero named Talent or People contacts were found either, so H2's second tier
produced nothing at all.

Three caveats that keep this honest, all of which point the same way:

- **19 of 21 measured, not 21.** Two companies had every page refused before a request
  was issued. They are not zero-yield companies; they are unmeasured, and the report
  says so rather than averaging them in.
- **Several of the 19 were cut short.** 13 of the 21 are now at their 20-credit
  per-company research cap, so some companies were read for 2 pages rather than 5. The
  true rate is therefore **at least** 21%, not exactly it.
- **This corpus is 19 US/EU startups.** It says nothing about India, which is priority
  #1 and where B7 already predicted worse structured coverage.

**What it means for the vendor decision.** Even taking 21% as a floor and assuming it
holds, Tier A reaches roughly 400 contacts at a 2,000-company corpus — and they would
be `info@` inboxes, not recruiters. The operator's 1,000–2,000 target is not reachable
from employer pages alone. That makes §10.3's amendment load-bearing rather than
theoretical, and it is now a decision with a number behind it. **It remains
deliberately unexercised: no vendor chosen, no terms read, no host allow entry**
(§10.5).

### 2.3 What one draft actually looks like

Produced end to end on live data — curator → composer → `outreach_draft@1` task →
drained by a Claude Code session → merged → Quality Gate → approved:

```
Subject: Internship enquiry - NanoNets, deep learning

TL;DR — second-year CS undergrad asking whether NanoNets takes engineering interns;
one specific reason I'm writing to you below, resume linked.

Your careers page describes a lean team shipping production software used by more
than 10,000 companies including a third of the Fortune 500, and you have a Deep
Learning Engineer role open in Bengaluru. The ML work I care about is the grounding
part: in AquaSense I built a hybrid Random Forest and Gemini pipeline that checks
every model claim against classifier output, which removed hallucinated
water-quality readings. Day to day I work in LangChain, RAG, Text-to-SQL and
on-device inference.

Available for an internship from December 2026 through January 2027, or from June
2027 through August 2027. Resume: file:///Users/.../Resume_AI.pdf   ← §10.1 open
Is NanoNets taking engineering interns in that window, or is there a better route
than this address?

Aryaman Raj Jaiswal

If you'd rather I didn't write again, say so and I won't.
```

Two evidence rows and three approved claims behind it. The company sentence cites the
employer's own careers page and their own open posting; both candidate sentences cite
`ApprovedClaim` rows. The `file://` resume URL is visible in the body and is exactly
why §10.1 blocks F5.

### 2.4 Nothing about F4 is committed

`git log` shows the four commits F0–F3 were committed in. Everything F4 wrote is in
the working tree — 14 modified paths and 9 new ones. The user commits when they choose.

---

## 3. Environment — read before running anything

**No new dependencies in F4.** Nothing was installed; the composer, the Quality Gate
and the approval flow are all first-party code over packages F0–F3 already pinned.
`npm audit` reports the same 4 high-severity advisories in `prisma`'s own transitive
tree (`deepmerge-ts`, `mysql2`); `npm audit fix --force` still wants `prisma@6`, which
breaks pg-boss's `fromPrisma`. Left alone deliberately.

Pins are exactly as `F4-HANDOVER.md` §3 recorded them: `prisma`/`@prisma/client`/
`@prisma/adapter-pg` `7.10.0`, `pg-boss` `12.30.0`, `undici` `7.29.1`, `tldts`
`7.4.12`, `@mozilla/readability` `0.6.0`, `linkedom` `0.18.13`, `next` `16.3.4`,
`react`/`react-dom` `19.3.0`, `vitest` `4.1.11`, `typescript` `5.9.3`, `eslint`
`10.10.0`, Node 22.16.0, PostgreSQL 17.

### Environment traps

Everything from `F4-HANDOVER.md` §3 and §11.5 still applies:

- **`npm run typecheck` runs two configs**, and the split is a security boundary
  (F3 §4.5). `tsconfig.backend.json` has no DOM lib, which is what makes a bare
  `fetch` in `src/` a type error as well as a lint error and an AST failure.
- **`tsc --noEmit` is not run by `npm test`.** Run both.
- **A green suite does not mean the CLI works** (F1 §4.6), and tsc clean does not mean
  the suite passes. Both directions have bitten this project.
- **Never run `prisma db push`** — it offers to drop D3's two partial unique indexes
  (A2). There is deliberately no `db:push` script.
- **`prisma migrate dev` cannot run non-interactively here.** Use `prisma migrate diff
  --from-config-datasource --to-schema … --script`, read the SQL, check it contains no
  `DROP`, then `migrate deploy`. F4's migration was produced that way and both D3
  indexes were re-verified present afterwards.
- **Prisma's generator reads `tsconfig.json`, which `next build` rewrites** (§11.5).
  `moduleFormat` and `importFileExtension` are pinned in `schema.prisma`; do not unpin
  them.
- Run `npm run db:generate` after any migration before trusting a failure.
- **New, small:** `prisma migrate diff` no longer accepts `--to-schema-datamodel`; it
  is `--to-schema` in Prisma 7.10.

**New in F4, and it cost real time:** two consecutive `verify:*` runs in one shell
reported `6/7` where each reports `7/7` alone. Each verifier spawns a nested `vitest`
against `outreach_test`, and running several back to back appears to let one interfere
with another. It did not recur across a dozen later runs. **Run the verifiers
individually before believing a failure**, and if you see this, re-run the one that
failed on its own.

---

## 4. Deviations from the plan — every one, with its reason

F0's nine, F1's fifteen, F2's fifteen and F3's fifteen are all still in force and none
were reverted. These are F4's. **Do not silently revert any of them; if you disagree,
raise it with the user.**

Four of them (§4.1, §4.2, §4.7, §4.8) are defects found by **running the code against
live data for the first time**, which is the pattern every milestone has repeated. F1
found three in F0, F2 two in F1, F3 three in F2.

### 4.1 The curator read one page per company and reported the other four as refusals *(latent F4 defect, found by the first live run)*

The Tier A curator was written, tested and green, and had never been run. Its first
live run produced this, for all five companies:

```
1/5  Deepgram   1 page(s) → 0 contact(s)   refused: rate_limited
```

Every candidate path is on one employer host, so D4 step 4's per-host spacing applies
between them, and **the gate refuses a too-early request rather than queueing it**. The
curator had no inter-page wait, so the second page always drew `rate_limited` — and it
then treated that refusal as a host verdict and broke the loop, on F1 §4.15's rule that
*"a refusal is about the host, so every other path would refuse identically."*

That rule is true of `host_denied`, `robots_disallowed` and `terms_prohibited`. It is
**false of `rate_limited`**, which is a statement about *timing* and expires on its own.

`src/ingest/ats/detect.ts` had already hit exactly this in F1 and carries both the fix
and a comment explaining why waiting is the only correct response — retrying
immediately or reaching past the limiter would be evading a rate limit
(`handover.md` §1.5). The curator now has the same `interPageDelayMs` option and the
same comment, and `HOST_VERDICT_REFUSALS` names the four refusals that really do end a
walk.

**Why this mattered more than a slow run.** All five companies reported zero contacts,
the yield report called them zero-yield, and the verdict line recommended buying a data
broker — on the strength of pages nobody had fetched. A measurement bug that produces
a confident purchasing recommendation is worse than a crash.

### 4.2 The yield report gave a confident verdict on companies it had never read

Consequence of §4.1, fixed separately because the reporting failure is its own bug.

`TierAYield` now distinguishes **attempted** from **measured** — a company whose every
page was refused before a request was issued has no `Contact` row, and counting it as
zero-yield reports *"employers publish no addresses"* when the truth is *"we never
looked."* `companiesWithZero` counts measured companies only, and `providerVerdict`
refuses to give a rate at all when nothing was measured.

This is B3's rule applied to a different panel: *"Do not build a reputation chart that
renders empty and implies health."* A yield of 0% from unread pages implies a finding
it does not support, and the finding it implied was "buy a broker".

Two smaller fixes in the same file:

- **`preflightRefusalsByReason` is a new field**, because preflight refusals are
  recorded by the **gate** under `fetch.refused` with a URL as the subject, not by the
  curator. Counting only the curator's own actions reported `{}` on a run where every
  page was refused. Part G instruments refusals by reason precisely so a source
  disappearing behind a robots or terms change is visible rather than mistaken for
  absent data.
- **Those counts are attributed by host**, so a curation run that refused nothing no
  longer reports F2's research refusals as its own. The first version counted every
  `fetch.refused` row in the database.
- **`executivesRejected` and `refusalsByReason` now honour the `companyIds` filter.**
  They were global while every other field was scoped, so a scoped call silently
  reported refusals for companies it was not asked about. No caller passed ids yet;
  it would have been wrong the first time one did.

### 4.3 The curator looked for addresses in the one region it had asked to have removed *(the single most consequential F4 finding)*

Found by measuring, and it changed the operator's headline number by 4×.

`curate.ts` extracted addresses from `extractReadable(page.body)`. `readability.ts`'s
own header states its job: *"strip navigation, **footers** and boilerplate and leave
the article."* Meanwhile `CONTACT_PAGE_PATHS` has an entry literally named `footer`,
because a published `careers@` usually lives in one.

So the curator was reading 4–5 pages per company and searching the one part of each
page least likely to hold an address. Live, on 19 companies: **1 contact before,
8 after** (4 after the quality filters in §4.4).

An address is a **token, not prose**, so it needs no article extraction.
`extractPageAddresses` returns the whole document text plus every `mailto:` target,
and the curator searches both.

Three details that are load-bearing:

- **`mailto:` targets go through `extractEmails`, never straight into a row.** That is
  where `noreply@`, `abuse@`, `privacy@` and the placeholder domains are refused — and
  a `mailto:` is the single most likely place to find `noreply@`. Taking the parsed
  `href` as an address would have quietly reopened every one of those holes. Pinned by
  test.
- **The injection scan widened with it.** Widening where addresses are read from while
  leaving the scanner on the article would make a footer the obvious place to hide
  instructions. Both are scanned; a test hides the payload in a footer.
- **Text is taken with element boundaries restored.** `textContent` concatenates
  adjacent elements with **no separator**, so a footer reading *"Case studies ·
  LinkedIn · Instagram · X · Facebook"* beside `info@geckorobotics.com` produced the
  single token `studieslinkedininstagramxfacebookinfo@geckorobotics.com` — which
  matched the address pattern and was stored as a contact. A word-boundary regex
  cannot recover boundaries the source does not have, so
  `textWithElementBoundaries` turns tags into spaces (dropping `<script>` and
  `<style>` bodies first) before matching.

### 4.4 Tier A stores recruiting routes, not any address it finds

The §4.3 widening immediately surfaced `support@qventus.com` and `periop@qventus.com`,
stored as `named_employee`. Neither is a person and neither is a recruiting route.

`handover.md` §8's contact selection order names exactly three things: a role alias, a
published university/recruiting address, and a named People/Talent/Recruiting contact
whose work email the employer printed. A departmental mailbox is none of them, and a
support desk receiving a cold internship enquiry is the same failure as the `abuse@`
case the classifier already refuses.

It is also not what Tier B is about: §10.5 keeps Tier B a **seam** this milestone, and
a scraped generic mailbox is not the "named individual employee" the amendment
contemplated. So a page-read address that classifies as a bare `named_employee` is
refused with `not_recruiting_route` and not stored. `named_talent` — a person whose
published title says recruiting — is still stored, because that is H2's second tier.

**Four rows created before this landed were deleted from `outreach_dev`** (two
departmental mailboxes, one `sales@`, and the fused token from §4.3). They could not be
created by the current code.

### 4.5 `Draft` could not hold what F4 needed — three columns and an index

Found while wiring the composer, not by reading the schema. Migration
`20260911090000_f4_draft_composition`, generated by `migrate diff`, read by hand,
`DROP`-free, applied with `migrate deploy`, both D3 indexes re-verified afterwards.

- **`draft.contact_id`.** The recipient was reachable only through `Lead.contactId`,
  and F2 §4.15 keeps **one Lead per company per cycle** while the operator's §10.7
  decision permits **two contacts** at a company with `teamSize >= 100`. Two drafts
  under one lead therefore have two different recipients, which one nullable column on
  the lead cannot express — and A7 hashes `recipient_email_normalized`, so the
  recipient has to be a property of the artefact that was approved.
- **`draft.touch_slot`.** Which of the company's permitted first-touch slots a draft
  occupies. F5 keys §10.7's replacement index on it — see §8.3.
- **`draft.composition`.** The message as **sentences with their citations**, before
  rendering. D5's invariant is per-sentence, and once sentences are joined into a
  string, which citation supported which claim is unrecoverable — so *"every
  personalization sentence cites evidence"* stops being checkable at all. This is
  `ApplicationPacket.prefilledAnswers` applied to a message.
- **`draft.approved_claim_ids`.** The candidate side of the citation rule (F3 §4.1).
  `cited_evidence_ids` already existed; there was no analogue for what may be said
  about the candidate, which a draft asserts in every message.
- **`@@unique([leadId, contactId, touchSlot])`.** Stops the composer handing the
  operator two copies of the same message to the same person. **It is not A2's
  invariant** — that one is about messages reaching people and lives on
  `send_attempt`, which F5 owns.

### 4.6 An uncited sentence must be a registered template

The two-sided citation rule has an obvious hole: a role with no citation requirement.
Write the company claim into the TL;DR and no check fires.

F3 §4.2 closed the identical hole for application answers by making a deterministic
answer *exactly* the concatenation of the claims it cites, so traceability is checkable
by string containment rather than by a human reading for smuggled facts.

The analogue here: `tldr`, `resume_link`, `ask` and `signoff` carry no citations, so
they must carry a `templateId` naming a real entry in `SENTENCE_TEMPLATES`, and those
render only from values the database already holds — there is no template that takes a
free-text parameter. A citation **on** a template role is also refused, because it
would look like provenance while sitting on text no citation rule checked.

The operator can still edit a draft; that is what the approval flow is for. The
composer cannot invent one.

### 4.7 A draft could confidently describe a different company *(latent F1 defect, and the most dangerous thing found in F4)*

Found by reading a real task payload before fulfilling it.

`tempo.fit` — a fitness company — was detected as using Greenhouse board token
`tempo`, which belongs to **Tempo Energy**, a solar company. So `tempo.fit` carries
eight `Opportunity` rows whose URLs are all on `tempoenergy.com`: *"Engineering
Technician - Electrical, San Diego"*, *"Staff Materials Engineer"*, and so on. All of
that was quoted into the draft payload for `hello@tempo.fit`.

Through F3 this was survivable: a wrong application packet is one the operator looks at
and discards. **F4 is where it becomes an email to a stranger confidently describing a
company that is not theirs** — and, unlike most failures here, it would pass every
check that existed. The citation is real, the excerpt is verbatim, the URL resolves.
Everything is provably true about somebody else.

`src/outreach/draft/evidence-scope.ts` restricts what a message may cite to the
company's own registrable domain (including subdomains) or a genuine ATS host.
Enforced twice, answering different questions: the queue filter decides what a session
is **offered**, and the gate check decides what a stored draft is allowed to have
**cited** — including one composed before the filter existed, or edited by hand. A
company whose evidence is entirely foreign composes no draft at all, which is correct:
there is nothing true we can say.

yc-oss hosts are deliberately **not** in scope. H7 makes the seed index a discovery
source whose facts must be re-verified from the company's own site before being cited,
and a draft is exactly the place that rule is for.

**This does not fix the detection bug**, which is F1-owned, needs a migration and a
re-detect, and is §9.2 below.

### 4.8 `hasPublicRecruitingContact` and `hasVerifiedContact` are different questions

`F4-HANDOVER.md` §11.1 says both that an unverified contact *"is excluded from
`hasPublicRecruitingContact` too"* and that `outreach_not_permitted` narrows to
*"contact exists but is not verified"*. Those cannot both hold: if an unverified
contact zeroes the first field, the predicate returns `no_public_recruiting_route` and
the second state is unreachable.

`test/unit/outreach-case.test.ts` — written in the same session — pins the two as
**separate inputs**, so the prose is the loose half. The composer now derives them
separately:

- `hasPublicRecruitingContact` — does a public recruiting route exist here at all?
- `hasVerifiedContact` — is the address we would actually use one we read off a page?

The first implementation set both from `contact.verified`, which collapsed them, and
that had two consequences: a company with an unverified contact reported *"no public
recruiting route"* when a route had in fact been found and rejected, and **Part G's
single most important policy test became unreachable through any real path**. Both
codes are now driven through the real composer in
`test/policy/reason-code-coverage.test.ts`.

### 4.9 `legal_policy_mismatch` gates the amended path, and asserts nothing about the law

F4 owns this code and it had no implementation. The obvious one — refuse contacts in
the EU/UK — is exactly what **B4 forbids**: primary-source research did not resolve
whether those regimes reach individual, human-approved job-seeker outreach, and the
instruction is to *"draw no conclusion in either direction, and never rely on being out
of scope."* "Refuse the EU" asserts a regime applies; "permit everything" asserts none
does.

So the check gates **the amended path only** — a contact obtained by
`lookup_provider` or `pattern_inferred`, at a company in a region with no recorded
review. §10.3 records why that is the right boundary: B4's posture was reasoned about
role aliases at hand-approved volume, and named individuals sourced from a third party
at 1,000–2,000 scale is a different fact pattern (GDPR Art. 14 in particular). B4's own
closing line asks for exactly this re-examination when the activity expands.

The claim the code makes is narrow and true: *the operator has not yet recorded the
review B4 asked for, so the system will not act on the amendment in that region.*
Tier A never reaches the check. An **unmapped** country resolves to `unknown` and is
refused rather than permitted — F2 §4.11's rule that an unrecognised string is recorded
and never guessed at, applied where guessing would be a permit.

Recording a review is a deliberate operator act and is deferred with the rest of Tier B.

### 4.10 The Quality Gate checks the message, and nothing that already has a choke point

Part F asks for *"versioned checks"*; `GATE_VERSION` is `f4-gate-v1` and, like a
`ScoreVersion`, is never edited — only added — because a stored `gateResult` has to
still mean something a month later.

What it deliberately does **not** re-check: citation support (a schema error before the
gate runs), recipient suitability (the executive filter, at curation), outreach
permission (the predicate), jurisdiction (§4.9), and suppression/caps/breaker (D6's
send gate, which is F5's). F3 §7 makes the argument: a second, weaker implementation of
a check that already passed is how two implementations end up disagreeing.

What is left is wording and shape, which nothing else looks at: `handover.md` §8's
named generic praise, B4's deception controls (no `Re:` on a first touch, no false
urgency), §10.8's length ceiling, and two checks worth naming:

- **`no_injection_in_outbound`.** F2 §4.12 scans what *arrives*. This scans what
  *leaves*, which is a different threat and a real one: the composer's input is
  excerpts from employer careers pages, so hostile text that reached a draft would be
  forwarded, over the operator's name, to a recruiter.
- **`names_the_company`.** A composer bug that reuses the previous company's sentence
  is otherwise silent, and it is the most embarrassing thing this system could send.
  (§4.7 is the version of that failure which *does* name the right company and still
  describes the wrong one.)

### 4.11 A gate failure maps onto existing reason codes rather than inventing one

The enum is closed (Part G) and a new value needs a migration and an owner. A gate
failure is not a policy violation — the policy checks ran earlier and refused with
their own codes — it means the evidence or the wording did not hold up, which
`weak_evidence` and `low_relevance` already say. `injection_detected` is reused for the
outbound scan.

### 4.12 H10 degrades differently for a message than for a packet, and that is deliberate

F3 measured H10 by producing 37 complete packets with the LLM backlog untouched: a
packet is *usable* without its judgment answers, because the operator can submit it
with two questions blank.

A message is not. Its evidence-cited sentence **is** the entire stated edge over
template spray (§10.1), so a draft with no fulfilled task is complete as a **record**
and deliberately cannot pass the Quality Gate — it fails `missing_required_role`. Three
of the four live drafts sit in exactly that state right now.

That is H10 degrading honestly rather than H10 not applying: the pipeline is not
broken, no packet or score is blocked, and draining the backlog upgrades a draft. It
never unblocks one, because there was never an honest message to unblock.

---

## 5. F4 as built — the map

New in F4 (everything F0–F3 built is unchanged and listed in their handovers' §5):

```
prisma/migrations/
  20260910120000_f4_contacts/              contact_type += named_employee; outreach_case +=
                                           intern_availability_inquiry; contact.verified,
                                           discovery_method, source_page_kind
  20260911090000_f4_draft_composition/     §4.5 — draft.contact_id, touch_slot, composition,
                                           approved_claim_ids + unique(lead, contact, slot)
src/core/config/config.ts     MODIFIED: CONTACT_ALLOW_PATTERN_INFERENCE (default off)
src/core/config/stage.ts      MODIFIED: MILESTONE_STAGE = 'F4'
src/core/policy/outreach-case.ts  REWRITTEN: the fourth case, evaluated 3 → 1 → 2 → 4
src/core/llm/tasks.ts         MODIFIED: outreach_draft@1, both citation arrays .min(1)
src/intel/research/readability.ts  MODIFIED: §4.3 — extractPageAddresses,
                                   textWithElementBoundaries
src/outreach/contacts/
  classify.ts                 extraction + classification, pure
  executive-filter.ts         §1.1 enforced; reads title AND local part; fails closed
  curate.ts                   Tier A curator (§4.1, §4.3, §4.4)
  provider.ts                 Tier B seam + fake. Unexercised by operator instruction
  yield-report.ts             §10.6's number, attempted vs measured (§4.2)
src/outreach/draft/
  message.ts                  the sentence schema and THE choke point (§4.6)
  templates.ts                the registered uncited sentences (§4.6)
  compose.ts                  selection, the predicate wired to real rows, the gate runner
  queue-draft.ts              the outreach_draft task, and the merge
  quality-gate.ts             §4.10 — versioned checks
  hash.ts                     A7's exact field list
  approve.ts                  approval, and verifyApprovalHash for F5's send gate
  slots.ts                    §10.7 — 1 or 2 contacts per company
  jurisdiction.ts             §4.9 — legal_policy_mismatch
  evidence-scope.ts           §4.7 — a draft cannot cite another company
test/
  unit/contact-classify.test.ts        19 tests
  policy/contact-curation.test.ts      18 tests, each a red-team attempt
  policy/outreach-draft.test.ts        44 tests: the exit criteria as red-team attempts
tools/
  run-contacts.ts             LIVE. Tier A curation + the yield report
  run-drafts.ts               compose / --queue / --drain / --gate / --approve. NO network
  verify-f4.ts                the thirteen exit criteria, reported individually
```

### The invariants F4 adds

Alongside every F0–F3 invariant:

**A sentence that asserts something it cannot cite does not exist.** A company sentence
carries an `evidenceId`, a candidate sentence an `approvedClaimId`, and an uncited
sentence is a registered template rendered from stored values. Enforced at one choke
point, `validateComposition`, which nothing writes `Draft.composition` without passing.

**A draft cannot cite evidence about another company** (§4.7).

**An approved draft is frozen.** Composition and the answer-merge both refuse a draft
with `approvedAt` set, exactly as F3 froze an accepted packet.

**`approval_hash` is computed at approval and never at send.** A7: recomputing from
live data at send time "always matches and proves nothing".

**A contact stored by Tier A is a recruiting route** — an alias or a published Talent
person, never a departmental mailbox and never an executive.

**`npm run drafts:run` touches no network.** Only four commands do: `ingest:seed`,
`fixtures:record`, `intel:run -- --research N`, and `contacts:curate`.

---

## 6. The reason-code mechanism — you WILL need to touch this

`src/core/reason-codes/registry.ts` maps all 39 codes to the milestone that owns them,
and two tests make Part G's coverage rule mechanical:

- `test/unit/reason-codes.test.ts` asserts registry↔Prisma-enum bijection in both
  directions, plus an **explicitly enumerated list** of the codes reachable at `'F4'`
  (and, still, at `'F3'`, `'F2'`, `'F1'` and `'F0'` — bumping the stage adds codes, it
  never reclassifies one that already shipped).
- `test/policy/reason-code-coverage.test.ts` drives each reachable code through its
  **real code path** and asserts the produced reason, then asserts the scenario table
  covers exactly `reachableReasonCodes('F4')`.

Both hardcode `'F4'` on purpose, so bumping the stage cannot silently pass.

### F5's obligation here

F5 owns **fourteen** codes, by far the largest share:

`approval_hash_mismatch` · `breaker_open` · `cap_exceeded` · `duplicate_company` ·
`duplicate_contact` · `hard_bounce` · `opt_out` · `profile_incomplete` · `replied` ·
`soft_bounce` · `stale_at_send` · `suppressed` · `user_paused` · `wrong_contact`

So F5 must:

1. Set `MILESTONE_STAGE = 'F5'` in `src/core/config/stage.ts`. **This is the line that
   unlocks sending.** It is not a config change; see §8.6.
2. Add a scenario for each of the fourteen to
   `test/policy/reason-code-coverage.test.ts`, driving the **real** send gate and
   outcome-ingestion code — not a hand-constructed call to a helper.
3. Change the hardcoded `'F4'` references to `'F5'` and extend the expected list in
   `test/unit/reason-codes.test.ts`.

Two notes that will save time:

- **`approval_hash_mismatch` already has its check written and tested.**
  `verifyApprovalHash` in `src/outreach/draft/approve.ts` recomputes A7's input from
  live rows and compares byte-for-byte; six tests prove that editing the body, the
  resume **file**, the recipient or a sentence's citations each invalidates it. F5
  calls it from D6's send gate and raises the code. Do not write a second one.
- **`duplicate_contact` and `duplicate_company` are D3's two partial unique indexes**,
  which are already in the database and are what `db push` would drop. The scenario is
  Part G's: four qualified leads, one alias → one send, three `duplicate_contact`.

### Ownership of all 39 codes

| Milestone | Codes |
|---|---|
| **F0** ✅ | `budget_exhausted` `host_denied` `kill_switch_account` `kill_switch_domain` `kill_switch_global` `rate_limited` `robots_disallowed` `sending_disabled` `terms_prohibited` |
| **F1** ✅ | `content_unchanged` `duplicate` `source_unavailable` |
| **F2** ✅ | `injection_detected` `insufficient_evidence` `low_relevance` `outdated_role` `weak_evidence` |
| **F3** ✅ | `application_submitted` |
| **F4** ✅ | `executive_only_contact` `legal_policy_mismatch` `no_public_recruiting_route` `outreach_not_permitted` |
| **F5** ← you | `approval_hash_mismatch` `breaker_open` `cap_exceeded` `duplicate_company` `duplicate_contact` `hard_bounce` `opt_out` `profile_incomplete` `replied` `soft_bounce` `stale_at_send` `suppressed` `user_paused` `wrong_contact` |
| **F7** | `browser_blocked` `browser_needs_user` `browser_policy_rejected` |

---

## 7. `HandoffLlmGateway` — what F4 changed

**Full spec, with an "As built (F4)" section: `docs/handoff-llm-gateway.md`.**

1. **`outreach_draft@1` is the new kind**, and it is the first where **both** citation
   arrays are `.min(1)`. The company sentence must cite `Evidence`; every candidate
   sentence must cite an `ApprovedClaim`. §10.1's "do not weaken it to go faster" is
   enforced at the schema, so a response missing a citation cannot be accepted by
   `llm:fulfil` at all.
2. **The payload never contains the recipient's address.** The session is given the
   contact *type* and public title only. It has no reason to know who the message goes
   to, and a payload is also where a page's own text lives. Pinned by test.
3. **Foreign evidence never reaches the session** (§4.7). The allow-set is filtered to
   the company's own domain and real ATS hosts before the task is written.
4. **Proven end to end on live data this session.** A task was queued from the live
   corpus, claimed with `llm:next`, fulfilled with a message citing two real `Evidence`
   rows and three real `ApprovedClaim` rows, merged, gated and approved. §2.3 is the
   result.

22 tasks are still pending — 19 `research_brief` from F2 and 3 `outreach_draft`. Drain
them with `npm run llm:next`.

---

## 8. F5 — the task

> **Plan, Part F, verbatim:** *F5 — Send readiness. SPF + DKIM (+ DMARC `p=none`), test
> inbox, Gmail adapter on `gmail.modify` with deterministic `Message-ID` derivation and
> `rfc822msgid:` reconciliation (A9), bounce/reply ingestion with hardness
> classification, first-party deliverability counters, caps and breaker (complaint
> signal optional), resume **linked not attached** (B5). → Verified sends to owned
> inboxes only; kill switch cancels scheduled jobs; the crash-mid-send reconciliation
> test passes with no second send.*

### 8.1 What to build

1. **The Gmail adapter**, on scope **`gmail.modify`** — the minimum that supports send
   plus the Sent-mailbox reconciliation search plus reply ingestion (A9). A send-only
   scope cannot perform the reconciliation search that makes step 2 of A9 possible.
2. **A9's idempotency, exactly as written.** Gmail has no idempotency-key parameter, so
   the key is carried in the message: derive a deterministic RFC 5322 `Message-ID` from
   `SendAttempt.idempotencyKey` on the owned sending domain, set it explicitly in the
   raw MIME, and **persist it on `SendAttempt` before the API call**. On any ambiguous
   timeout, search Sent for `rfc822msgid:<id>` **before** attempting another send. The
   columns already exist.
3. **D6's send gate — one choke point, one transaction**, all nine conditions
   re-evaluated immediately before the provider call. `verifyApprovalHash` is condition
   1 and is already written.
4. **Bounce and reply ingestion**, with hardness classification. A12: a soft bounce
   must **not** permanently suppress.
5. **First-party counters only** (B3). Do not build a reputation chart sourced from
   Postmaster Tools; it will render empty at this volume and imply health. Label
   provider reputation explicitly as not reliably observable at pilot volume.
6. **Caps and the circuit breaker.** The complaint signal is optional — its absence
   must never block a send and must never render as "healthy".
7. **The `send_attempt` index change** for §10.7's 1-or-2 slots — §8.3 below.

### 8.2 Do NOT build in F5

No sending to anyone but owned inboxes (that is F6). No optional adapter (F2a, each
behind its own verification gate, default off). No browser layer (F7). Do not raise
score weights — A11 freezes them until ≥100 sends.

### 8.3 The `send_attempt` index change (§10.7)

D3's `one_first_touch_per_company_per_cycle` permits exactly one first-touch send per
company per cycle. The operator's decision is 1 for a small company and 2 for a larger
one, so the index must admit a bounded second slot. `Draft.touchSlot` already carries
the value; F4 sets it and `slots.ts` decides it (`teamSize >= 100` → 2, unknown → 1).

```sql
-- F5: replaces one_first_touch_per_company_per_cycle
CREATE UNIQUE INDEX one_first_touch_per_company_slot_per_cycle
  ON send_attempt (company_id, campaign_cycle, touch_slot)
  WHERE touch_number = 1 AND status IN ('in_flight','sent');
```

with `touch_slot ∈ {0,1}`. The database then structurally caps at 2 whatever policy
says. **A2's per-contact index is untouched** — one first touch per human per cycle,
regardless of track, is the invariant A2 exists for and it does not change.

Write the migration with `migrate diff`, read the SQL, and re-verify **both** indexes
afterwards. This is the one migration in the project that intentionally drops an index,
so it is the one where `db push`-style carelessness would be indistinguishable from the
intended change.

### 8.4 The arithmetic nobody has stated out loud

Policy #6 is **not** amended and the operator confirmed it: *"Yes — per message,
unchanged."* Every first touch and every follow-up needs an individual human approval.

At the operator's 1,000–2,000 contact target and F6's ceiling of 20 first-touch emails
per business day, that is **50–100 business days of sending — roughly five months** —
and 1,000–2,000 separate approval actions. F4's approval flow is one call per draft
with no bulk form, deliberately.

This is not an argument for weakening policy #6. It is the number that should inform
what the corpus is actually for: a smaller, better-qualified corpus reaches the same
number of *replies* in less time than a larger one, and B5 records that the yield gap
between an alias and a named recruiter is an open empirical question the pilot answers.

### 8.5 Three things block a send, and none of them is code

1. **The resumes are `file://` paths.** `ResumeVersion.linkUrl` holds
   `file:///Users/.../Resume_AI.pdf`. That is honest for F3, where the operator uploads
   a PDF into an ATS by hand, and **useless in an email** — §2.3 shows it sitting in a
   real draft body. H3 says link on first contact, attach after reply, and B5 says a
   new sending domain plus an attachment is the worst deliverability combination
   available. The four PDFs must be hosted and `npm run seed:operator` re-run with real
   URLs. **Every approved draft's `approval_hash` will change when they are**, which is
   the mechanism working: the approval was for a message containing a different link.
2. **SPF, DKIM and DMARC `p=none` on the sending domain**, plus a monitored reply-to
   and a short public privacy/contact statement (B4's voluntarily-adopted controls).
3. **The corpus.** 21 qualified companies produced 4 contacts. See §9.1.

### 8.6 Before you raise `MILESTONE_STAGE`

It is the second of the two independent factors that keep sending disabled, and the
only one a config change cannot reach. The plan's verification note requires that
*"live sending requires an explicit env flag that F0–F4 cannot set"*, and
`test/unit/stage-guard.test.ts` asserts that `SENDING_ENABLED=true` alone still yields
`false`.

Raise it only when Part F's F5 → F6 rollout criteria are actually met: SPF/DKIM
verified, owned-inbox sends render and thread correctly, the kill switch cancels
scheduled jobs, and **the crash-mid-send reconciliation test passes with no second
send**. That last one is Part G's first row and the reason A9 exists.

### 8.7 F5 exit criteria

| Criterion | How to demonstrate |
|---|---|
| Verified sends to owned inboxes only | A real send to an owned address; no other recipient is reachable |
| SPF/DKIM/DMARC aligned | Headers on a received test message |
| Deterministic `Message-ID` persisted before the call | Inspection plus a test |
| Crash-mid-send issues no second send | Part G's row 1: kill the worker after the Gmail call and before the response is recorded; restart; assert the reconciliation search finds it and no second send is issued |
| Same human never emailed twice in a cycle | Four qualified leads, one alias → one send, three `duplicate_contact` |
| A soft bounce does not permanently suppress | A12 |
| `approval_hash` mismatch aborts the send | Edit a hashed field after approval; assert `approval_hash_mismatch` and no send |
| Kill switch cancels scheduled jobs | Not pauses — cancels (A12) |
| All F0–F4 invariants intact | `npm test`, `verify:f0`–`verify:f4` all green |
| Milestone bumped honestly | `MILESTONE_STAGE = 'F5'`, all fourteen F5 codes reachable through real paths |

Add a `verify:f5` script alongside the other five, with `isAtOrAfter`, and never
asserting on a lifecycle state a later milestone will legitimately advance.

---

## 9. What F5 must hand to F6

Write `docs/F6-HANDOVER.md` following this file's structure: §0 read-first list, §2
status with real numbers, §3 environment, **§4 deviations (the most valuable section —
do not compress it)**, §5 map, §6 reason codes, §7 the LLM gateway, §8 the F6 task.

### 9.1 The corpus specification — operator instruction, do NOT run it inside F4

Carried forward verbatim from §10.7: *"F1 needs `--feed all --limit 2000` plus
additional seed feeds. **Do not run it inside F4; specify what it needs.**"*

What it needs, specified:

- **`npm run ingest:seed -- --feed all --limit 2000`.** At the measured ~6
  companies/minute for the detection pass, 2,000 companies is roughly **5–6 hours**,
  unattended and resumable — a company with a board token skips detection, one without
  is re-attempted. Run it in stages if that is easier; it is idempotent.
- **Research budget headroom.** Every company gets a 20-credit envelope at ingestion
  (45 for India, H5), and the **global** envelope is 1,000 credits for the month. 2,000
  companies at one page each is 2,000 credits, so the global cap must be raised before
  the run or research will stop partway with `budget_exhausted`. See §10.2 — the unit
  conflates free static fetches with paid Firecrawl ones, and essentially all of this
  spend is free.
- **"Additional seed feeds" means F2a optional adapters**, and each needs its own
  verification gate before it may be enabled: endpoint live, terms read, rate policy
  recorded, fixtures captured, `FetchPolicyGate` host entry added (Part E, H9). For
  India specifically B7 already found that Keka, Darwinbox and Zoho Recruit expose no
  anonymous public feeds and Freshteam is discontinued, so the realistic candidates are
  **Adzuna** (free key, documented India market) and **data.gov.in** (DPIIT
  recognized-startup registry). The pipeline must remain correct with all of them
  absent.

**Why this is now urgent rather than merely open.** F4 measured 4 contacts from 21
qualified companies. Even at a generous extrapolation the current corpus cannot produce
a pilot, let alone 1,000–2,000 contacts. The corpus is the binding constraint on every
downstream number, and it has been flagged since F2 §8.4.

### 9.2 The `tempo.fit` detection defect (F1-owned)

§4.7. `tempo.fit` holds eight `Opportunity` rows belonging to Tempo Energy because both
resolved to Greenhouse board token `tempo`. F4 stops a *message* being written from the
contaminated evidence, but the rows are still there and still wrong: they inflate
`tempo.fit`'s job-count signal, its score, and its application packets.

The fix belongs upstream, in detection: a board token found on an employer's page
should be confirmed against the postings it returns — if every posting's
`absolute_url` is on a different registrable domain than the company's, the token is
somebody else's. Worth a scan of the whole corpus for the same shape before F6, since
nothing has ever looked.

---

## 10. Open questions — carried forward

1. **The corpus: 21 qualified companies, 4 contacts, 0 India.** The highest-value open
   question in the project, unchanged since F2 and now measured at the outreach layer
   too. §9.1 specifies the work; the operator decides when.
2. **The research-credit unit conflates free fetches with paid ones.** F2 §4.7,
   partially closed in F3 §4.10 by `vendorCreditsSpent` (still 0 — Firecrawl has never
   been called). 13 of the 21 qualified companies are now at their 20-credit
   per-company cap, which is why 2 of 21 were never measured and several were read for
   2 pages rather than 5. **Raising the caps costs nothing real** and would let the
   Tier A number be re-measured cleanly. It is the operator's dial, so F4 did not touch
   it. The global row is also still 1,015-behind on history (F3 §4.9).
3. **Resume URLs are `file://` paths.** Blocking for F5 (§8.5). Note that fixing it
   invalidates every existing `approval_hash`, correctly.
4. **Firecrawl student credits — still unclaimed**, still the only untested path in F2.
5. **Which lookup provider, if any.** Now a decision with a number behind it (§2.2):
   Tier A found four generic `info@` inboxes and zero recruiting aliases across 19
   companies. Still deliberately unanswered — no vendor chosen, no terms read, no host
   allow entry, by operator instruction (§10.5). If it is ever exercised, `jurisdiction.ts`
   already refuses the amended path in regions with no recorded review (§4.9).
6. **15 of 37 packets are senior/staff titles and 0 are internships.** Corpus symptoms;
   §9.1 addresses these, India coverage and contact volume at once.
7. **The `tempo.fit` board-token collision** (§9.2), and whether the same shape exists
   elsewhere in the corpus.
8. **Two duplicate `company_page` `Evidence` rows per page researched before F2 §4.1.**
   Both verbatim and harmless; a one-line delete if the noise ever matters.
9. **Git:** F0–F3 are four commits on `main` (`7f469fe` is F1–F3). **All F4 work is
   uncommitted** — 14 modified paths and 9 new ones. The user commits on their own
   schedule.
