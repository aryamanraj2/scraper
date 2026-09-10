# F1 Handover — Ingestion

**Written:** 2026-09-08, at the end of the F0 session.
**For:** the next implementation session, which builds F1 and nothing else.
**Status of the repo when this was written:** F0 complete and verified, 4/4 exit criteria met, 86 tests passing, nothing committed to git yet.

---

## 0. Read these first, in this order

| File | What it is | Binding? |
|---|---|---|
| `handover.md` | The original brief. **§1's non-negotiable policies are binding and are not restated anywhere else.** | Yes, except where the plan overrides |
| `docs/architecture-plan.md` | The approved architecture plan, verbatim. Defect ids (A1–A12), verification ids (B1–B7), design (Part D), build order (Part F), tests (Part G), decisions (Part H). | **Yes — this is the implementation contract** |
| `docs/F1-HANDOVER.md` | This file. What F0 actually built, every deviation from the plan and why, and the F1 task. | Yes |
| `docs/handoff-llm-gateway.md` | How the LLM role works in this project: the app queues judgment tasks, a Claude Code session fulfils them. Standalone so it survives every handover unchanged. | Yes |
| `README.md` | Setup and the three things that bite. | Informational |

Do not redesign the plan. Do not weaken its safeguards. Do not introduce scraping of gated platforms. Do not substitute unverified data sources for verified ones.

### The five rules that outrank convenience

1. **Never automate LinkedIn or any gated platform.** `handover.md` §1.4. Enforced at the transport layer by `FetchPolicyGate`, with a test asserting zero sockets.
2. **Never infer an email address, and never target founders/CEOs/executives.** §1.1, §1.2.
3. **Every network request goes through `FetchPolicyGate`.** No exceptions, no "just this once for a fixture". There is an AST scanner that fails the build.
4. **Sending stays hard-disabled until F5** — enforced by `MILESTONE_STAGE` in source, not just an env var.
5. **Provenance on every fact.** If a value in the database cannot be traced to an `Evidence` row with a verbatim excerpt and a source URL, it does not belong there.

---

## 1. What this system is, in one paragraph

A local, review-first system that turns a broad universe of startups into a small queue of internship opportunities across four tracks (iOS/Android, AI Engineer, SDE, SWE), prioritising India then remote-viable US/UK/EU. **The terminal action is an application, not an email** (Part C). The system prepares application packets; the user submits them by hand. Cold outreach is permitted in exactly three named cases and never sends without per-message human approval. It is deliberately not a bulk-email system.

---

## 2. Where the project stands

### F0 is complete

```
npm test          → 12 files, 86 tests passed
npm run verify:f0 → 4/4 criteria met
npm run typecheck → clean
npm run lint      → clean
```

| F0 exit criterion (Part F) | Evidence |
|---|---|
| Migrations apply | 28 tables; both D3 partial indexes present after a clean apply |
| Reason-code enum complete | 39 codes, registry↔enum bijective in both directions |
| Secrets round-trip without touching logs | 10 tests, incl. stdout/stderr/AuditLog scan for the plaintext |
| No HTTP client reachable outside the gate | 31 tests, incl. transport-level "zero sockets to linkedin.com" |

### Nothing is committed

`git log` is empty — branch `main`, zero commits. `.gitignore` is written and verified (`.env` ignored, `.env.example` tracked, `generated/` ignored). The user commits when they choose.

### What F0 deliberately did NOT build

No yc-oss loader, no ATS adapters, no scorer, no Firecrawl, no Gmail adapter, no LLM call, no UI, no browser layer, and **no live network request of any kind**. The D5 interfaces exist as types with zero implementations, so F1 has a seam to fill and F0 has nothing that can accidentally run.

---

## 3. Environment — read before running anything

### Toolchain, and why each pin is what it is

