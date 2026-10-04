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

### 4.6 One approval can be revoked, one draft at a time, backward only

`docs/F6-DECISIONS.md` §8 step 3, an operator decision. `revokeApproval` in
`src/outreach/draft/approve.ts`, run as `npm run drafts:run -- --revoke <id> --by <name>`.
It moves `approved -> composing` and nothing else. It clears the hash, approver, time and
frozen sender identity, and writes all four into a `draft.approval_revoked` audit row
first. It refuses a draft with any `SendAttempt`, because that message may already be in
an inbox. There is no list form and no `--all`, for §1.6's reason. A revoked draft has to
be composed, drained and gated again before anyone can approve it, and a test pins that.

It was used once, 2026-10-04, on the one approved draft (the NanoNets alias, hash
`41e5cffffe70…`). That draft's body carried a `file://` resume link (F6-HANDOVER §4.4).

### 4.7 The composer drafts from each company's latest lead only *(latent F4 defect, measured)*

F2 §4.15 keeps one lead per company **per cycle**, and re-scoring in a new month leaves
last month's `qualified` row standing. The composer iterated every qualified lead.
Measured 2026-10-04: **95 companies were qualified in both 2026-09 and 2026-10.** A2's
partial unique indexes count per cycle, so a draft under each lead would have been two
first touches to one human, and the database would have allowed both. That breaks A2's
intent, and F6-DECISIONS §3.3 says each person gets exactly one message.

The composer now uses the company's lead with the latest `campaign_cycle`, whatever its
status. That also drops **4 companies qualified in 2026-09 that re-scored to
`qualifying` in 2026-10**: the current score says research-needed, and a stale row must
not overrule it. An existing draft to the same person at the same company, under any
lead, is re-composed **in place** and re-homed onto the current lead rather than
duplicated. That is how the four F4-era drafts moved from 2026-09 leads to 2026-10 leads.

**Not fixed here, and it matters for the send gate.** D6 condition 8 and D3's indexes
still count per cycle, so in a later month the same person could get a second first
touch. §3.3's "exactly one message per person" needs a cross-cycle check at the send
gate. That belongs to step 4 or 5. Nothing can be sent before step 8.

### 4.8 Re-composing resets a draft to `composing` *(latent F4 defect)*

The composer's upsert replaced the composition with template sentences only, which drops
the cited company sentence, and left `status` alone. A draft at `awaiting_approval` stayed
approvable after any `drafts:run` with no company sentence in it. `approveDraft` checks
only the status. A re-composed draft now goes to `composing` with `statusReason`,
`gateResult` and `promptVersion` cleared. A test approves after a re-run and is refused.

### 4.8a Plain `drafts:run` no longer rewrites existing drafts

Measured after step 3b: a plain `npm run drafts:run` re-composed all 36 drafts, which
reset 34 written, gated drafts to `composing` and template sentences just before the
operator's `--review` showed 0. Nothing was lost, because the session-written answers are
stored as fulfilled tasks and one `--drain` restored all 34. But a default that silently
discards the work under review is a trap. `composeDrafts` now creates only missing
drafts. Rewriting existing ones takes `--recompose` (`recompose: true`), and a test pins
that a plain compose leaves an existing draft byte-identical.

### 4.9 `--drain` merges only each draft's newest fulfilled task

`--drain` merged every fulfilled `outreach_draft` task, so a draft with an F4-era answer
and a fresh one got whichever merged last. `latestFulfilledDraftTasks` picks the newest
per draft. The three stale pending F4 tasks were rejected `duplicate` with a detail
saying they were superseded, because `enqueue` hands back a pending task rather than
building a fresh payload. F6 adds no reason codes, and `duplicate` was the nearest
existing one.

### 4.10 The approval view, and what "title" means for an alias

`npm run drafts:run -- --review` prints every `awaiting_approval` draft, recipient title
first (`src/outreach/draft/review.ts`). The step-3 decision asked for the title to be
prominent so the operator can skip non-recruiters at approval.

Measured on the live rows: a **page-published alias's `publicTitle` is not a title.** It
is the text the curator found beside the address: `"email":"`, a phone-number fragment,
`log in to the FedMobile app now...`. So only `named_*` contacts get a TITLE line. An
alias's TITLE says it is a role inbox, and the stored text goes on a line labelled "text
beside the address". That line is still useful: it shows the operator which F4 "aliases"
are general inboxes lifted from a contact page or a banking notice.

### 4.11 Two drafts left `gate_failed` on purpose

