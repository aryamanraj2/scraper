# Internship Outreach Intelligence

A local, review-first system that turns a broad universe of startups into a small,
credible queue of internship opportunities. It prepares applications and drafts;
it never sends without explicit human approval, and it never submits an application
on your behalf.

## Start here

| File | What it is |
|---|---|
| `handover.md` | The original brief. §1's non-negotiable policies are binding. |
| `docs/architecture-plan.md` | The approved architecture plan, verbatim. The implementation contract. |
| `docs/F1-HANDOVER.md` | What F0 built, every deviation from the plan and why, and the F1 task. |
| `docs/F2-HANDOVER.md` | What F1 built, every deviation, and the F2 task. |
| `docs/F3-HANDOVER.md` | What F2 built, every deviation, and the F3 task. |
| `docs/F4-HANDOVER.md` | What F3 built, every deviation, and the operator's volume-outreach scope amendment (§10), which is still binding. |
| `docs/F5-HANDOVER.md` | What F4 built, F4's twelve deviations, the Tier A yield number, and the F5 task. |
| `docs/F6-HANDOVER.md` | What F5 built, F5's deviations, and the F6 task — the controlled pilot. **Point a new session at this.** |
| `docs/handoff-llm-gateway.md` | How the LLM role works: the app queues judgment tasks, a Claude Code session fulfils them. Built in F2; carries the message-composition kind as of F4. |

Two documents govern this repo:

- **`handover.md`** — the policy spine. §1's non-negotiables are binding: no
  founder/CEO targeting, no inferred or purchased emails, no LinkedIn or
  gated-platform automation, no evasion of CAPTCHAs, login walls, robots rules or
  rate limits, provenance on every fact, and no send without human approval.
- **The architecture plan** — overrides `handover.md` wherever they conflict.
  Defect ids (A1–A12) and verification ids (B1–B7) referenced in code comments
  point at it.

## Status: F5 complete — send readiness, to owned inboxes only

F0 made the safeguards structural. F1 added ingestion: a yc-oss seed loader, domain
canonicalization, ATS detection with Lever slug resolution, and the three required
adapters — Greenhouse, Lever and Ashby. F2 added intelligence: the four-track role
taxonomy and a deterministic matcher, a scorer rebuilt to exactly 100 against a
versioned weight set, `SignalGraphService` enforcing D4's source precedence as a hard
floor, static fetch + Readability through the preflight, Firecrawl escalation behind
a flag, ATS job-count deltas, and the `HandoffLlmGateway`.

**F3 is the payload.** It generates `ApplicationPacket`s — a track-tailored resume, the
employer's own application URL, and prefilled answers drawn only from `ApprovedClaim` —
plus a Next.js dashboard with the review queues and the evidence viewer.

**F4 adds the outreach half.** A Tier A contact curator reads recruiting aliases off
employer careers pages through the gate — never a founder, never an inferred address —
and a composer turns a qualified lead into a short message where **every sentence about
the company cites an `Evidence` row and every sentence about you cites an
`ApprovedClaim`**. An uncited sentence is a schema error, not a review finding. A
Quality Gate with versioned checks runs before a human ever sees a draft, and approval
freezes an `approval_hash` over A7's exact field list.

**F5 makes sending possible, and keeps it off real people.** The Gmail adapter runs on
`gmail.modify` through `FetchPolicyGate` like every other request; A9's deterministic
`Message-ID` is derived from the idempotency key and persisted **before** the API call,
so a crash mid-send reconciles with an `rfc822msgid:` search instead of sending twice.
D6's send gate is one choke point evaluating eleven conditions in one transaction.
Bounces classify hard or soft, and **a soft bounce stops the conversation without
permanently suppressing anyone** (A12).

**`MILESTONE_STAGE` now reads `F5`, and that unlocks less than it sounds like.**
Sending still needs `SENDING_ENABLED` as a second factor, and the send gate refuses
every recipient that is not on `OWNED_INBOXES`. Lifting that needs the F6 stage **and**
`SEND_EXTERNAL_RECIPIENTS_ENABLED` — two acts, neither automatic. Part F's F5
deliverable is "verified sends to owned inboxes only"; F6 is "enable sending".

**The system prepares applications; it never submits them** (H8).

