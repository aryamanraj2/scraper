You are building milestone F6 of an existing, in-progress TypeScript project.
F0, F1, F2, F3, F4 and F5 are complete and verified. F5's work is UNCOMMITTED in the
working tree. Do not start over, do not redesign the plan, do not rebuild what
already exists, and do not touch anything outside F6.

REPO: /Users/aryamanjaiswal/Documents/ChatGPT/scraper   (branch main)

═══════════════════════════════════════════════════════════════════════════
1. READ THESE FIRST, IN THIS ORDER, IN FULL
═══════════════════════════════════════════════════════════════════════════

  1. handover.md                 — the original brief. §1's six non-negotiable
     policies are BINDING and are deliberately not restated anywhere else.
     NOTE: §1.2 (handover.md:19) has been AMENDED by the operator. The amendment
     and its exact limits are docs/F4-HANDOVER.md §10.3. §1.1 is NOT amended.

  2. docs/architecture-plan.md   — the approved architecture plan, verbatim.
     The implementation contract; OVERRIDES handover.md on conflict. Carries
     defect ids (A1–A12), verification ids (B1–B7), the application-first funnel
     (Part C), system design (Part D), stack (Part E), build order (Part F),
     tests (Part G), and ten open decisions (Part H).
     ** NEVER EDIT THIS FILE. ** Departures live in milestone handovers only.

  3. docs/F1-HANDOVER.md         — what F0 built, F0's NINE deviations.
  4. docs/F2-HANDOVER.md         — what F1 built, F1's FIFTEEN deviations.
  5. docs/F3-HANDOVER.md         — what F2 built, F2's FIFTEEN deviations.
  6. docs/F4-HANDOVER.md         — what F3 built, F3's FIFTEEN deviations, and
     ** §10, the operator's volume-outreach scope amendment, which is STILL
     BINDING. **
  7. docs/F5-HANDOVER.md         — what F4 built, F4's TWELVE deviations, and the
     measured Tier A yield number (§2.2), which is still the binding constraint.

  8. docs/F6-HANDOVER.md         — ** YOUR PRIMARY BRIEF. ** What F5 built, F5's
     FOURTEEN deviations, and the F6 task. Structure:
        §2.1  where the corpus actually stands — read the warning, it matters
        §2.3  ** A9 DOES NOT HOLD ON GMAIL. Read this before touching the send
              path. ** Measured live: Gmail rewrites a client-supplied
              Message-ID, so the reconciliation matches a custom header instead
        §4    F5's fourteen deviations, four of them defects found by running
              real code against a real provider
        §4.4  ** an approval_hash that matched over a message with a dead link **
        §5    the map of what F5 built and the invariants it adds
        §6    the reason-code position — F6 owns NO new codes, and §6 says what
              that obligates instead
        §8.2  ** BEFORE YOU ENABLE SENDING — read it twice **
        §10   open questions

  9. docs/handoff-llm-gateway.md — how the LLM role works. The app never calls a
     model. It writes an LlmTask row and a Claude Code session drains it via a
     schema-validating CLI. Has "As built" sections for F2, F3, F4 and F5 — F5's
     records the one place it DECLINED to use the gateway, and why.

 10. README.md                   — setup and the things that bite.

All 65 recorded deviations across F0–F5 are still in force. Do not silently
revert any of them. If you disagree with one, raise it with the user.

═══════════════════════════════════════════════════════════════════════════
2. WHAT THIS SYSTEM IS
═══════════════════════════════════════════════════════════════════════════

A local, review-first system that turns a broad universe of startups into a queue
of internship opportunities across four role tracks (iOS/Android, AI Engineer,
SDE, SWE), prioritising India then remote-viable US/UK/EU.

The terminal action is an APPLICATION, not an email — the system prepares packets
and the human submits them. F4 added the outreach half. F5 added send readiness,
to owned inboxes only. Per the operator's amendment the outreach target is VOLUME
— 1,000–2,000 verified contacts — with the stated edge over template spray being
per-sentence evidence citation.

** Do not weaken the citation requirement to go faster. ** That is the operator's
explicit instruction and it is the one thing not to trade for throughput.

