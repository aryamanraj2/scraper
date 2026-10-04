# Openings tracker — a parallel track, with its own orchestrator

Written 2026-10-04. **Start this only after F6 lands.** The paste block is at the end.

## 0. Why this is not an F-milestone

The `F0…F7` sequence is the outreach machine's build order and is spoken for: F6 is the
controlled pilot and is in flight right now, and `docs/F7-HANDOVER.md` already exists as
the F6 chat's running record of F6's deviations. F7 itself is reserved in the plan for
the browser layer, and only on measured need.

This is a **second purpose for the same system**, proposed by the operator:

> finding intern openings faster can be another goal of this oss

It shares the corpus, the adapters and the gate with the outreach machine and changes
none of them. So it gets its own track name and its own orchestrator rather than a
number in a sequence it does not belong to.

---

## 1. What the system is, for a chat with zero context

A local, review-first pipeline at `/Users/aryamanjaiswal/Documents/ChatGPT/scraper`.
TypeScript, Postgres via Prisma, Next.js dashboard, pg-boss for jobs. It ingests
companies, detects which applicant-tracking system each one uses, reads their job
boards, scores the companies, and (the other half) prepares cold outreach that a human
approves before anything sends.

The operator is a B.Tech student in India graduating March 2028. **Budget is zero** —
free, free-tier, or trivially one-time. "Just pay for it" is not an available answer.

Read `handover.md` for the policy spine and `docs/F5c-TARGET-EXPANSION-BRIEF.md` for
how the corpus got its current shape and which sources are closed. Never edit
`docs/architecture-plan.md`.

---

## 2. The finding this track exists to exploit

Verified against `outreach_dev` on 2026-10-04:

```
opportunities                             5,084
  intern / new-grad term in the TITLE        70
  in the body                                45
  OPEN, signal in either                     85   <- surfaced NOWHERE
```

**Eighty-five live early-career openings are already in the database — fetched,
parsed, bodies stored — and nothing in the system shows them to the operator.**

The reason is narrow and fixable. `INTERNSHIP_TERMS` exists at
`src/intel/scoring/collect.ts:83` (`intern`, `internship`, `new grad`, `new-grad`,
`graduate programme`, `graduate program`, `apprentice`) but is consumed only as a
**company-level** score input — `internshipMentions` feeding
`internship_feasibility` in `src/intel/scoring/score.ts`. It is never applied as a
**per-opportunity** filter, so the individual postings it matches are invisible.

This is the cheapest unclaimed value in the project: a flag, a query, and a surface
over data already paid for.

### What already exists — do not rebuild any of it

- **Freshness is already modelled.** `Opportunity` carries `posted_at`,
  `last_seen_at`, `closed_at` and `created_at`. All 5,084 rows have `posted_at`
  populated. `closed_at` means a disappeared posting is recorded rather than deleted.
- **Bodies are stored and read.** F5a added `Opportunity.description`; F5b made the
  matcher read it as a weighted field. 2,528+ rows carry one.
- **Change detection already works.** `postingContentHash` includes the body, so a
  re-read of an unchanged posting reports `content_unchanged` and writes nothing. New
  and changed postings are already distinguishable without any new mechanism.
- **Three board adapters, all robots-allowed**, all already written and fixture-tested:
  Greenhouse (`boards-api.greenhouse.io`, robots disallows only `/embed/`), Lever
  (`api.lever.co`, `Allow: /`), Ashby (`api.ashbyhq.com`). Host allow entries exist.
- **A job queue exists.** pg-boss, with queue names declared in
  `src/core/queue/boss.ts:25`. There is no refresh queue yet; adding one is the shape
  of the work, not a new dependency.

### The re-poll surface

```
companies with a detected board   262   (Ashby 143 · Greenhouse 81 · Lever 38)
```

Ashby leads because recent YC batches are on it (F5c §1.2). All three are JSON APIs
with no auth.

---

## 3. The actual problem is staleness, not fetching

The operator's framing was that people reach openings faster using a scraping service.
That is true for people with no pipeline. This project has one, and its gap is
different:

**Boards are read once, at detection. Nothing ever re-reads them.** A posting that goes
up tomorrow is invisible until something triggers a fresh read of that company's board.
There is no scheduled refresh anywhere in the system.

So "faster to openings" is a **cadence** problem, not a fetching-capability problem. The
fix is a scheduled re-read of the 262 boards already detected, through the adapters and
the gate that already exist, with `postingContentHash` doing the new-vs-unchanged work
it already does.

**A scraping service does not help with this and must not be used for it.** See §5.

---

## 4. What to build — scope it, then decide with the operator

Not a specification. The orchestrator's first job is to turn this into one and get the
operator's sign-off on scope before any code is written.