```bash
npm run seed:operator     # your resumes and approved claims
npm run packets:run       # generate application packets — no network
npm run contacts:curate -- --limit 5     # LIVE: read careers pages for aliases
npm run drafts:run                       # compose drafts — no network
npm run drafts:run -- --queue            # queue the judgment sentences
npm run llm:next -- --kind outreach_draft   # drain them from a Claude Code session
npm run drafts:run -- --drain            # merge, then run the Quality Gate
npm run gmail:auth                       # once: OAuth consent, refresh token enveloped
npm run send:test -- --to you+f5a@gmail.com   # LIVE: owned inbox only, checks A9 + SPF/DKIM
npm run send:run -- --list               # what the gate says about each approved draft
npm run send:run -- --dry --id <draftId> # evaluate the gate, send nothing
npm run inbox:sync                       # LIVE: classify replies and bounces
npm run dev               # the dashboard, http://localhost:3000
```

**Tier A yield, measured live across all 21 qualified companies:** 19 were actually
read, 4 published a usable address, 15 published none — and **not one published a
dedicated recruiting alias**. All four hits are general `info@`/`hello@` inboxes. That
is the number that decides whether a paid lookup provider is worth buying, and it says
employer pages alone will not reach the operator's 1,000–2,000 target. See
`docs/F5-HANDOVER.md` §2.2.

| F5 exit criterion | Where it is proven |
|---|---|
| Crash mid-send issues no second send (A9) | `test/policy/send-gate.test.ts`; `npm run verify:f5` |
| Owned inboxes only, and lifting it needs two acts | `test/policy/owned-inbox.test.ts`; `npm run verify:f5` |
| `approval_hash` mismatch aborts the send | `test/policy/send-gate.test.ts` |
| A soft bounce never permanently suppresses (A12) | `test/policy/outcome-ingestion.test.ts`; `npm run verify:f5` |
| Same human never emailed twice in a cycle | `test/integration/send-attempt-indexes.test.ts` |
| First-party counters only; no reputation source | `npm run verify:f5` |
| All 15 F5 reason codes reachable | `test/policy/reason-code-coverage.test.ts` |

| F4 exit criterion | Where it is proven |
|---|---|
| Every personalization sentence cites evidence | `test/policy/outreach-draft.test.ts`; `npm run verify:f4` |
| Every candidate sentence cites an `ApprovedClaim` | `test/policy/outreach-draft.test.ts` |
| No founder/CEO/executive contact can be created | `test/policy/contact-curation.test.ts`; `verify:f4` re-runs the filter over every stored row |
| No `Contact` without an `Evidence` row | `Contact.evidenceId` is a required column; `npm run verify:f4` |
| The outreach predicate rejects every path outside the four cases | `test/policy/reason-code-coverage.test.ts` — Part G's most important policy test |
| `approval_hash` frozen, compared byte-for-byte | `test/policy/outreach-draft.test.ts` |
| A draft cannot cite evidence about another company | `test/policy/outreach-draft.test.ts` |
| Zero external sends | `npm run verify:f4` |

| F3 exit criterion | Where it is proven |
|---|---|
| 30 reviewable application packets | `npm run verify:f3` against `outreach_dev` |
| Every packet reconstructible from evidence | `npm run verify:f3`; `test/policy/application-packet.test.ts` |
| Prefilled answers come only from `ApprovedClaim` | `test/policy/application-packet.test.ts` |
| Browser- and API-derived facts display identically | `test/policy/application-packet.test.ts` |
| Nothing auto-submits (H8) | `test/policy/application-packet.test.ts`; `npm run verify:f3` |
| `application_submitted` reachable through a real path | `test/policy/reason-code-coverage.test.ts` |

| F2 exit criterion | Where it is proven |
|---|---|
| Every score explainable from stored components | `npm run verify:f2`; `test/unit/scoring.test.ts` |
| Score sums to exactly 100 per `ScoreVersion` | `test/unit/scoring.test.ts` |
| Research budget observably caps spend | `test/policy/page-research.test.ts` |
| Preflight refusals recorded, not retried around | `test/policy/signal-graph-precedence.test.ts` |
| Source precedence is a hard floor | `test/policy/signal-graph-precedence.test.ts` |
| All five F2 reason codes reachable | `test/policy/reason-code-coverage.test.ts` |

| F1 exit criterion | Where it is proven |
|---|---|
| 100-200 normalized companies | `npm run verify:f1` against `outreach_dev` |
| Live postings attached | `npm run verify:f1`; `test/integration/ats-ingest.test.ts` |
| Every field traceable to an `Evidence` row | `test/integration/seed-loader.test.ts`, `test/integration/ats-ingest.test.ts` |
| No optional adapter built | `npm run verify:f1` scans `src/` |
| Milestone bumped honestly | `test/unit/reason-codes.test.ts`, `test/policy/reason-code-coverage.test.ts` |
| Contract tests, fixtures and fakes | `test/integration/ats-adapters.test.ts` |