F6 IS THE CONTROLLED PILOT. It is the milestone that lets this system email a
person who did not ask to hear from it. Everything before it was rehearsal.

═══════════════════════════════════════════════════════════════════════════
3. THE RULES THAT OUTRANK CONVENIENCE
═══════════════════════════════════════════════════════════════════════════

  1. Never automate LinkedIn or any gated platform (§1.4). Enforced at the
     TRANSPORT layer by FetchPolicyGate, with tests asserting zero sockets —
     including that a redirect into a denied host is refused as a direct request
     is.
  2. ** Never target founders, CEOs, C-suite or VPs. ** §1.1 is NOT amended; the
     operator kept the exclusion explicitly and it is the boundary of the whole
     broadening. src/outreach/contacts/executive-filter.ts enforces it and fails
     closed on ambiguity; verify:f4 re-runs it over every stored contact.
  3. Never infer an email address as a targeting method. Pattern inference is
     flag-gated OFF, writes verified=false, and an UNVERIFIED contact opens NO
     outreach case at all.
  4. Every network request goes through FetchPolicyGate — including the mail
     transport. An AST scanner (tools/check-no-raw-http.ts) fails `npm test` if
     anything else can reach the network. It covers src/, test/, tools/ AND app/.
  5. Provenance on every fact, on BOTH sides, PER SENTENCE. Evidence bounds what
     may be said about the COMPANY; ApprovedClaim bounds what may be said about
     the CANDIDATE. Both enforced at a choke point, not trusted.
  6. ** Every message needs individual human approval. ** Policy #6 is unamended
     and the operator reconfirmed it. There is deliberately no bulk approval form
     and `send:run` has deliberately no `--all`. Do not add either.
  7. The system prepares applications; it NEVER submits them (H8, irreversible).
     A test scans every source file to keep it that way.
  8. ** The send gate refuses every recipient not on OWNED_INBOXES. ** Lifting
     that is F6's job and it takes TWO independent acts — see §6 below.

Also binding: never evade a CAPTCHA, login wall, robots rule or rate limit. When
a rate limit blocks you, WAIT. F4 §4.1 and F6-HANDOVER §4.14 are two worked
examples of getting this wrong, the second one on the reconciliation path itself.

═══════════════════════════════════════════════════════════════════════════
4. WHERE THE PROJECT STANDS — verify these yourself before starting
═══════════════════════════════════════════════════════════════════════════

  npm test          → 38 files, 538 tests passed
  npm run typecheck → clean   (runs TWO configs — see §5)
  npm run lint      → clean
  npm run build     → clean   (Next 16.3.4, webpack)
  npm run verify:f0 → 4/4     npm run verify:f1 → 7/7
  npm run verify:f2 → 7/7     npm run verify:f3 → 11/11
  npm run verify:f4 → 13/13   npm run verify:f5 → 15/15

  MILESTONE_STAGE = 'F5'  ← correct. Raising it to 'F6' is one of the two acts
                            that let this system email a stranger.

LIVE DATA in outreach_dev:
  1,975 companies · 149 with a detected ATS board · 2,086 Opportunity rows
  27,839 Evidence rows
  69 scored leads (21 queue-band) ← STILL THE OLD 150-COMPANY CORPUS
  37 ApplicationPacket · 55 ApprovedClaim · 5 ResumeVersion · 1 ResearchBrief
  1 CandidateProfile (complete)
  4 Contact rows   ← all Tier A, all read off employer pages, all verified
  4 Draft rows     ← 1 approved, 3 held by the gate
  0 SendAttempt    ← F6 writes the first real one
  25 LlmTask (2 fulfilled, 22 pending, 1 rejected)

** The corpus was widened 13× and NEVER RE-SCORED. ** `npm run intel:run` scores
from stored rows and touches no network. It is the cheapest high-value action
available and F6-HANDOVER §8.4 says so. Do it before drawing any conclusion about
pilot supply.

GIT: five commits on main. ALL F5 WORK IS UNCOMMITTED. The user commits on their
own instruction, not on your schedule.

