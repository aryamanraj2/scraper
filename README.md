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
| `docs/F2-HANDOVER.md` | What F1 built, every deviation, and the F2 task. **Point a new session at this.** |
| `docs/handoff-llm-gateway.md` | How the LLM role works: the app queues judgment tasks, a Claude Code session fulfils them. Built at F2. |

Two documents govern this repo:

- **`handover.md`** — the policy spine. §1's non-negotiables are binding: no
  founder/CEO targeting, no inferred or purchased emails, no LinkedIn or
  gated-platform automation, no evasion of CAPTCHAs, login walls, robots rules or
  rate limits, provenance on every fact, and no send without human approval.
- **The architecture plan** — overrides `handover.md` wherever they conflict.
  Defect ids (A1–A12) and verification ids (B1–B7) referenced in code comments
  point at it.

## Status: F1 complete

F0 made the safeguards structural. F1 adds ingestion: a yc-oss seed loader, domain
canonicalization, ATS detection with Lever slug resolution, and the three required
adapters — Greenhouse, Lever and Ashby. Still no scoring, no drafting, no sending,
and no optional adapter.

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

Run `npm run verify:f0` and `npm run verify:f1` for the criteria in one report each.

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
| `npm run ingest:seed` | **Live.** yc-oss seed, ATS detection, postings. `-- --limit 150` |
| `npm run ingest:seed -- --postings-only` | **Live.** Refresh known boards only; skips the slow detection pass |
| `npm run fixtures:record` | **Live.** Re-capture one real response per source into `test/fixtures/` |
| `npm run typecheck` / `npm run lint` | TypeScript and ESLint |
| `npm run db:migrate` | Apply migrations (dev) |
| `npm run check:no-raw-http` | Fail if anything outside the gate can reach the network |

## Three things that will bite you if you don't know them

**Never run `prisma db push`.** The two partial unique indexes from D3 cannot be
expressed in `schema.prisma` and live in a hand-written SQL migration. `db push`
reports them as drift and offers to drop them — and dropping them is what lets one
`careers@` alias receive four first-touch emails in a cycle (A2). There is
deliberately no `db:push` script.

**Only `src/core/policy/http/raw-client.ts` may reach the network.** Adapters
receive a `FetchPolicyGate`, never a client. Three layers enforce this: ESLint, the
AST scanner in `tools/check-no-raw-http.ts` (part of `npm test`), and a
transport-level test using undici's `MockAgent` with net connect disabled.

**Sending needs two independent factors.** `SENDING_ENABLED=true` alone does
nothing: `src/core/config/stage.ts` carries a `MILESTONE_STAGE` constant that only
a reviewed commit changes, and sending stays refused with `sending_disabled` until
it reaches `F5`.

**Only two commands touch a live source**, and neither runs in `npm test`:
`ingest:seed` and `fixtures:record`. Both go through `FetchPolicyGate`, so a
fixture can never describe a capability the pipeline does not have. Everything else
replays `test/fixtures/` through undici's `MockAgent` with net connect disabled.

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
test/fixtures/                real responses, captured through the gate
tools/                        AST guard, verifiers, seeders, fixture recorder
```