| F0 exit criterion | Where it is proven |
|---|---|
| Migrations apply | `test/integration/send-attempt-indexes.test.ts` |
| Reason-code enum complete | `test/unit/reason-codes.test.ts`, `test/policy/reason-code-coverage.test.ts` |
| Secrets round-trip without touching logs | `test/integration/secret-store.test.ts` |
| No HTTP client reachable outside the gate | `test/policy/no-raw-http.test.ts`, `test/policy/fetch-policy-gate.test.ts` |

Run `npm run verify:f0` through `npm run verify:f3` for the criteria in one report each.

## Setup

```bash
brew install postgresql@17 && brew services start postgresql@17
createdb outreach_dev && createdb outreach_test

cp .env.example .env          # then fill DATABASE_URL / TEST_DATABASE_URL
npm install
npm run db:migrate
npm run seed:hosts            # writes the static allow/deny lists into host_policy
```

The secret store reads its key-encryption key from the macOS Keychain. Provision it
once:

```bash
security add-generic-password -s outreach-intelligence -a kek \
  -w "$(openssl rand -base64 32)" -U
```

## Commands

| Command | What it does |
|---|---|
| `npm test` | AST guard, then the whole suite offline against fixtures |
| `npm run verify:f0` | The four F0 exit criteria, individually reported |
| `npm run verify:f1` | The seven F1 exit criteria, individually reported |
| `npm run verify:f2` | The seven F2 exit criteria, individually reported |
| `npm run verify:f3` | The eleven F3 exit criteria, individually reported |
| `npm run verify:f4` | The thirteen F4 exit criteria, individually reported |
| `npm run verify:f5` | The fifteen F5 exit criteria, individually reported |
| `npm run gmail:auth` | **Live.** One-time OAuth consent; stores the refresh token enveloped |
| `npm run send:test` | **Live.** Sends a diagnostic to an owned inbox only, at every stage |
| `npm run send:run -- --list` | What D6's gate says about every approved draft. No network |
| `npm run send:run -- --id <id>` | **Live.** Transmit one approved draft. There is deliberately no `--all` |
| `npm run send:run -- --reconcile` | A9 recovery: reconcile in-flight attempts. Never sends |
| `npm run inbox:sync` | **Live.** Read-only: classify replies and bounces, write outcomes |
| `npm run contacts:curate` | **Live.** Read employer pages for recruiting aliases. `-- --all --max-pages 5` |
| `npm run contacts:curate -- --report` | The Tier A yield report only. No network |
| `npm run drafts:run` | Compose outreach drafts from stored rows. No network |
| `npm run drafts:run -- --queue` / `--drain` / `--gate` | Queue the judgment sentences, merge them, run the Quality Gate |
| `npm run drafts:run -- --approve <id> --by <name>` | Freeze `approval_hash` over A7's field list |
| `npm run seed:operator` | Load your four resumes (hashed from disk) and your approved claims |
| `npm run packets:run` | Generate application packets from stored rows. No network |
| `npm run packets:run -- --drain` | Write fulfilled LLM tasks into `ResearchBrief` and merge packet answers |
| `npm run dev` | The review dashboard (Next.js) |
| `npm run intel:run` | Score the corpus from stored rows. No network unless `--research N` |
| `npm run intel:run -- --research 40` | **Live.** Walk the signal graph and research up to N companies |
| `npm run intel:run -- --briefs` | Queue a research brief per qualified lead |
| `npm run llm:list` / `llm:next` / `llm:fulfil` / `llm:reject` | Drain the judgment backlog from a Claude Code session |
| `npm run seed:tracks` | Seed the four `RoleTrack` rows from the taxonomy |
| `npm run seed:budget` | Open the global monthly research envelope (default 1,000 credits) |
| `npm run ingest:seed` | **Live.** yc-oss seed, ATS detection, postings. `-- --limit 150` |
| `npm run ingest:seed -- --postings-only` | **Live.** Refresh known boards only; skips the slow detection pass |
| `npm run fixtures:record` | **Live.** Re-capture one real response per source into `test/fixtures/` |
| `npm run typecheck` / `npm run lint` | TypeScript and ESLint |
| `npm run db:migrate` | Apply migrations (dev) |
| `npm run check:no-raw-http` | Fail if anything outside the gate can reach the network |