═══════════════════════════════════════════════════════════════════════════
5. ENVIRONMENT TRAPS — these have each cost real time
═══════════════════════════════════════════════════════════════════════════

Node 22.16.0 · npm 11.19.1 · PostgreSQL 17 · macOS. Pins and their reasons are in
each handover's §3. F5 added no dependencies — deliberately no `googleapis` SDK
and no `nodemailer`, because both own their own HTTP transport.

  • ** `npm run typecheck` runs TWO configs. ** tsconfig.backend.json covers
    src/test/tools with NO DOM lib — that is what makes a bare `fetch` there a
    TYPE error as well as a lint error and an AST failure. Never merge them.
  • ** `tsc --noEmit` is NOT run by `npm test`. ** vitest transpiles without
    typechecking. Run both. F5 hit this again.
  • ** A green suite does not mean the CLI works ** and tsc clean does not mean
    the suite passes. Both directions have bitten this project.
  • ** A green suite does not mean the PROVIDER behaves. ** F5's whole A9 finding
    came from a live run against a passing test suite. When a design rests on a
    third party's documented behaviour, measure it.
  • ** Never run `prisma db push`. ** It offers to drop D3's partial unique
    indexes. There is deliberately no db:push script.
  • ** `prisma migrate dev` cannot run non-interactively here. ** Use
    `prisma migrate diff --from-config-datasource --to-schema … --script`, READ
    the generated SQL, check every DROP is intended, then `migrate deploy`.
    F5's migration legitimately drops two indexes and replaces one of them in the
    same transaction — read it as the worked example.
  • ** Prisma's generator reads tsconfig.json, and `next build` rewrites it. **
    moduleFormat and importFileExtension are pinned in schema.prisma. Do not
    unpin them.
  • Run `npm run db:generate` after any migration before trusting a failure.
  • ** Run the verify:* scripts INDIVIDUALLY. ** Two in one shell once reported
    6/7 where each reports 7/7 alone.
  • .env holds SUPPRESSION_HMAC_SALT, write-once in practice: rotating it orphans
    every Suppression row (A10). It also now holds the Gmail OAuth client and the
    owned-inbox allowlist; the refresh token is NOT in .env — it is
    envelope-encrypted in secret_record under a Keychain KEK.
  • ** A cost:0 GateContext is meaningful and is not the default. ** It makes a
    request non-refusable by the budget and uncharged. That is how the mail
    transport passes through the gate without a research cap aborting an approved
    message. Do not "tidy" it to 1.

═══════════════════════════════════════════════════════════════════════════
6. YOUR TASK — F6 ONLY
═══════════════════════════════════════════════════════════════════════════

Read docs/F6-HANDOVER.md §8 for the full statement. In summary:

  1. The follow-up. Exactly one, 7–10 business days after the first touch, then
     stop. QUEUES.followUp, SendAttempt.touchNumber and cancelScheduledSends all
     exist and nothing schedules anything yet. Every stop reason must CANCEL it —
     A12: a paused job resumes on restart and sends the mail the operator
     stopped.
  2. The ramp, gated on MEASURED first-party signals, never on a calendar.
     capsForStage returns F6 week one (5/day, 3/domain). Part G's rollout
     criteria are the gate for 5→10 and 10→20; the counters already exist.
  3. The reply draft — handover.md §5's Inbox/Outcome Worker's second job, and
     the place the LLM gateway genuinely belongs (F6-HANDOVER §4.6).
  4. The dashboard's send queues. F3 §4.14's rule stands: a queue a later
     milestone fills renders "not built", never 0.
  5. The pilot measurement: 50 companies, and the numbers Part G actually needs.
  6. tools/verify-f6.ts, with isAtOrAfter and FLOORS ONLY — F6-HANDOVER §4.9
     records three verifiers that broke because they asserted a ceiling.
  7. docs/F7-HANDOVER.md.

** BEFORE YOU ENABLE SENDING — two independent acts, and they are separate on
purpose: **

    src/core/config/stage.ts     MILESTONE_STAGE = 'F6'      (a reviewed commit)
    .env                         SEND_EXTERNAL_RECIPIENTS_ENABLED=true
                                 SENDING_ENABLED=true

