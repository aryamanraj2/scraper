# Internship Outreach Intelligence

A local, review-first system that turns a broad universe of startups into a small,
credible queue of internship opportunities. It prepares applications and drafts;
it never sends without explicit human approval, and it never submits an application
on your behalf.

Two documents govern this repo:

- **`handover.md`** — the policy spine. §1's non-negotiables are binding: no
  founder/CEO targeting, no inferred or purchased emails, no LinkedIn or
  gated-platform automation, no evasion of CAPTCHAs, login walls, robots rules or
  rate limits, provenance on every fact, and no send without human approval.
- **The architecture plan** — overrides `handover.md` wherever they conflict.
  Defect ids (A1–A12) and verification ids (B1–B7) referenced in code comments
  point at it.

## Status: F0 complete

F0 ships no ingestion, no scoring, no drafting and no sending. It exists to make
the later milestones' safeguards structural rather than conventional.

| F0 exit criterion | Where it is proven |
|---|---|
| Migrations apply | `test/integration/send-attempt-indexes.test.ts` |
| Reason-code enum complete | `test/unit/reason-codes.test.ts`, `test/policy/reason-code-coverage.test.ts` |
| Secrets round-trip without touching logs | `test/integration/secret-store.test.ts` |
| No HTTP client reachable outside the gate | `test/policy/no-raw-http.test.ts`, `test/policy/fetch-policy-gate.test.ts` |

Run `npm run verify:f0` for the four criteria in one report.

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
tools/                        AST guard, F0 verifier, host-policy seeder
```