## Six things that will bite you if you don't know them

**Never run `prisma db push`.** The two partial unique indexes from D3 cannot be
expressed in `schema.prisma` and live in a hand-written SQL migration. `db push`
reports them as drift and offers to drop them — and dropping them is what lets one
`careers@` alias receive four first-touch emails in a cycle (A2). There is
deliberately no `db:push` script.

**Only `src/core/policy/http/raw-client.ts` may reach the network.** Adapters
receive a `FetchPolicyGate`, never a client. Three layers enforce this: ESLint, the
AST scanner in `tools/check-no-raw-http.ts` (part of `npm test`), and a
transport-level test using undici's `MockAgent` with net connect disabled.

**Sending needs two independent factors, and reaching a real person needs two more.**
`SENDING_ENABLED=true` alone does nothing: `src/core/config/stage.ts` carries a
`MILESTONE_STAGE` constant that only a reviewed commit changes. Both are now satisfied
— and the send gate still refuses every recipient that is not on `OWNED_INBOXES`,
until the stage reaches F6 **and** `SEND_EXTERNAL_RECIPIENTS_ENABLED` is set.
`src/outreach/send/recipient-policy.ts`.

**Eight commands touch a live source**, and none runs in `npm test`:
`ingest:seed`, `fixtures:record`, `intel:run -- --research N`, `contacts:curate`,
and F5's four — `gmail:auth`, `send:test`, `send:run`, `inbox:sync`. All four go through `FetchPolicyGate`, so a fixture can never
describe a capability the pipeline does not have. Everything else replays
`test/fixtures/` through undici's `MockAgent` with net connect disabled.
`packets:run`, `drafts:run` and the dashboard touch nothing.

**`npm run typecheck` runs two TypeScript configs.** `tsconfig.backend.json` covers
`src/`, `test/` and `tools/` with **no DOM lib**, which is what makes a bare `fetch`
there a type error as well as a lint error and an AST-scanner failure. The root
`tsconfig.json` is Next's and needs `lib: DOM`. Merging them would silently delete one
of the three layers keeping `FetchPolicyGate` the only network path.

**The system never submits an application.** H8 is the one decision in Part H marked
irreversible. Greenhouse exposes an authenticated submission endpoint; no code path
here calls it, and a test scans every source file to keep it that way. The dashboard's
button is labelled "I applied", not "Apply".

## Layout

```
prisma/schema.prisma          Part D data model; migrations/ holds the partial indexes
src/core/config/              env parsing, milestone stage guard
src/core/reason-codes/        the closed enum + milestone registry
src/core/crypto/              envelope encryption, keychain/env key providers
src/core/logging/             redaction applied at the sink
src/core/policy/              FetchPolicyGate, host lists, robots, rate, budget
src/core/queue/               pg-boss bootstrap + transactional enqueue
src/core/interfaces/          provider seams (F1-F5) and the deferred browser seam (F7)
src/core/evidence/            content hashing and the provenance writer
src/ingest/domain/            canonicalization (registrable domain, PSL-backed)
src/ingest/yc/                yc-oss SeedProvider and the seed loader
src/ingest/ats/               detection signatures + Greenhouse/Lever/Ashby adapters
src/ingest/host/              the derived_company host allow rows F1 owes the gate
src/ingest/budget/            per-company research envelopes (H5)
src/core/llm/                 LlmTask registry + the handoff gateway and its validation
src/intel/taxonomy/           the four role tracks and the deterministic matcher
src/intel/scoring/            ScoreVersion, the pure scorer, the collector, persistence
src/intel/research/           fetch + Readability, injection scanning, Firecrawl escalation
src/intel/signals/            ATS job-count deltas (B2)
src/intel/signal-graph.ts     D4 source precedence as a hard floor
src/apply/                    ApprovedClaim library, packet generation, the evidence viewer
src/outreach/contacts/        the Tier A curator, the executive filter, the yield report
src/outreach/draft/           the composer, the citation choke point, Quality Gate, approval_hash
src/outreach/mail/            the Gmail adapter, the deterministic Message-ID, the MIME builder
src/outreach/send/            D6's send gate, A9's idempotent send, caps, breaker, outcome ingestion
test/fixtures/                real responses, captured through the gate
tools/                        AST guard, verifiers, seeders, fixture recorder
```