Neither alone changes anything, and test/policy/owned-inbox.test.ts pins that.
Part F's F5→F6 rollout criteria must actually be met first, and one that is not
in the plan but follows from F6-HANDOVER §4.4: ** re-COMPOSE the outstanding
draft, do not re-approve it ** — its stored body carries a file:// resume link
from before the resumes were hosted.

DO NOT BUILD IN F6: a bulk approval form or `send:run --all` (policy #6 is
unamended). Tier B lookup providers without the operator choosing a vendor and
reading its terms. The browser layer (F7, and only on measured need). Do not
change score weights — A11 freezes them until ≥100 sends. Do not raise the caps
on a schedule.

═══════════════════════════════════════════════════════════════════════════
7. YOUR REASON-CODE OBLIGATION — different from every previous milestone
═══════════════════════════════════════════════════════════════════════════

F6 owns NO new reason codes. All 40 are registered and 37 are reachable; the
remaining three are F7's browser layer. So:

  1. Set MILESTONE_STAGE = 'F6' in src/core/config/stage.ts, together with the
     env flag. That is the pilot switch, not a bump.
  2. Change the hardcoded 'F5' references to 'F6' in
     test/unit/reason-codes.test.ts and test/policy/reason-code-coverage.test.ts.
     ** The reachable list should NOT grow. If it does, something was registered
     to F6 that nobody built. **
  3. Keep every existing scenario driving a REAL path. The send-gate scenarios
     pin stage:'F5' deliberately, so they keep testing a gate rather than
     whatever the stage happens to be. Do not "fix" that to the current stage.

Note F5 had to rewrite the `sending_disabled` scenario when the stage moved,
because it had relied on the stage being the thing that refused. Check whether
any scenario you inherit depends on F5 being the current stage.

═══════════════════════════════════════════════════════════════════════════
8. RULES OF ENGAGEMENT
═══════════════════════════════════════════════════════════════════════════

  • Do not redesign the plan. Do not weaken its safeguards. Do not introduce
    scraping of gated platforms. Do not substitute unverified data sources for
    verified ones.
  • Verify endpoints and provider behaviour against primary sources AND against
    the live provider at implementation time; record what you verified. F5's
    single most important finding — that A9's reconciliation could not work as
    specified — came from a live probe against a fully green test suite.
  • Write tests as you go, not at the end. Part G's layers: pure unit → contract
    tests against both real-with-fixtures and fake adapters → policy tests (each
    a red-team attempt that must fail closed) → state-machine property tests →
    golden tests per prompt version → end-to-end dry run.
  • Coverage rule: every reason code in the closed enum must be reachable by a
    test.
  • Comment the WHY, not the what. Match the density and voice of the existing
    code, which cites the plan's ids (A1, B6, D4, H5…).
  • MEASURE rather than assume. Every milestone has found something real by
    measuring. F5 found four: a hash that bound nothing, a hash that matched over
    a dead link, a reconciliation refused by our own rate limiter, and A9's
    central mechanism not existing on the provider.
  • Ask before anything irreversible or outward-facing. ** F6 sends to people who
    did not ask to hear from us. Every send is both. ** Nine commands now touch a
    live source: ingest:seed, fixtures:record, intel:run --research N,
    contacts:curate, gmail:auth, send:test, send:run, inbox:sync, and whatever F6
    adds for the follow-up.
  • ** STOP FOR REVIEW BEFORE F7. ** Finish F6, run the pilot only as far as the
    operator authorises, write docs/F7-HANDOVER.md, and stop.
  • Git: commit on the user's instruction, not on your own schedule.

Start by reading the ten documents in section 1 — F6-HANDOVER most carefully, and
§2.3 and §4.4 before anything else — then confirm your understanding of what is
already built and what remains, and flag anything you think is wrong BEFORE
writing code.

Two notes on what is deliberately left out of this prompt. The deviation chain and
the live numbers are not inlined, because F6-HANDOVER carries them and a pasted
copy drifts from the file. And the F6 task is summarised rather than specified,
because §8 of that document is the specification and the summary above exists only
to tell you which part to read first.