The session that drained the gateway rejected two `outreach_draft` tasks as
`weak_evidence` instead of writing a sentence the evidence could not honestly support:

- **Tempo (`tempo.fit`).** Every offered ATS row is the `tempo` Greenhouse board, which
  belongs to Tempo Energy (F5-HANDOVER §4.7). The own-domain pages are a returns FAQ and
  a staff testimonial. Its "careers alias" is the `hello@` address from that returns FAQ.
- **Duolingo.** None of the 12 offered rows is an engineering posting.

Both drafts sit at `gate_failed` and cannot be approved.

### 4.12 The message was rewritten to the operator's shape (step 3b), and a false template removed

Operator-approved, 2026-10-04, before any approval. Subject `Engineering internship at
<Company>`. Then: a TL;DR, a greeting, the cited company sentence plus a bridge line, an
intro and two project sentences, the window plus a call ask, the resume on its own line,
and a sign-off with links.

- **`tldr.intern_inquiry@1` stated two candidate facts no claim supports, and both were
  false.** It hardcoded a branch and a year of study in a role that cites nothing, which
  is exactly the route the template registry exists to close. Its text is deleted. The id
  stays registered so a stored composition still validates, but rendering it throws.
  `test/unit/pitch.test.ts` renders every live template with sentinel values and fails
  on any education, standing or achievement word left over. Its first assertion is that
  the detector catches the deleted sentence.
- **The TL;DR quotes a new claim, `voice.hook`** (category `voice`, source
  `operator: cover letter`), and cites it. That needed a cited role, `hook`, because a
  template role refuses citations. `greeting` and `bridge` are new template roles.
- **The candidate sentences are fixed per track** (`src/outreach/draft/pitch.ts`):
  an intro built from `identity.full_name` + `education.degree` +
  `education.expected_graduation`, with no branch and no year of study, then two
  sentences for each track. They are cited `candidate` sentences, not templates, and are
  dropped if a claim they cite is withdrawn. Because they are reworded, containment cannot
  check them. The test instead requires every number and capitalised name in them to
  appear in the cited claims, through a listed abbreviation table (`B.Tech`, `NSUT`).
  Mutation-checked: changing "50K+" to "80K+" fails it.
