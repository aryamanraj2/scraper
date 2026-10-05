# F6 — next session handover: recipients, sending, then volume

Written 2026-10-05, at the end of the session that built `outreach_draft@4` (commit
`1a6e3ae`). For the next implementer, starting in a fresh chat.

**Precedence.** `docs/F6-DECISIONS.md` wins on every operator decision and number.
`docs/F6-HANDOVER.md` is still the design brief, and its §4 deviations still bind.
`docs/F6-EMAIL-SPEC.md` defines `@3`; this file is the only description of `@4`.

**Start with step 1, then step 2.** Steps 3 to 5 are queued behind them.

---

## 0. Where things stand

```
drafts             36 awaiting_approval, every one outreach_draft@4, Quality Gate passed
approved / sent    0 / 0 send_attempts
MILESTONE_STAGE    'F5'   SENDING_ENABLED=false   SEND_EXTERNAL_RECIPIENTS_ENABLED=false
sending account    the operator's personal gmail.com (GMAIL_SENDING_ACCOUNT), MESSAGE_ID_DOMAIN=aryamanj.in
resumes            https://aryamanj.in/resume/{ai,ios,android,backend}.pdf, all 200 application/pdf (2026-10-05)
leads              249 qualified lead rows; composing refused 112 as no_public_recruiting_route
contacts           126 (careers_alias 14, talent_alias 3, named_talent 24, named_employee 85)
tests              660 green, typecheck and lint clean
```

### What the last session built (commit `1a6e3ae`)

- **`outreach_draft@3`**: `docs/F6-EMAIL-SPEC.md` ported. Fixed module copy in
  `src/outreach/draft/email.ts`; the session writes via, hook and scene only.
- **`outreach_draft@4`, now the default**: the operator's own workflow for the Temple
  email, automated. Research the company, then write the whole middle of the email
  (tldr, hook, 2 to 4 story paragraphs, scene) from `Evidence` and the operator's
  `ApprovedClaim`s. The corrected Temple and Strava emails ship in every task as style
  models (`STYLE_EXAMPLES_V4`), with the operator's rules (`INSTRUCTIONS_V4`), both in
  `src/outreach/draft/queue-draft.ts`.
- **Facts are checked; the copy is not frozen.** `factCheck` in `email.ts` refuses any
  number, capitalised name or link that a sentence's own citations do not contain.
  `validateEmailV4` adds the operator's Strava rules that code can check (the tldr's
  platform must match the track's resume), plus the spec's rules: no dashes, banned
  phrases, the subject, and at most 280 words. 280 because the operator's own Strava
  email is 278.
- **`research:pages` takes full URLs**, so press and support subdomains can be stored
  as `Evidence`.

### How a draft is made today (the `@4` loop)

1. **Discovery:** `firecrawl_search` with `site:<domain>` finds the one specific
   product, feature or launch worth writing about. Firecrawl discovers pages and never
   writes `Evidence` (`docs` F5c).
2. **Storage:** `npm run research:pages -- --domains <domain> --paths <full URL>` stores
   the page as `company_page` Evidence through `FetchPolicyGate`. Run one domain per
   call; with several domains, every path is tried against every company.
3. **Queue:** `npm run drafts:run -- --queue [--company X ...]` (`@4` by default).
4. **Write:** the session reads each payload (`npm run llm:next`, or by script) and
   writes the answer. Each sentence about the operator cites claim ids; each sentence
   about the company cites evidence ids.
5. **Fulfil:** `npm run llm:fulfil -- --id <task> --file out.json`.
6. **Merge:** `npm run drafts:run -- --drain` runs the merge, `validateEmailV4`,
   `validateComposition` and the Quality Gate.
7. **Review:** `npm run drafts:run -- --review`.

The last session batched step 4 with a checker script that ran `validateEmailV4`
before fulfilling. It is **not in the repo**; step 5 below makes it one.

---

## Step 1 — fix the recipients (start here)

### The problem

About 15 of the 36 drafts go to people who are not recruiters. `handover.md` §1 says:
*"Never target CEOs, founders, executives, or generic employee lists by default"*, and
§8 sets the contact order as careers/talent aliases, then university recruiting, then
named Talent/Recruiting contacts.