| Package | Pin | Why not `latest` |
|---|---|---|
| `prisma` / `@prisma/client` | `7.10.0` | npm `latest` for the CLI is `8.0.0-rc.13`, a **release candidate**. `7.10.0` is the `prev`/stable tag. pg-boss's Prisma transaction adapter requires Prisma v7+. |
| `@prisma/adapter-pg` | `7.10.0` | Required by pg-boss `fromPrisma`. Prisma 7 constructs the client with a driver adapter, not a URL. |
| `pg-boss` | `12.30.0` | Requires Node ≥22.12.0 and PostgreSQL ≥13. |
| `undici` | `7.16.0` | `undici@8` requires Node ≥22.19.0; this machine runs 22.16.0. |
| `vitest` | `4.1.11` | `5.0.0` just took `latest`. Also: vitest 4 removed the `basic` reporter. |
| `typescript` | `5.9.3` | `latest` is `7.0.2`, the new Go compiler — not worth de-risking Prisma 7 + typescript-eslint against. |
| `eslint` | `10.10.0` | 9.x is deprecated; typescript-eslint 8.70 peers `^10.0.0`. |
| Node | 22.16.0 | Satisfies pg-boss's floor. |
| PostgreSQL | `postgresql@17` via Homebrew | Was not installed; F0 installed it. |

### Two environment traps that cost time in F0

**npm.** npm 11.5.2 crashes installing `vitest@4` with `TypeError: Cannot read properties of null (reading 'edgesOut')` in arborist's `#loadPeerSet`. Fixed in **npm 11.19.1**, which is now installed globally (user approved). Do not downgrade npm.

**Install scripts.** npm 11.19.1 blocks package install scripts by default. `package.json` carries an `allowScripts` block approving `prisma`, `@prisma/engines`, `esbuild`, `fsevents`. If you add a dependency with a postinstall, `npm install-scripts approve <pkg>` and commit the change.

### Setup from a clean clone

```bash
brew install postgresql@17 && brew services start postgresql@17
createdb outreach_dev && createdb outreach_test
cp .env.example .env      # set DATABASE_URL / TEST_DATABASE_URL with your pg user
npm install
npm run db:migrate
npm run seed:hosts
security add-generic-password -s outreach-intelligence -a kek \
  -w "$(openssl rand -base64 32)" -U
```

`.env` is gitignored. It holds `SUPPRESSION_HMAC_SALT`, which is **write-once in practice**: rotating it orphans every existing `Suppression` row, which is how someone who asked never to be contacted becomes contactable again (A10).

---

## 4. Deviations from the plan — every one, with its reason

The plan is the contract, but implementation surfaced things it did not anticipate. Each of these was a deliberate decision. **Do not silently revert any of them; if you disagree, raise it with the user.**

### 4.1 D4 step 1 was ambiguous — resolved

The plan's step 1 requires "host is on the allowlist and not on the denylist", but step 2 also describes behaviour "for non-allowlisted hosts", implying non-allowlisted hosts are sometimes fetchable. Those cannot both be literal.

**Resolution now in code:**
- A `deny` entry is permanent and beats everything, including a future `allow` row for the same host. Checked against the static seed list first, so a denied host is unreachable even with an empty database.
- An explicit `allow` entry passes to the next check.
- An **unknown host is refused with `host_denied`** unless a `derived_company` allow entry exists for it.
- A missing or unparseable `robots.txt` is restrictive for any host without an explicit allow entry.

**This is a direct F1 obligation.** Employer careers domains are not fetchable until F1 creates their `HostPolicy` allow row with `origin: 'derived_company'` and provenance. See §8.4.

### 4.2 `outreach_case` is a named enum, not `Int`

Plan says `outreach_case ∈ {1,2,3}`. Prisma cannot express a `CHECK` constraint, so an `Int` column would be unconstrained at the database. The enum is strictly stronger and self-documenting. `OUTREACH_CASE_NUMBER` in `src/core/policy/outreach-case.ts` maps the three values to the plan's 1/2/3 and is asserted by test.

### 4.3 `ResearchBudget.companyId` — plan-implied schema was contradictory

Modelling it as both column-unique and part of `@@unique([companyId, periodMonth])` permits only one budget row per company *ever*, which contradicts a monthly cap. Column-level unique dropped; `Company.researchBudgets` is a list. The global monthly envelope is the row with `companyId = null`.