- **The greeting uses the stored first name**, read from the `full_name` column of the
  operator's import line in the contact's Evidence (`greeting.ts`, via
  `readImportedRow`, extracted from the backfill's parser). A role inbox, a page-published
  contact, or a name that does not start with a capitalised word gets "Hi there,".
  Measured: all 18 named recipients yielded a first name.
- **The session now writes only the company sentence.** The merge ignores the answer's
  `subject` and `candidateSentences`. The `outreach_draft@1` schema still requires a
  candidate sentence, and the task instructions now say it is discarded. A `@2` schema
  without it is the clean fix, deferred until the next batch is queued.
- **One shape for every outreach case.** The case-2 and case-3 TL;DR and ask variants are
  not used by new composes. Every live draft is case 4, so nothing changed for the pilot,
  but a case-3 message would no longer mention the application.

**Second pass, same day: the operator's review of the samples.** Three findings. The
"tldr;" line sat badly above the greeting. Company sentences that listed postings or
headcount read badly. And the whole message was "unnecessarily short and unnaturally
direct". What changed:

- **No TL;DR line.** The order is: greeting; an `intro` line saying who is writing and
  why; the company paragraph; the candidate's story, opened by `voice.hook` quoted
  verbatim (so containment checks it); the window and the ask; the resume; the sign-off.
  `intro` is a new cited role. `bridge.close_to_problem@1` is no longer composed.
- **The story sentences follow the voice of the operator's own cover letter:** what a
  project does for someone, and the one decision that made it work. They are still
  cited and still bounded by the number-and-name test. "In plain English" is listed as
  the plain form of the claim's "natural-language".
- **All 34 company paragraphs were re-written through the gateway** under new task
  instructions: say what the company does, believes or is building as the excerpts
  support it, a reason it interests the writer stated as interest only, no headcounts,
  no lists of job titles, never "I saw". Tempo and Duolingo were rejected again.
- **The availability line is "I'm " + the claim, first letter lowered.** It still
  contains the claim's own words, case-insensitively.
- **New templates:** `ask.call@2`, `ask.call_or_route@2`, `resume.link@2`,
  `signoff.plain@4`. Every earlier version stays registered.

Measured: 34 `awaiting_approval`, 0 approved, 191–239 words (median 217), longest body
1,386 characters. That is inside the Quality Gate's 1,400 cap (`MAX_BODY_CHARS`, set for
§10.8's "short, not a cover letter") with little room. A warmer message runs into that
cap. Raising it is the operator's call and would need a new gate version, because
`f4-gate-v1` is never edited.

**Third pass, same day.** The operator: "still disconnected, really no links in between".
They also confirmed that **AquaSense and Team Aquacult's project are the same build**:
first conceived at an event at IIT Delhi, later presented at MLH Brainwave 2.0, where it
won. That is now a claim (`project.aquasense.origin`, source `operator`), so the AI story
can say the project won rather than only place the two side by side.

- **The opening is one paragraph:** intro, the cited company lines, then
  `bridge.ask_intern@1` ("So I wanted to ask whether <Company> takes engineering
  interns."). The ask paragraph's "If there's room for an intern on your team" answers
  back to it.
- **Each track's story is one thread** in the cover letter's pattern: "A bit about me:" +
  `voice.hook`, then a project that answers it, then a second project tied to the first.
  The ties are "the same rule", "works the same way", "the problem was". The AI thread
  leads with a second voice claim, `voice.ai_rule` ("Let the AI handle the messy part,
  but don't let it make things up.", source `operator: cover letter`).
- **The Quality Gate is `f6-gate-v2`: `MAX_BODY_CHARS` 1,400 → 1,800.** The linked version
  runs 1,273–1,565 characters (208–280 words, median 234). The cover-letter test (about
  2,000 characters) still fails the length check. Stored `f4-gate-v1` verdicts keep their
  label, and v1 was not edited.

**Fourth pass, same day: the operator's own sample drafts.** The operator wrote three
messages (Baseten, Dyneti, Supabase) and called them "genuinely good". What made them work
is that the subject, the tldr, the choice and order of projects, and the closing tie are
all written for that one company. Three decisions, asked and answered:

- **Intro:** "I'm Aryaman, a third-year B.Tech student at NSUT Delhi, graduating 2028."
  The year of study is a new claim (`education.year_of_study`). The branch stays out by
  the operator's instruction, although the samples named it.
- **The session writes the subject, tldr, story and tie for each company**
  (`outreach_draft@2`). The fixed parts are the greeting, intro, window (the operator's
  short form, `eligibility.internship_window_short`, quoted verbatim), the ask, the
  resume and "Thanks,". The tldr is the new `opener` role, which must cite claims or
  evidence. The tie must cite evidence. Story sentences must cite claims. The schema also
  refuses a message that cites no Evidence anywhere. A required `company` role became
  "at least one Evidence-cited sentence" (validation and the gate, now `f6-gate-v3`),
  because the company facts now sit in the tldr or the tie. The fixed per-track story
  sentences are gone.
- **The details the samples used are claims now.** The operator confirmed them as true:
  `experience.airtel.latency_effort` (weeks on indexes, best part of the internship),
  `experience.smartout.no_signal`, `voice.on_device`. The samples' own voice lines were
  also recorded so a session cites them rather than inventing lines like them for other
  companies: `voice.annoyed`, `voice.model_serving`, `voice.llm_trust`,
  `voice.databases`, `voice.bank_sms` (source `operator: sample drafts`). Voice claims
  are now offered to the session.

**The Quality Gate caught four drafts** whose prose said "Dyneti", "Gecko's" or "your
team page" instead of the company's display name (`names_the_company`). They were
re-queued and re-fulfilled with the name written in.

Measured: 34 `awaiting_approval`, 0 approved, 120–209 words (median 159), longest body
1,172 characters. Tempo and Duolingo were rejected again.

**Fifth pass, same day: research, then one writing agent.** The operator rejected the
fourth pass ("these suck") and asked for an agent to write each email whole, from the
operator's three samples. The measurement that shaped this: **16 of 33 drafted companies
had evidence that said nothing about what the company does.** 9 had only job titles and 7
had only scraped navigation or footer text. No writer can produce "that's what Baseten
does" from that without inventing it.

- **`npm run research:pages -- --domains a,b`** (`tools/research-pages.ts`, LIVE) fetches
  named companies' home and /about pages through the ordinary `researchCompanyPage` path:
  the D4 preflight, the injection block, Evidence plus an audit row. It scores nothing.
  It exists because `intel:run --research` cannot target companies, and it re-scores the
  whole corpus, which could have moved the pilot's qualified set. There is no "all".
  Run on 2026-10-04 for the 16 thin companies: 15 home pages stored and 7 About pages
  stored. Duolingo yields no text without JavaScript. Run again for the 9 the writer
  declined for thin evidence: 9 home pages and 7 About pages stored.
  - **The first run had every second request to a host refused `rate_limited`.** The tool
    went domain by domain, and the gate refuses a request inside the host window rather
    than queueing it. The fix was to wait: it now goes path by path, so a host's next page
    comes after every other host's. This is F4 §4.1 and F6-HANDOVER §4.14 again.
  - `researchCompanyPage` labels any page it stores with a `careers_page` signal, home and
    About pages included. Nothing in scoring reads that signal type today. It is worth a
    `company_page` signal type if anything ever does.
- **The draft payload now leads with the company's newest page excerpts** (up to 6, then
  the lead's own citations, 16 in all). Before, it offered only what the lead's score
  cited, which is mostly job titles, so the new research would never have reached the
  writer.
  - **That change broke the recipient-privacy test, correctly.** The contact's own
    Evidence row can be page text containing the address. The first fix dropped any row
    that was a contact's Evidence or contained a contact's address. **That was too
    broad, and it was measured:** a contact's row is often the page head, which describes
    the company without the address. Dropping by id hid the only product text of
    Dyneti, Mercury, Close, Caribou and Heart Aerospace, and the writer rightly declined
    all five. The filter is now on the text alone: no excerpt containing any contact's
    address reaches the payload. The privacy test pins it, and it fails with no filter.
- **The operator's three samples ride in every payload as `operatorExamples`**, limited to
  the session-written parts and with the branch removed. They are marked style only,
  never a citable source.
- **`--drain` merges a draft's newest task only if it was fulfilled.** Without this, a
  task the writer rejected would have let drain fall back to the previous, rejected
  wording.
- **One writing agent (operator-approved, one agent rather than one per company)** drained
  the 34 tasks through the ordinary `llm:fulfil` choke point, so every sentence still
  cites a claim or Evidence and the allow-sets still bind. Tempo and Duolingo were
  rejected before it started. First round: 24 written, 10 declined. Re-queued after the
  filter fix and the second research run: 9 more written. Heart Aerospace and May
  Mobility were declined because none of the operator's projects connects to them.
- **The Quality Gate's outbound injection scan caught one false positive.** AssemblyAI's
  draft said the Airtel agent could "never change or leak a production VM database",
  which matches `exfiltrate_contacts` (leak … database). The gate correctly failed
  closed. That one clause was reworded in a fresh task; the scan was not loosened.
- **A read-only audit after merging found no number in any session sentence that is
  absent from its citations.** It flagged a few loose framings for the operator's
  approval pass: Figma calls Wandr "my latest", Dyneti says "I then built", Sarvam says
  "my most India-specific project".

Measured: **32 `awaiting_approval`**, 4 `gate_failed` (Tempo, Duolingo, Heart Aerospace,
May Mobility), 0 approved, 153–199 words (median 176).

**Sixth pass, same day: the operator's project dossier, and clean subjects.** The operator
supplied a dossier compiled from the repos, every resume version and public pages. It
separates what each source verifies from what a resume only claims. It found the drafts
saying several things that were wrong, so **the claims were corrected first** (source
`operator: dossier 2026-10-04`):

- **Saldo is two builds.** The iOS app won the Swift Student Challenge and reads receipts
  on-device with a self-trained Core ML model and Foundation Models. The Android app parses
  bank SMS and sends only redacted, low-confidence messages to Gemini. Drafts, and the
  operator's own Dyneti sample, said "an app that reads my bank SMS without ever touching
  a server ... won the Swift Student Challenge". That merges the two and is false both
  ways. `voice.bank_sms`, the Saldo claims and the Dyneti example were corrected.
- **Withdrawn (deactivated, not deleted):**
  - `project.wandr.generation_split`: the 12% → 72% figure was not found.
  - `project.wandr.realtime_lobby`: a teammate's first multiplayer backend (Cloudflare
    Durable Objects + Supabase Realtime), which the operator's version replaced with
    Network.framework rooms. Credited in `project.wandr.team_origin`.
  - A fourth-pass draft had told Supabase that the operator built on Supabase Realtime.
    That was the teammate's backend.
- **The operator then corrected the dossier itself,** and those corrections are recorded
  as `operator: confirmed 2026-10-04`:
  - The AquaSense LangChain layer was real (`project.aquasense.multi_agent` restored).
  - The Google Places/Routes retrieval is his (`project.wandr.hybrid_retrieval` restored).
  - SmartOut was a minimal Flutter app that he rebuilt natively, adding sign-up and
    outfitters, and republished.
  - Airtel used no Vertex AI.
  - Saldo began iOS-only, extracting receipt amounts fully offline with his own Core ML
    model because the Swift Student Challenge allows only Apple frameworks, and was
    expanded to Android later.
  - The writing agent already running was stopped and its tasks retired as `duplicate`,
    because its payloads held the pre-correction text.
  - **Lesson:** a dossier compiled from repos is evidence, not the authority. It missed
    work done in builds that are not in the repo, and the operator is the source for
    those.
- **Corrected:**
  - SmartOut is a contract Software Engineer role. "50K+ installs" belongs to the app
    (`experience.smartout.installs`), since its scope is unconfirmed.
  - Wandr has 369 tests, not 340.
  - The Airtel agent also has a REST API.
  - AquaSense was Flask at the hackathon and is FastAPI now.
- **Added:**
  - AquaSense's ESP32 safety tier ("requests, not orders").
  - AquaSense's verified diagnosis-and-cart flow.
  - Team credit for AquaSense.
  - Saldo Android's redacted Gemini fallback.
  - HackerRank Orchestrate.

**Subjects:** the operator rejected "Student who…" outright. The form is now "Internship:
<the specific area> at <Company>", at most 60 characters, set in the task instructions
and the examples.

A fresh writing agent rewrote every draft against the corrected claims; reusing the old
agent would have carried the wrong facts in its context. Heart Aerospace and May Mobility
were offered again, because the hardware safety story may connect.

**Result of the sixth pass.** The writing agent was stopped by the operator after 30 of
34. Its claim on one task (EasyPost) was released and re-queued. The session wrote the
last four (Anyscale, Dyneti Technologies, Fi Money, EasyPost) under the same rules,
through `llm:fulfil`. Measured after merging and gating:

- 34 `awaiting_approval`, 2 `gate_failed` (Tempo, Duolingo), 0 approved.
- Heart Aerospace and May Mobility now have drafts, through the AquaSense hardware safety
  claim.
- 153–212 words, median 181.
- Every subject is "Internship: <area> at <Company>", at most 60 characters, with none of
  "Student…".
- An audit found **no** session sentence with a number absent from its citations. No
  body mentions Vertex, the branch, a 12%/72% figure, Cloudflare or Supabase Realtime as
  the operator's work, or a Saldo SMS reader paired with the Swift Student Challenge.

Measured after re-composing: 34 `awaiting_approval` (same 34), 2 `gate_failed` (Tempo,
Duolingo, unchanged), 0 approved. Body length is 152–176 words, median 161, and 29 of 34
fall within the ~120–170 target. The 5 over are role-inbox drafts with long company
sentences.

---

## 10. Open questions — carried forward (F6 additions so far)

1. **Paribus is Ramp.** The `Paribus` company row has canonical domain `ramp.com`
   (yc-oss lists it Acquired, website `ramp.com`), and two provider-`valid` contacts at
   `@ramp.com` hang off it, now verified. A draft to them would say "Paribus". It is the
   `tempo.fit` shape (F5-HANDOVER §4.7) arriving from the seed index rather than from
   board detection. Not exposed in the pilot — Paribus has no qualified lead — but the
   row is wrong. No action taken in F6, by operator instruction.
2. **Lead-opportunity pairing picks non-engineering postings.** Many qualified leads'
   `opportunity` is a sales, legal or finance posting ("Commercial Counsel", "Account
   Executive"). Case-4 messages never render the role title, so no draft says it. But the
   lead's `primaryTrack` and score sit on that pairing. Worth a look before A11's ≥100-send
   review.
3. **`fulfilTask` accepts a task that was rejected.** It refuses only `fulfilled` and
   `abandoned`. Measured in step 3b: a writer session that had been stopped later fulfilled
   an EasyPost task this session had already rejected as superseded. It did no harm here,
   because `latestFulfilledDraftTasks` merges by newest task, and the newer task's answer
   was the one merged. But a rejection that can be overwritten afterwards is a weak
   "superseded". Not changed: whether a rejected task may be retried by design is the
   gateway's call (F2), so it is recorded here rather than fixed in F6.
4. **F4's page-published "aliases" are mostly general inboxes** (`hello@`, `info@`,
   `contact@`). Some came from a returns FAQ or a banking-service notice rather than a
   careers page. The approval view shows the text beside each address (§4.10). Whether
   any of them should be retired is the operator's call.
