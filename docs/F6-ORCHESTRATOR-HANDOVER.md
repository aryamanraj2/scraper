# F6 orchestrator handover

Written 2026-10-04, at the end of the F5c chat. For the **orchestrator** chat that
guides the F6 pilot build — not for the implementer.

**`docs/F6-HANDOVER.md` already exists and is still the implementer's primary brief.**
916 lines, written 2026-09-11 by the F5 session: F5's fourteen deviations, the A9
Gmail measurement, the send gate's eleven conditions, and §8's definition of the F6
task. **None of that design content is superseded.** What is stale is every state
number in it, because F5a, F5b and F5c all landed afterwards. This file is the delta
plus the orchestrator's own job. Read `F6-HANDOVER.md` for *what F6 builds*; read this
for *where things actually stand and what to decide*.

`docs/F6-PREPROMPT.md` is likewise the **implementer's** paste block. The
orchestrator's paste block is at the end of this file. They are different jobs.

---

## 1. Your role

Orchestrator, not implementer. The operator runs one milestone per chat for context
efficiency. In this chat you:

- decide what happens next and in what order
- answer the `AskUserQuestion` screens the implementer chat surfaces, with a
  recommendation and the reasoning
- **verify the implementer's claims against the code and the live database rather than
  accepting its summary**
- write the paste block that starts the next chat
- do small contained fixes yourself when the implementer is blocked

Do not implement F6 in this chat. Do verify it.

**Verification has earned its keep every single time.** Five examples, all found by
querying rather than reading a report:

- F2 reported a packet shortfall that did not exist — it counted the wrong unit.
- `checkBudget` read a counter `recordSpend` never incremented; the ceiling was
  unenforceable.
- `Main resume.pdf` was wired to the `swe` track but is an iOS document; 16 packets
  handed an iOS resume to generalist roles.
- F5a's "Tier A yield is 25%" was not a measurement; measured properly it is 17%.
- F5c's chat reported "Lever 1" where the database says 2, and reported 138 contacts
  where the real figure is 126 — twelve addresses appeared in both CSVs and two
  separate dry runs each counted them.

The last one matters most as a pattern: **every yield prediction made in this project
so far has been wrong, usually by about half.** 45% predicted board detection against
23% measured. 138 predicted contacts against 126. Treat any number an implementer
predicts as an order of magnitude and ask for the measured one.

---

## 2. Live state, verified against `outreach_dev` on 2026-10-04

```
companies        3,085
opportunities    5,084
qualified        154 companies / 249 company-track rows
contacts         126     <- 17 verified, 109 NOT verified. See §3.
drafts             4
send_attempts      0     <- nothing has ever been sent
suppressions       0 · bounces 0 · replies 0
credits          7,637 / 50,000
MILESTONE_STAGE  F5
SENDING_ENABLED                  false
SEND_EXTERNAL_RECIPIENTS_ENABLED false
```

Contacts by type: `named_employee` 85 · `named_talent` 24 · `careers_alias` 14 ·
`talent_alias` 3.

`main` is pushed and clean. 604 tests, lint and typecheck green locally.

### What changed since `F6-HANDOVER.md` was written

| it says | reality now |
|---|---|
| corpus 1,975, only 150 scored | 3,085 companies, 154 qualified |
| contacts 4, all generic | 126, of which 109 are named humans |
| 538 tests | 604 |
| "all of F5 is uncommitted" | committed and pushed weeks ago |
| Tier A yield 25% (§2.2) | **17% floor / 18% ceiling**, measured over 99 companies |
| "re-run `intel:run`, cheapest high-value action" | done, repeatedly |

Three mini-milestones landed in between and each has its own record:
`docs/F5a-MANUAL-INGEST-HANDOVER.md`, `docs/F5b-POSTING-BODY-HANDOVER.md`,
`docs/F5c-TARGET-EXPANSION-BRIEF.md`. Read F5c at minimum — it holds the closed-source
list and the reason the corpus looks the way it does.

---

## 3. The blocker nobody has named yet. Raise this first

**F6 is a 50-company pilot. The system can currently send to 17 contacts, and all 17
are generic `careers@` aliases.**

`src/core/policy/outreach-case.ts` makes verification the gate, by design:

> "An unverified contact is one this system did not read off the employer's own page
> and did not receive from a verified provider — in practice, a pattern-inferred
> address. Those open **no** case at all."

F5a §7 set `verified = false` on every imported row deliberately, and said so:
*"importing a thousand of these cannot cause a single send. That is what makes the path
safe to have."* It was the right call then. It is now the thing standing between a
pilot and 109 named engineers.