### 4.4 pg-boss send queues use policy `stately`, and a mismatch throws

Under pg-boss's default `standard` policy, `singletonKey` **does not deduplicate at all** — two racing schedulers produce two jobs, which for a send queue is precisely the double-send A9 exists to prevent. `send.draft` and `send.followUp` are created with policy `stately`.

pg-boss refuses to change a queue's policy after creation, and `createQueue` is a silent no-op on an existing queue. So `createBoss` **throws** on a policy mismatch rather than continuing, because continuing would leave a send queue running with dedup silently off. If you hit that error: drain, `boss.deleteQueue(name)`, restart.

### 4.5 `Evidence` is the provenance table; `CompanySignal` references it

The plan lists both `Evidence` (D5) and `CompanySignal` (`handover.md` §4) and says "keep every table §4 names". Duplicating source URL / excerpt / timestamp across both invites them to disagree. `CompanySignal` keeps its name and now carries `evidenceId`; provenance lives on `Evidence` only.

### 4.6 `erasableSyntaxOnly` removed from tsconfig

It bans TypeScript parameter properties. We run through `tsx`, not `node --strip-types`, so the restriction bought nothing and cost idiomatic constructors.

### 4.7 `types/robots-parser.d.ts` overrides a broken published typing

`robots-parser@3.0.1` ships an `index.d.ts` whose first line is the shorthand ambient `declare module 'robots-parser';` followed by a real `export default function`. TypeScript resolves the default import to the module namespace, so it is not callable. The override is mapped in via tsconfig `paths`; runtime resolution still loads the real package.

### 4.8 `undici.request` is used explicitly, never global `fetch`

This is load-bearing for testing, not stylistic. undici's `MockAgent` only intercepts the dispatcher it is installed on, and Node's global `fetch` may be backed by a different undici instance. Going through the package directly puts the test suite's `disableNetConnect()` in the real request path — which is what makes Part G's *"assert zero HTTP requests to the host, at transport layer not adapter"* an assertion about sockets rather than about adapter behaviour.

Also: undici 7 does not follow redirects unless a redirect interceptor is installed, and we deliberately do not install one. A cross-origin redirect would escape the host the preflight just approved. A 3xx returns as a 3xx and the gate re-runs its checks on the target.

### 4.9 The LLM is the operator's Claude Code session, not the Claude API

**This is the largest deviation and it was a user decision.** See §7 for the full design.

Plan Part E names "Claude API via `LlmGateway`" as the one separately-billed component. The user has chosen instead to have their Claude Code session play that role, making marginal LLM cost zero. H10 already required the pipeline to work with the LLM disabled, so the seam exists; this adds a third implementation rather than changing the architecture.

The boundary that makes it safe: **code does the transport and the arithmetic; the session does the judgment.** The session never fetches. It works from `Evidence` rows that `FetchPolicyGate` already captured, so provenance stays verbatim and scraped page text arrives as data in a task payload rather than as instructions to something holding Bash and database access. That last point is Part G's prompt-injection row, and it is the reason the boundary is drawn where it is.

---

## 5. F0 as built — the map