| Company | To (title) | Kind |
|---|---|---|
| Writer | Website Operations Manager | named_employee |
| Observe.AI (slot 1) | IT Support Specialist | named_employee |
| Sarvam AI | Machine Learning Intern | named_employee |
| Eight Sleep, Deepgram (slot 1) | Senior Software Engineer | named_employee |
| Figma, Duolingo, Vanta x2, Observe.AI (slot 0) | Engineering Manager | named_employee |
| Together AI | Field Engineering Manager | named_employee |
| Prodigal | Deployment Lead | named_employee |
| AssemblyAI | Applied AI Lead | named_employee |
| Anyscale, Replit | People Operations Manager | named_talent (borderline) |

Some role inboxes are also doubtful. The "text beside the address" in `--review` looks
scraped, not like a careers route:

- **Fi Money:** `hello@fi.money`, beside a bank's phishing warning ("log in to the
  FedMobile app now…"). Inspect before anything else.
- **NanoNets:** `info@nanonets.com`, beside `381-0077`.
- **May Mobility:** `info@maymobility.com`, beside `"email":"`.
- **Tempo:** `hello@tempo.fit`, beside membership-billing text.
- **Linear, Mercury, Mashgin, Atlas, Caribou, Dyneti:** `hello@`, `contact@` and
  `info@` addresses typed `careers_alias`. Generic company inboxes, not careers routes.

### The cause

`src/outreach/draft/slots.ts`, `TIER_ORDER`: `named_employee` sits at rank 4, with no
title check. A verified contact of any title can fill a slot when nothing better exists.
F6-DECISIONS §3.1 made lookup-provider contacts with a `valid` verdict sendable; that
decision was about **deliverability**, not about **who** may be emailed.

### What to do

1. **Ask the operator one question first:** recruiter/talent titles only, or may an
   engineering manager at a small company take a slot when no recruiter exists? Do not
   pick for them.
2. Carry `publicTitle` into `SlotCandidate` and filter there: one choke point, not a
   check in every caller. Whatever titles are allowed, a title naming support, IT,
   intern, website or operations never takes a slot.
3. Re-check how each doubtful alias was classified (`src/outreach/contacts/`). A
   `hello@`/`info@` address found on a contact or footer page is not a careers route
   under §8. Decide with the operator whether these stay sendable, and record the
   decision in F6-DECISIONS.
4. Re-compose (`drafts:run -- --recompose`). Read what `composeDrafts` does when a
   company's selected contact changes before you rely on it: drafts are per
   (lead, contact) slot. Drafts that lose their contact must not stay in
   `awaiting_approval`.
5. Tests: one in `test/policy/outreach-draft.test.ts` (selectContactSlots refuses the
   excluded titles), plus the existing `§10.7` slot tests.

---

## Step 2 — turn sending on and send the first batch

**Already true:** the Gmail adapter, send gate, caps (5/day, 3/domain at F6), the
breaker, Message-ID reconciliation, inbox ingestion code, hosted resumes, and the
operator's decision that the system sends **the first message only** (F6-DECISIONS
§3.3).

**Still to build** (F6-DECISIONS §4, build order steps 4 to 8; each lands green before
the next):

1. **Ingestion before every send batch** (§3.3). `tools/run-send.ts` does not ingest
   today. If ingestion cannot run, refuse the batch: never send on stale counts.
2. **The signal-gated ramp** (§3.4). 5 → 10 → 20, read from the first-party counters
   (`src/outreach/send/counters.ts`), never from a calendar. Week 1→2 needs zero hard
   bounces, zero opt-outs and zero wrong-contact reports; week 2→3 needs a 0%
   hard-bounce rate, at least one positive reply, and no manual pause.
3. **The dashboard send queues** (F6-HANDOVER §8.1 item 4). `app/page.tsx` renders
   "not built · <milestone>" for unfilled queues, never `0`.
4. **`tools/verify-f6.ts`**: floors and `isAtOrAfter` only, no ceilings (F6-HANDOVER
   §4.9).
5. **The pilot switch, last, as its own reviewed commit:** `MILESTONE_STAGE = 'F6'` in
   `src/core/config/stage.ts`, plus the `'F5'` → `'F6'` reason-code test references
   (F6-HANDOVER §6). **The operator sets both env flags themselves**, after reviewing
   that commit.

**Operator actions, in order, after the code:**

```
npm run gmail:auth                              # if the stored token has expired
npm run send:test -- --to <owned address on a different account>
# set SENDING_ENABLED=true and SEND_EXTERNAL_RECIPIENTS_ENABLED=true in .env
npm run drafts:run -- --review                  # read each one
npm run drafts:run -- --approve <draftId> --by aryaman      # one at a time, no bulk form
npm run send:run -- --list                      # what the gate says about each approved draft
npm run send:run -- --dry --id <draftId>
npm run send:run -- --id <draftId>              # live; one id per invocation, by design
```