```
verified = true    17   <- careers_alias 14, talent_alias 3. Generic inboxes.
verified = false  109   <- named_employee 85, named_talent 24. Unsendable.
```

**The orchestrator's first job is to put this decision to the operator**, because it is
a policy decision and not an implementation detail. Three options, with my read:

**(a) Record the provider's own verification verdict as evidence.** The CSVs in
`scratch/` carry an `email_status` column — Hunter and Snov both returned `valid` for
every imported row, meaning each provider ran an SMTP check. `contacts:import`
discarded that column. Teaching it to store the verdict as an `Evidence` row and set
`verified = true` on a provider-attested `valid` is a small change with real grounding:
it is not the operator asserting an address is good, it is recording what the provider
measured, with provenance.
**This is my recommendation.** It respects `handover.md` §1.2 as amended — *"verified
lookup providers are permitted"* — and the only thing separating these rows from a
"real" Tier B integration is that a human moved the bytes.

**(b) Build the Tier B provider seam properly.** Addresses arrive verified because a
real integration fetched them. Correct, and more work than the pilot needs: host allow
entries, fixtures, credit accounting, a live key. F5c recommended deferring it and the
operator agreed. Revisit only if (a) is judged too loose.

**(c) Pilot on the 17 aliases.** Safe, and nearly pointless — it tests the send
machinery without testing the premise. The whole bet is that a named engineer replies
where `careers@` does not.

Whichever wins: **deliverability is the reason to care.** 109 addresses that a provider
marked `valid` are far safer to send to than pattern guesses, and the first pilot week
is when a bad address does the most damage to a new sending reputation.

---

## 4. Decisions the operator still owes F6

`ORCHESTRATOR-HANDOVER.md` §8 named three and they are all still open. Surface them
before the implementer needs them, not after.

1. **The opt-out mechanism.** Legally required. Reply-to-decline needs no
   infrastructure and is the cheap answer. **But F5b carry-forward #8 is still open and
   I verified it today: there is no `List-Unsubscribe` header in
   `src/outreach/mail/mime.ts`.** For cold outreach to individuals at work addresses a
   `mailto:` unsubscribe is the norm and its absence is a deliverability signal, not
   only a compliance one. Small change, should land before the first external send.
2. **Who reads the inbox, and how fast.** A reply answered in three days is a dead
   lead. This is an operator-habit decision, not code, and the pilot's value depends on
   it more than on any cap.
3. **The daily cap.** `capsForStage` returns 5/day and 3/domain at F6
   (`src/outreach/send/caps.ts:42`). The operator has previously said they want to ramp
   to 50. **The ramp is not a calendar** — `F6-HANDOVER.md` §8.1 item 2 is explicit that
   it moves on measured first-party signals: zero hard bounces, zero opt-outs, zero
   wrong-contact reports for week 1→2; then 0% hard bounce rate, ≥1 positive reply, no
   manual pause for 2→3. Hold that line if the operator pushes on it, then build what
   they decide.

---

## 5. What to make the implementer do, and in what order

`F6-HANDOVER.md` §8.1 lists the five build items and they stand: the single follow-up
at 7–10 business days, the signal-gated ramp, the reply draft through the LLM gateway,
the dashboard send queues, and the pilot measurement. §8.2's two-act enablement
(`MILESTONE_STAGE = 'F6'` as a reviewed commit **and** both env flags) and §8.3's
prohibitions are unchanged and binding.

Two things to insist on that the brief could not have known:

**Resolve §3 before anything else gets built.** A follow-up scheduler and a ramp are
pointless if the sendable population is 17 generic inboxes. The contact-verification
decision is upstream of every other F6 task.

**Re-compose the outstanding draft, do not re-approve it.** `F6-HANDOVER.md` §8.2 says
this and it is still true: there are 4 drafts, and at least one carries a `file://`
resume link from before the resumes were hosted. The approval hash is correctly invalid.
The body needs regenerating, not re-blessing.

### What F6 is not for

The funnel's bottleneck has moved twice and will be misread if nobody says so. It was
"no qualified companies", then "no contacts", and it is now **"no contacts the system is
allowed to mail"**. 154 qualified companies is not the constraint. Do not let the
implementer spend F6 widening the corpus — F5c §5 holds the remaining growth work
(board detection on 674, the HN source) and it is explicitly *not* F6.

---

## 6. One uncommitted change, and why CI matters here