```
prisma/
  schema.prisma                      957 lines, Part D data model
  migrations/
    20260908131306_init/             all 27 tables + enums
    20260908131400_partial_unique_indexes/   D3, hand-written SQL
    20260908132319_research_budget_monthly/  §4.3 fix
prisma.config.ts                     Prisma 7 moved the datasource URL here
src/core/
  config/stage.ts                    MILESTONE_STAGE, the send lock
  config/config.ts                   zod env parsing, resolveSendingEnabled
  reason-codes/registry.ts           39 codes, each mapped to its owning milestone
  db/client.ts                       PrismaClient + @prisma/adapter-pg
  audit/audit-log.ts                 append-only writer, countRefusalsByReason
  crypto/                            envelope encryption, keychain + env providers
  logging/redact.ts                  applied at the sink, not the call site
  logging/logger.ts
  killswitch/kill-switch.ts          global | domain | account
  policy/host-lists.ts               7 static allow, 14 static deny
  policy/host-policy.ts              resolveHostPolicy, seedHostPolicies
  policy/robots.ts                   robots-parser + TTL cache
  policy/rate-limit.ts               per-host spacing, effectiveDelayMs
  policy/budget.ts                   company + global monthly envelopes
  policy/outreach-case.ts            Part C predicate
  policy/fetch-policy-gate.ts        ← the only path to the network
  policy/http/raw-client.ts          ← the only file that may import undici
  queue/boss.ts                      pg-boss bootstrap, QUEUES, cancelScheduledSends
  queue/enqueue.ts                   fromPrisma transactional enqueue
  interfaces/providers.ts            D5 seams, types only
  interfaces/browser.ts              F7 seam, types only
test/
  setup.ts                           MockAgent + disableNetConnect
  global-setup.ts                    prisma migrate deploy against TEST_DATABASE_URL
  helpers/db.ts                      testDb(), truncateAll()
  unit/  integration/  policy/       12 files, 86 tests
tools/
  check-no-raw-http.ts               AST scanner, runs as part of npm test
  verify-f0.ts                       the four exit criteria, reported individually
  seed-host-policies.ts
types/robots-parser.d.ts
```

### The invariants a new session must not break

**`FetchPolicyGate` is the only network path.** Three layers enforce it, because any one alone is escapable:
1. `eslint.config.js` bans `undici`, `axios`, `got`, `node-fetch`, `node:http(s)` imports and the bare `fetch` global everywhere except `raw-client.ts` and `test/setup.ts`.
2. `tools/check-no-raw-http.ts` walks the TypeScript AST across `src/`, `test/` and `tools/` and fails `npm test`. It catches static imports, `require`, dynamic `import()`, bare globals, and any module reaching around the gate into `raw-client` directly.
3. The transport-level tests in `test/policy/`.

**Never run `prisma db push`.** The two D3 partial unique indexes cannot be expressed in `schema.prisma`. `db push` reports them as drift and offers to drop them, and dropping them is what lets one `careers@` alias receive four first-touch emails in a cycle (A2). There is deliberately no `db:push` script.

**Sending needs two independent factors.** `resolveSendingEnabled()` returns enabled only when `MILESTONE_STAGE >= 'F5'` **and** the env flag is set. `test/unit/stage-guard.test.ts` asserts that `SENDING_ENABLED=true` still yields `false` today. Raising `MILESTONE_STAGE` past `F4` is a reviewed act, not a config change.

**Redaction happens at the sink.** `Logger` and `writeAudit` both run everything through `redact()`. Do not add a new sink that bypasses it.

**`Evidence.excerpt` is `VARCHAR(500)` and verbatim.** D5 says "verbatim, <=500 chars, never paraphrased". The column type enforces the length; you enforce the verbatim part. A paraphrase in this column silently destroys `handover.md` §11's reconstruction criterion.

---

## 6. The reason-code mechanism — you WILL need to touch this

`src/core/reason-codes/registry.ts` maps all 39 codes to the milestone that owns them. Part G's coverage rule — *every reason code must be reachable by a test* — is made mechanical by two tests:

- `test/unit/reason-codes.test.ts` asserts registry↔Prisma-enum bijection in both directions, plus an **explicitly enumerated list** of the codes reachable at `'F0'`.
- `test/policy/reason-code-coverage.test.ts` holds a `scenarios` table that drives each F0 code through its **real code path** and asserts the produced reason, then asserts `Object.keys(scenarios) === reachableReasonCodes('F0')`.

Both hardcode `'F0'` on purpose, so bumping the stage cannot silently pass.

### F1's obligation here

`duplicate` and `source_unavailable` are registered as **F1-owned**. So F1 must:

1. Set `MILESTONE_STAGE = 'F1'` in `src/core/config/stage.ts`.
2. Add scenarios for `duplicate` and `source_unavailable` to the coverage table, driving the real ingestion code.
3. Change the two hardcoded `'F0'` references to `'F1'` and extend the expected list in `reason-codes.test.ts`.

If you skip step 1, the coverage test still passes and the milestone is a lie. If you do step 1 without 2 and 3, the tests fail loudly — which is the intent.