At 5/day, 36 drafts is about 7 to 8 sending days, and less after step 1 removes some.
Read F6-DECISIONS §5 before reporting anything: with n ≈ 36, zero replies is consistent
with a true reply rate up to about 8%.

---

## Step 3 — follow-ups (decided: manual)

F6-DECISIONS §3.3: **no automated follow-up.** The operator writes any follow-up by
hand in the Gmail thread; nothing is scheduled on `QUEUES.followUp`. The research done
this session is worth repeating to the operator once, but not overriding: in Instantly's
2026 benchmark, 42% of replies came after the first email, and the successful internship
cold emails studied (Nick Singh, Tristan Walker) got answers on the second or later
email. If the operator reopens the decision, `QUEUES.followUp`,
`SendAttempt.touchNumber` and `cancelScheduledSends` already exist, and every stop
reason must *cancel* the job, not pause it (A12).

---

## Step 4 — volume: contacts, not drafting

Drafting is no longer the bottleneck. Recipients are:

- **112 qualified leads have no public recruiting route.** For each, use Firecrawl
  (`site:<domain> careers OR jobs OR talent email`) to discover pages, store them with
  `research:pages`, and run the contact curator (`npm run contacts:curate`). Keep every
  `handover.md` §1 policy: no inferred addresses, no LinkedIn, no data brokers.
- **Lead-to-posting mismatch.** Many leads point at a non-engineering posting (Strava:
  procurement director; Close and Figma: account executives; Together AI: commercial
  counsel). Pick the most relevant engineering posting for the lead's track.
  `Opportunity.description` holds 2,528 job-description bodies that drafting never reads.

---

## Step 5 — make the `@4` loop one command

Move the last session's checker into the repo, for example `tools/draft-v4.ts --check |
--commit`: it reads pending `@4` tasks and an answers file, runs `validateEmailV4`
against the real claims and evidence, then fulfils. Then add a project skill or slash
command (`.claude/`) that runs the whole loop from §0: discover, store, queue, write,
check, fulfil, drain, review. Any Claude session can then drain the queue, and `/loop`
can keep it drained.

---

## Gotchas this session paid for

- **Queue dedupe.** `HandoffLlmGateway.enqueue` returns the existing *open* task for a
  draft. To replace an answer, re-queue after the old task is fulfilled; rejecting it
  first and then re-queueing leaves the draft with no task.
- **Evidence scope.** Pages must be on the company's domain or a subdomain
  (`evidence-scope.ts`), or they never reach the session.
- **Payload order.** A task shows the newest 6 `company_page` rows first, so fresh
  research does reach the writer.
- **Sites the fetcher cannot read.** JS-rendered sites (`duolingo.com`) and thin
  feature pages (`fi.money/features/*`) come back unusable. Use blog or support
  subdomains.
- **What `factCheck` cannot catch.** It is lexical. Two true claims merged into one
  false sentence still pass (Temple's "reads bank SMS… never sends anything off the
  phone" merged Saldo's two apps). `INSTRUCTIONS_V4` §8 names the known traps:
  - Saldo iOS reads receipts offline; Saldo Android parses bank SMS and sends redacted
    low-confidence messages to Gemini.
  - The SmartOut app *has* 50K+ installs; he rebuilt it, replacing a Flutter build.
- **TLDR overpromise.** The operator rejected a tldr that projected on-device AI onto a
  cloud feature (Strava's Athlete Intelligence). Lead with the half of the pitch that
  matters to that company.
- **Writing style.** The operator wants every email to read like his Temple email: one
  connected argument, not a list. Plain words, no em dashes.

## Files

```
src/outreach/draft/email.ts        @3 modules; factCheck, validateEmailV4, MAX_WORDS_V4, PROJECT_LINKS
src/outreach/draft/queue-draft.ts  payloads (@3/@4), STYLE_EXAMPLES_V4, INSTRUCTIONS_V4, mergeV3/mergeV4
src/outreach/draft/message.ts      layouts v3/v4, renderBody, validateComposition
src/outreach/draft/slots.ts        contact slot selection (step 1)
src/core/llm/tasks.ts              OutreachDraftResponseV3/V4 schemas
tools/research-pages.ts            evidence fetcher (full URLs allowed)
tools/run-drafts.ts                compose / queue / drain / review / approve
tools/run-send.ts                  send gate and live send (step 2)
test/unit/email-v4.test.ts         factCheck, including the operator's own examples
```