CI was added this session and **its first run failed**: `prisma.config.ts` resolves
`env('DATABASE_URL')` at config load, which locally comes from `.env`, and CI has no
`.env`. Run `37147305865` died at `npx prisma generate`.

Fixed in the working tree — `.github/workflows/ci.yml` now sets `DATABASE_URL`
alongside `TEST_DATABASE_URL`. **Verified by simulating CI locally in a stripped
environment** (`env -i`, fresh database, no `.env`): `prisma generate`, `migrate
deploy`, the AST network scan, lint, typecheck and all 604 tests pass. The fix is
uncommitted as of this writing; commit it and confirm the run goes green.

Why this is worth the orchestrator's attention during a *pilot*: the AST scan
(`tools/check-no-raw-http.ts`) is the only mechanical enforcement of non-negotiable #3,
and F6 is the milestone that turns sending on. A green CI gate on every push is what
stops a send-path change from quietly reaching the network outside
`FetchPolicyGate`. `main` already went red once without anyone noticing — the two
enrichment scripts in `5e9fad1` — and that was before anything could send.

---

## 7. Standing traps

- **Never run `prisma db push`.** It reports the hand-written partial unique indexes on
  `send_attempt` as drift and offers to drop them. Use `prisma migrate`.
- **Verifiers use `isAtOrAfter` and must keep passing at later stages.** Three shipped
  verifiers asserted on lifecycle states a later milestone legitimately advanced
  (`F6-HANDOVER.md` §4.9). `verify-f6.ts` must not repeat it.
- **A9 does not hold on Gmail.** Gmail rewrites a client-supplied `Message-ID`; the
  reconciliation matches an `X-Outreach-Ref` header instead. `F6-HANDOVER.md` §2.3 is
  the measurement. Read it before touching the send path.
- **No bulk approval form.** §1.6 unamended, reconfirmed in F4 §10.7.
- **Do not change score weights.** A11 freezes them until ≥100 sends.
- **Gmail OAuth is in Testing mode**, so refresh tokens expire after 7 days. The
  operator should set the project's publishing status to In production, which stops the
  expiry. If auth mysteriously breaks mid-pilot, this is why.
- **Sending identity is the personal Gmail, not `aryamanj.in`.** The domain has no MX,
  no SPF, no DKIM, and `DMARC p=quarantine` — sending from it today fails both
  alignment checks and is quarantined by the operator's own policy. Workspace migration
  was planned for ~3 weeks after the approach is proven.
- **No subagents.** A previous research attempt fanned out to nine children and burned
  the account's spend limit twice plus the entire web-search budget.

---

## 8. What F6 hands to F7

Reply data. That is the whole point, and it is the one number this project has never
had. Everything measured so far — 17% Tier A yield, 23% board detection, 0.65–1.4%
assumed reply rate — describes the top of the funnel. **The assumed reply rate is
assumed.** Fifty sends with real replies tells the operator more about what to build
next than another thousand contacts would.

If the pilot's reply rate lands near the 0.1% spray baseline rather than the 0.5% the
personalization bet predicts, the correct response is to fix the email, not to widen
the corpus. Hold that framing when the numbers come in.

---

## The paste block