1. **A per-opportunity early-career flag.** The terms already exist; what is missing is
   applying them to the posting rather than only aggregating them to the company.
   Decide deliberately whether the flag is a stored column (queryable, needs a
   migration, needs backfilling) or computed at read time (no migration, recomputed on
   every query). Either is defensible; say which and why.
   - **Precision matters more than recall here.** A body that says "we also hire
     interns" is not an internship posting. A title match is strong evidence; a body
     match alone is weak. F5b hit exactly this problem with track matching and solved
     it with *the title nominates, the body corroborates* — read `docs/F5b-POSTING-BODY-HANDOVER.md` §4 before
     designing this, because the same asymmetry applies and the reasoning is already
     written down.
2. **A refresh cadence.** A new pg-boss queue re-reading detected boards on a schedule.
   Decide the interval with the operator — daily is the obvious default; the gate paces
   same-host requests, so 262 boards is wall-clock time, not credits.
   Record *why* the interval is what it is.
3. **A surface.** A dashboard queue, a CLI report, or both. F3's rule stands: a queue a
   later milestone fills renders "not built", never `0`.
4. **A freshness measurement.** How old is a posting when the operator first sees it?
   That number is the whole point of the track and nothing currently reports it.
   Measure it before and after the cadence lands, or there is no evidence the track
   worked.

### Sequencing note

Step 1 is free and immediate — it surfaces the 85 that already exist. Steps 2–4 are what
make it *fast*. Do step 1 first and let the operator see the 85 before building the
cadence; it is the cheapest way to find out whether the filter's precision is right
before scheduling anything.

---

## 5. Non-negotiables. These are binding and none of them are new

1. **Never automate LinkedIn or any gated or login-walled platform.** Absolute.
2. **Never target founders, CEOs, C-suite or VPs.** Any other current employee is
   valid. Not obviously this track's concern — but if it ever surfaces a contact,
   `isExecutiveContact` runs first.
3. **Every network request goes through `FetchPolicyGate`, and robots is
   unconditional.** `tools/check-no-raw-http.ts` is an AST scan over `src`, `test`,
   `tools` and `app` that fails `npm test` on a bare `fetch`. No user-agent spoofing,
   no robots overrides, no "this host serves no robots.txt" technicality.
4. **Provenance.** Every stored value needs an `Evidence` row with a source URL and a
   verbatim excerpt.
5. **This track does not send anything.** It does not touch `MILESTONE_STAGE`, the send
   path, caps, or the outreach-case logic. If a change here would alter who gets
   emailed, it is out of scope.
6. **No subagents.** A previous research attempt fanned out to nine children and burned
   the account's spend limit twice plus the entire web-search budget.

### The Firecrawl rule, because it will come up

`docs/F5c-TARGET-EXPANSION-BRIEF.md` §3.7 records a live test: Firecrawl served
`itunes.apple.com/search?...`, a path that host's `robots.txt` closes to every user
agent, returning `200` — despite documenting that it honours `*` rules.

> **Discovery is not evidence.**

Firecrawl may be used **in a chat** to find out what exists — candidate company domains
that go through `ingest:seed --from-file` as `user_hint` at confidence 0.5, not citable
until our own gate re-verifies them. It must **never** be a fetcher inside the pipeline,
because that reopens every source F5c §3.4 records as closed and makes the gate
decorative.

For this track specifically: Firecrawl is irrelevant to the actual problem. It finds
boards you do not have; it does nothing for the freshness of boards you do.

**`fullenrich / contacts/mobile` is forbidden** — it resolves a phone number from a
LinkedIn URL, which is non-negotiables #1 and #2 in a single call.

---

## 6. Standing traps

- **Never run `prisma db push`.** It reports the hand-written partial unique indexes on
  `send_attempt` as drift and offers to drop them. Use `prisma migrate`.
- **Do not change score weights.** A11 freezes them until ≥100 sends, and this track has
  no business touching the scorer's weights at all. Reading `INTERNSHIP_TERMS` is fine;
  re-tuning `internship_feasibility` is not.
- **If a derivation changes, bump `ScoreVersion`.** F5b went `f2-v1` → `f5b-v2` with
  byte-identical weights because the *inputs* moved. If this track changes what the
  scorer sees, the same applies. If it only adds a read-side filter, it does not.
- **Verifiers use `isAtOrAfter` and must keep passing at later stages.** Three shipped
  verifiers once asserted on lifecycle states a later milestone legitimately advanced.
- **Do not collide with F6.** It is in flight and owns the send path, the contact
  verification backfill, `docs/F6-*.md` and `docs/F7-HANDOVER.md`. Check `git status`
  before touching anything and stay out of those files.
- **Measure a sample before committing to a batch.** This project's yield predictions
  have been wrong by roughly half, twice: 45% predicted board detection against 23%
  measured, 138 predicted contacts against 126.

---

## The paste block