### Ownership of all 39 codes

Generated from the registry, so every later milestone knows its share up front.

| Milestone | Codes |
|---|---|
| **F0** ✅ | `budget_exhausted` `host_denied` `kill_switch_account` `kill_switch_domain` `kill_switch_global` `rate_limited` `robots_disallowed` `sending_disabled` `terms_prohibited` |
| **F1** ← you | `duplicate` `source_unavailable` |
| **F2** | `content_unchanged` `injection_detected` `insufficient_evidence` `low_relevance` `outdated_role` `weak_evidence` |
| **F3** | `application_submitted` |
| **F4** | `executive_only_contact` `legal_policy_mismatch` `no_public_recruiting_route` `outreach_not_permitted` |
| **F5** | `approval_hash_mismatch` `breaker_open` `cap_exceeded` `duplicate_company` `duplicate_contact` `hard_bounce` `opt_out` `profile_incomplete` `replied` `soft_bounce` `stale_at_send` `suppressed` `user_paused` `wrong_contact` |
| **F7** | `browser_blocked` `browser_needs_user` `browser_policy_rejected` |

Note `outreach_not_permitted` sits in F4 even though the predicate that raises it (`src/core/policy/outreach-case.ts`) was written and fully unit-tested in F0 — it is not reachable from a real pipeline path until drafting exists.

---

## 7. `HandoffLlmGateway`

**Full spec: `docs/handoff-llm-gateway.md`. Read it — do not re-derive it.**

It lives in its own file rather than inside this handover precisely so that it does
not have to survive being copied through F1 → F2 → F3 handovers intact.

**Status: specified, not implemented.** F1 contains no model work, and F0 is signed
off, so building it now would add unreviewed scope to a finished milestone. It is
first needed in F2.

The four things you need to know while working on F1, so you do not build something
that contradicts it:

1. The app never calls a model. It writes an `LlmTask` row and moves on; a Claude
   Code session drains pending rows later and writes results back through a
   schema-validating CLI. This is deviation §4.9 — a user decision.
2. **The session never fetches.** `FetchPolicyGate` fetches, code writes `Evidence`,
   the session reads `Evidence` quoted inside a task payload. One direction. A
   session that reads live scraped pages while holding Bash and database access is
   the tool-calling LLM in the research path that Part G forbids, and it would break
   provenance, since `Evidence.excerpt` must be verbatim and a summary is not.
3. Validation lives in the CLI, not in the session's discipline — the session is the
   thing being validated. Every cited `evidenceId` must be in the task's
   `allowedEvidenceIds`, which is the mechanism behind `handover.md` §11's golden
   test.
4. Scoring, normalization, dedup, HMAC, state transitions, the send gate and every
   ATS/JSON parse stay deterministic regardless. Parsing Greenhouse JSON with a model
   would be slower, nondeterministic, unreplayable, and would produce no
   `contentHash`.

## 8. F1 — the task

> **Plan, Part F, verbatim:** *F1 — Ingestion. yc-oss seed loader; domain canonicalization; ATS detection (updated `job-boards.greenhouse.io` signatures); the three required adapters only — Greenhouse, Lever, Ashby — with recorded fixtures. Lever's missing discovery endpoint means slug resolution is part of detection, not an afterthought. → 100–200 normalized companies with live postings attached; every field traceable to an `Evidence` row. No optional adapter is built in this milestone.*

### 8.1 Verified source facts (B6) — do not re-derive, do not substitute

| Source | Endpoint | Auth | Notes |
|---|---|---|---|
| **Greenhouse** | `GET boards-api.greenhouse.io/v1/boards/{token}/jobs` | none | Full description in `content`. Hosted board pages migrated `boards.` → `job-boards.greenhouse.io` — **update detection signatures accordingly.** |
| **Lever** | `GET api.lever.co/v0/postings/{slug}?mode=json` | none | ⚠️ **No discovery endpoint.** The slug must be resolved per company, which is why slug resolution is part of detection. |
| **Ashby** | `GET api.ashbyhq.com/posting-api/job-board/{name}` | none | Single call, no pagination. The "public GraphQL" variant **does not exist** — do not go looking for it. |
| **yc-oss** | `yc-oss.github.io` (+ `raw.githubusercontent.com`) | none | Live, updated daily, ~6,204 companies / ~1,480 hiring. ⚠️ **No LICENSE file.** H7: seed index only — every citable fact must be re-verified from the company's own site before it is used in a draft or packet. |