```
You are the ORCHESTRATOR for milestone F6 — the controlled pilot — of a local
internship outreach system at /Users/aryamanjaiswal/Documents/ChatGPT/scraper.

READ FIRST, IN THIS ORDER
  1. docs/F6-ORCHESTRATOR-HANDOVER.md  - your brief. Current state, the blocker in
     section 3, the decisions I owe you in section 4, and the standing traps.
  2. docs/F6-HANDOVER.md               - the IMPLEMENTER's brief, 916 lines, written
     at the end of F5. Its design content and F5's fourteen deviations are all still
     valid; every state number in it is three weeks stale. Section 8 defines the F6
     task. Section 2.3 is "A9 does not hold on Gmail" - read it before anyone touches
     the send path.
  3. handover.md                       - the policy spine. Section 1's non-negotiables
     are binding. Section 1.2 is amended; section 1.1 is NOT.
  4. docs/F5c-TARGET-EXPANSION-BRIEF.md - why the corpus looks the way it does, and
     the list of sources that are closed with quoted evidence. Do not re-propose any
     of them.
  Do not edit docs/architecture-plan.md. Ever.

YOUR ROLE
Orchestrator, not implementer. I run one milestone per chat. You decide what happens
next, answer the AskUserQuestion screens the implementer chat surfaces with a
recommendation AND the reasoning, verify its claims against the code and the live
database rather than trusting its summary, and write the paste block that starts the
next chat. Small contained fixes you do yourself. F6 itself you do not build.

Verifying has mattered every time. A milestone reported a packet shortfall that did not
exist because it counted the wrong unit. A budget ceiling was unenforceable because the
counter it read was never incremented. Sixteen packets handed an iOS resume to
generalist roles. The last chat reported 138 contacts where the database says 126, and
"Lever 1" where it says 2. And EVERY yield prediction this project has made has come in
wrong by roughly half - 45% predicted board detection against 23% measured. Treat a
predicted number as an order of magnitude and ask for the measured one.

STATE, verified 2026-10-04
  companies 3,085 · qualified 154 companies / 249 rows · opportunities 5,084
  contacts 126 - but only 17 are verified, and all 17 are generic careers@ aliases
  drafts 4 · send_attempts 0 - nothing has EVER been sent
  credits 7,637 / 50,000 · MILESTONE_STAGE F5 · both send flags false
  main pushed and clean, 604 tests green

THE BLOCKER - raise it with me before anything gets built
F6 is a 50-company pilot and the system can currently mail 17 generic inboxes. The 109
named humans imported from the Hunter/Snov CSVs are all verified=false, and an
unverified contact opens NO outreach case by design. Section 3 of your brief lays out
three options and recommends one: record the provider's own SMTP verdict as Evidence
and set verified=true on it, because the CSVs already carry an email_status column that
contacts:import threw away. That is recording what a provider measured, with
provenance - not me asserting an address is good. Put the choice to me with your own
read before the implementer starts.

DECISIONS I STILL OWE YOU - ask for them early
  1. The opt-out mechanism. Note that List-Unsubscribe is still missing from
     src/outreach/mail/mime.ts, verified today, and that is a deliverability problem as
     much as a compliance one.
  2. Who reads the inbox and how fast. A reply answered in three days is a dead lead.
  3. The daily cap. caps say 5/day and 3/domain at F6. I have said I want to ramp to
     50. The ramp is NOT a calendar - it moves on measured first-party signals. Hold
     that line with me, then build what I decide.

WHAT F6 IS NOT FOR
The bottleneck has moved twice: no qualified companies, then no contacts, now no
contacts the system is ALLOWED to mail. 154 qualified companies is not the constraint.
Do not let F6 drift into widening the corpus - the remaining growth work (board
detection on the other 674, the Hacker News "Who is hiring" source) is in F5c section
5 and is explicitly not this milestone.

ONE THING TO COMMIT
.github/workflows/ci.yml has an uncommitted fix: CI's first run failed because
prisma.config.ts resolves env('DATABASE_URL') at load and CI has no .env. The fix sets
DATABASE_URL alongside TEST_DATABASE_URL and was verified by simulating CI locally in a
stripped environment - all 604 tests pass. Commit it and confirm the run goes green.
This matters for a pilot specifically: the AST scan is the only mechanical enforcement
of "every request goes through FetchPolicyGate", and F6 is the milestone that turns
sending on.

NON-NEGOTIABLES
No automating LinkedIn or any login-walled platform. Never target founders, CEOs,
C-suite or VPs; every other current employee is valid. Every request goes through
FetchPolicyGate and robots is unconditional - no UA spoofing, no overrides, no
technicalities. Every stored value needs an Evidence row with a source URL and a
verbatim excerpt. No blind pattern guessing. Enabling sending takes TWO separate acts:
MILESTONE_STAGE='F6' as a reviewed commit AND both env flags. Never run prisma db push.
No bulk approval form. No score-weight changes until 100 sends. No subagents - a
previous attempt fanned out to nine and burned my spend limit twice.

HOW TO WORK WITH ME
I am a B.Tech student in India, graduating March 2028, and the budget is zero. Free,
free-tier or trivially one-time only; "just pay for it" is not an answer. Measure a
sample before committing to a whole batch - that habit has caught two wrong predictions
already. Report a floor and a ceiling rather than collapsing a measurement into a
verdict, and tell me what a step did NOT achieve, not only what it did. Be direct and
correct me when I am wrong about my own system; I was wrong about chasing the newest YC
batches and right that YC was too narrow, and both corrections came from pushing back.
When I reaffirm a direction after you have raised a concern, say so once and then build
the full thing.

WHAT THIS MILESTONE IS ACTUALLY FOR
Reply data. The 0.65-1.4% reply rate this whole project is built around is ASSUMED, not
measured. Fifty sends with real replies tells me more than another thousand contacts
would. If the pilot comes in near the 0.1% spray baseline, the answer is to fix the
email, not to widen the corpus - hold me to that when the numbers land.
```