```
You are the ORCHESTRATOR for the OPENINGS TRACKER — a parallel track in an existing
TypeScript project at /Users/aryamanjaiswal/Documents/ChatGPT/scraper.

READ FIRST, IN FULL
  1. docs/OPENINGS-TRACKER-BRIEF.md   - your brief. The measurement, what already
     exists, the real problem, and the traps.
  2. handover.md                      - the policy spine. Section 1's non-negotiables
     are binding.
  3. docs/F5c-TARGET-EXPANSION-BRIEF.md - how the corpus got its shape, which sources
     are closed with quoted evidence, and the Firecrawl rule in section 3.7.
  4. docs/F5b-POSTING-BODY-HANDOVER.md section 4 - "the title nominates, the body
     corroborates". Read it before designing the early-career filter; the same
     asymmetry applies and the reasoning is already written down.
  Never edit docs/architecture-plan.md.

WHY THIS EXISTS
My system is a cold-outreach machine, but it already collects every job posting from
every company board it detects. I want a second goal out of the same data: finding
intern and new-grad openings FAST.

Verified 2026-10-04: there are 5,084 opportunities in the database, 85 of them open
with an intern/new-grad signal, and NOTHING in the system shows them to me. The terms
already exist at src/intel/scoring/collect.ts:83 - they are just consumed as a
company-level score input and never applied per-posting.

THE REAL PROBLEM IS STALENESS, NOT FETCHING
Boards are read ONCE, at detection. Nothing ever re-reads them, so a posting that goes
up tomorrow is invisible. 262 companies have a detected board (Ashby 143, Greenhouse
81, Lever 38), all three adapters exist and are robots-allowed, postingContentHash
already distinguishes new from unchanged, and pg-boss already runs jobs. What is
missing is a refresh cadence. I have heard people reach openings faster using scraping
services - that is true for people with no pipeline. Mine has one. Do not let me
confuse the two.

YOUR ROLE
Orchestrator, not implementer. I run one workstream per chat. You scope the work, put
the design decisions to me with a recommendation AND the reasoning, verify any
implementer chat's claims against the code and the live database rather than trusting
its summary, and write the paste block that starts the next chat.

Verifying has mattered every time. A milestone reported a packet shortfall that did not
exist because it counted the wrong unit. A budget ceiling was unenforceable because the
counter it read was never incremented. A chat reported 138 contacts where the database
said 126. And every yield prediction this project has made has come in wrong by roughly
half. Treat a predicted number as an order of magnitude and ask for the measured one.

WHAT TO SCOPE, AND THE ORDER I WANT
  1. A per-opportunity early-career flag. Precision over recall - a body that says "we
     also hire interns" is not an internship posting. Decide stored column vs computed
     at read time, and tell me why. This step is free and surfaces the 85 that already
     exist; do it FIRST and let me look at them before anything is scheduled, so we
     find out whether the filter is precise before we build a cadence on top of it.
  2. A refresh cadence - a new pg-boss queue re-reading the 262 detected boards on a
     schedule. Decide the interval with me and record why.
  3. A surface - dashboard queue, CLI report, or both.
  4. A freshness measurement: how old is a posting when I first see it? That number is
     the entire point of this track and nothing reports it today. Measure it before and
     after, or we have no evidence this worked.

NON-NEGOTIABLES
No automating LinkedIn or any login-walled platform. Every network request goes through
FetchPolicyGate and robots is unconditional - an AST scan fails npm test on a bare
fetch, and there is no UA spoofing, no override, no technicality. Every stored value
needs an Evidence row with a source URL and a verbatim excerpt. THIS TRACK SENDS
NOTHING: it does not touch MILESTONE_STAGE, the send path, caps or outreach-case logic.
Never run prisma db push. Do not change score weights - A11 freezes them until 100
sends. No subagents; a previous attempt fanned out to nine and burned my spend limit
twice.

Firecrawl: discovery only, never a fetcher. It was tested and it served a path that
host's robots.txt closes to everyone. Details in F5c section 3.7. Discovery is not
evidence. fullenrich/contacts/mobile is forbidden outright.

DO NOT COLLIDE WITH F6
F6 - the controlled outreach pilot - is in flight in another chat and owns the send
path, the contact-verification backfill, docs/F6-*.md and docs/F7-HANDOVER.md. Run git
status before touching anything and stay out of those files. If F6 is not finished yet,
say so and wait rather than working around it.

HOW TO WORK WITH ME
I am a B.Tech student in India, graduating March 2028, and the budget is zero. Free,
free-tier or trivially one-time only. Measure a sample before committing to a whole
batch. Report a floor and a ceiling rather than collapsing a measurement into a
verdict, and tell me what a step did NOT achieve, not only what it did. Be direct and
correct me when I am wrong about my own system - I was wrong about chasing the newest
YC batches and right that YC was too narrow, and both corrections came from pushing
back. When I reaffirm a direction after you have raised a concern, say so once and then
build the full thing.
```