There is **no official YC API** and `workatastartup.com` has no API. yc-oss is the only maintained structured source.

Verify the exact yc-oss file paths at implementation time (the shape `handover.md` §6 describes is a metadata endpoint plus full and currently-hiring company feeds). The host allow entries already exist.

### 8.2 What to build

1. **yc-oss seed loader** — `SeedProvider` implementation. Fetches through `FetchPolicyGate.fetchText`. Upserts by YC id and canonicalized domain. Retains batch, locations, team size, tags, `one_liner`, `long_description`, hiring state. Writes one `Evidence` row per company with `sourceType: 'yc'` and a verbatim excerpt, and one `CompanySignal` of type `yc_profile` referencing it.

2. **Domain canonicalization** — pure, unit-tested, no network. Lowercase, strip scheme/`www.`/path/port/trailing dot, resolve to the registrable domain. **Decide explicitly whether to take a public-suffix-list dependency**: without one, `foo.co.uk` and `bar.co.uk` canonicalize wrongly. If you add one, verify it, pin it, and note it in the F2 handover. Reject junk (empty, IP literals, `localhost`, anything on the denylist).

3. **ATS detection + slug resolution** — from a company's careers URL or homepage, identify which of the three boards it uses and extract the token/slug. Signatures include `job-boards.greenhouse.io/{token}`, legacy `boards.greenhouse.io/{token}`, embedded `grnhse` markers, `jobs.lever.co/{slug}`, `jobs.ashbyhq.com/{name}`. Store on `Company.atsSlug` / `Company.atsBoardToken`. Detection failure is `source_unavailable`, not an exception.

4. **Three `AtsProvider` implementations** — Greenhouse, Lever, Ashby. Each takes a `GatedFetcher`, never a client. Each writes `Opportunity` rows (`kind: 'published_role'`) and `Evidence` rows with `sourceType: 'ats'`. Respect `Opportunity.@@unique([companyId, externalId])`. Re-ingesting an unchanged posting should hit `content_unchanged` via `contentHash` rather than churn rows.

5. **Fixtures** — a `tools/record-fixtures.ts` script, run deliberately by a human, that captures one real response per adapter **through `FetchPolicyGate`** into `test/fixtures/`. Every test then replays fixtures through `MockAgent`. `handover.md` §11: never run uncontrolled live-source tests.

6. **Wire the queues** — `QUEUES.seedIngest` and `QUEUES.companyResearch` already exist in `src/core/queue/boss.ts`. Use `enqueueInTransaction` so the `Evidence` row and the follow-up job commit together (A6).

### 8.3 Do NOT build in F1

Optional adapters (Workable, Adzuna, data.gov.in, HN, Bluesky, GitHub) — Part F puts them in F2a, each behind its own verification gate, default off. Also no scorer, no Firecrawl, no Readability, no UI, no `HandoffLlmGateway`.

### 8.4 The `derived_company` obligation — easy to miss

Per §4.1, an unknown host is refused with `host_denied`. Employer domains are therefore **unfetchable until F1 creates their allow entry**:

```ts
await db.hostPolicy.create({
  data: {
    host: company.canonicalDomain,
    mode: 'allow',
    origin: 'derived_company',
    sourceUrl: 'https://yc-oss.github.io/...',   // where the domain came from
    note: `canonical domain of Company ${company.id}`,
  },
})
```

Two things to check before you write one:
- The domain is not on the static denylist — `resolveHostPolicy` already refuses those, but creating the row is misleading noise.
- Creating an allow row grants nothing by itself. robots, terms, rate policy and budget still run.

**Also: `jobs.lever.co` and `jobs.ashbyhq.com` are NOT in the seeded allowlist.** Only the API hosts are (`api.lever.co`, `api.ashbyhq.com`), plus the Greenhouse hosted-board hosts. If detection needs to read a hosted board *page* on `jobs.lever.co` or `jobs.ashbyhq.com`, add them to `SEED_ALLOW_HOSTS` in `src/core/policy/host-lists.ts` with a note, and re-run `npm run seed:hosts`. Do not work around the refusal.

### 8.5 F1 exit criteria

| Criterion | How to demonstrate |
|---|---|
| 100–200 normalized companies | Count in `outreach_dev` after a real seed run |
| Live postings attached | `Opportunity` rows for the subset with a detected board |
| Every field traceable to an `Evidence` row | A test that walks a sampled `Company` + `Opportunity` and asserts each populated field has a citing `Evidence` row with a non-empty verbatim excerpt and a source URL |
| No optional adapter built | Inspection |
| All F0 invariants intact | `npm test` green, `npm run verify:f0` still 4/4 |
| Milestone bumped honestly | `MILESTONE_STAGE = 'F1'`, `duplicate` and `source_unavailable` reachable through real paths (§6) |
| Contract tests | Each adapter tested against both fixtures and a fake, per Part G's test layers |

Add a `verify:f1` script alongside `verify:f0` following the same shape.

---

## 9. What F1 must hand to F2

Write `docs/F2-HANDOVER.md` at the end of the F1 session, following this file's structure:

1. **§0 read-first list** — add `docs/F1-HANDOVER.md` to it. Never edit `docs/architecture-plan.md`.
2. **§2 status** — F1 exit criteria with real numbers (how many companies, how many with boards, how many postings), plus `npm test` and `verify:f1` output.
3. **§3 environment** — any new pins, and *why not `latest`*, in the same table shape. Note if you took a public-suffix-list dependency.
4. **§4 deviations** — every decision where the plan was ambiguous or wrong, with reasoning. This section is the most valuable one; do not compress it.
5. **§5 map** — new modules and the invariants they add.
6. **§6 reason codes** — F2 owns `outdated_role`, `weak_evidence`, `low_relevance`, `insufficient_evidence`, `content_unchanged`, `injection_detected`. Spell out the same three-step obligation.
7. **§7 `HandoffLlmGateway`** — carry §7 of this file forward; **F2 is where it gets built.**
8. **§8 the F2 task** — from Part F, plus what F1 learned that changes it.

### F2 preview, so F1 can prepare the ground

Part F: role taxonomy and matcher; deterministic scorer rebuilt to **exactly 100** with `ScoreVersion`; `SignalGraphService` with enforced source precedence and per-company research budget; static fetch + `@mozilla/readability` through the preflight; Firecrawl escalation within the B6a credit budget; **ATS job-count deltas as the primary hiring signal** (B2's free substitute for the excluded X API — `CompanySignal.numericValue` and type `ats_job_count_delta` already exist for it).

Things F1 can make F2 easier by getting right:
- Store enough per-refresh ATS state that a week-over-week job-count delta is computable without a refetch.
- Keep `contentHash` genuinely stable across runs, or change detection is noise.
- `ResearchBudget` rows are not created by F0. F2 needs them; decide in F1 whether seeding a per-company budget at ingestion is the right place (H5: India gets a higher per-company allowance than US/EU, because no India-native ATS exposes a public feed — B7).

**Before F2 starts:** claim the Firecrawl **student credits** (10,000/month vs 1,000 free, B6a). At weekly refresh the free tier is exhausted at roughly 230 companies on plain scrapes.

---

## 10. Open questions for the user

Carry these forward until answered.

1. **Firecrawl student credits** — claimed? Needed before F2, not F1.
2. **Public-suffix-list dependency** for domain canonicalization — F1 decides; F2 inherits.
3. **`ResearchBudget` seeding** — at ingestion (F1) or on first research (F2)? H5's India allowance has to land somewhere.
4. **When to build `HandoffLlmGateway`** — the plan here is "start of F2". The user may want it sooner.
5. **Git** — nothing is committed yet. The user commits on their own schedule.
