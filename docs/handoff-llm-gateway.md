# `HandoffLlmGateway` — design spec

**Status: BUILT in F2.** This file is the single source of truth for the design —
handover documents reference it by path rather than copying it, so it cannot drift
as milestones hand off to each other. The "as built" section at the end records what
implementation resolved that the spec left open.

**Context:** this is deviation §4.9 in `docs/F1-HANDOVER.md`. The approved plan
(`docs/architecture-plan.md`, Part E) assumed `LlmGateway` calls the Claude API as
the one separately-billed component. The user decided instead that their Claude Code
session plays that role, making marginal LLM cost zero. H10 already required the
pipeline to work with the LLM disabled, so the seam already exists — this adds a
third implementation rather than changing the architecture.

---

**Built in F2**, where it is first needed (research briefs). It is load-bearing in F4 (drafting).

### The problem it solves

The plan assumed `LlmGateway` calls the Claude API. The user instead wants their Claude Code session to be the model — no API key, no per-request bill. But a session is not callable from a pg-boss worker: there is no path from Node code back into an interactive session.

So the gateway inverts the call. Instead of the app calling a model, the app **records a request and moves on**, and a session drains the backlog later.

### Contract

`LlmGateway` already exists in `src/core/interfaces/providers.ts`:

```ts
export interface LlmGateway {
  readonly enabled: boolean
  complete<T>(s: {
    promptVersion: string
    schema: z.ZodType<T>
    input: unknown
    maxTokens: number
  }): Promise<{ value: T; costUsd: number }>
}
```

Three implementations share it:

| Implementation | Behaviour | When |
|---|---|---|
| `NullLlmGateway` | `enabled = false`; `complete()` throws a typed `LlmDisabledError` that callers turn into a queued manual task. H10's "degrade to manual drafting, never a broken pipeline." | always available |
| `HandoffLlmGateway` | Writes an `LlmTask` row and returns a pending result. Callers must tolerate "not yet". | **the default** |
| `AnthropicLlmGateway` | Real API call. Behind a flag, default off. | if the user ever wants unattended runs |

### Schema addition

```prisma
enum LlmTaskStatus {
  pending
  claimed
  fulfilled
  rejected
  abandoned

  @@map("llm_task_status")
}

/// One unit of judgment the pipeline needs but cannot compute deterministically.
///
/// The app writes the row and moves on; a Claude Code session drains pending rows
/// and writes results back through a schema-validating CLI. The session never
/// fetches anything: `input` carries Evidence excerpts that FetchPolicyGate already
/// captured, so provenance stays verbatim and scraped page text arrives as DATA in
/// a payload rather than as instructions to something holding Bash and DB access
/// (Part G, prompt-injection row).
model LlmTask {
  id            String        @id @default(uuid(7))
  kind          String        @map("kind")
  promptVersion String        @map("prompt_version")
  /// JSON Schema derived from the caller's Zod schema. The CLI validates the
  /// response against exactly this before accepting it.
  responseSchema Json         @map("response_schema")
  /// Task payload. Evidence excerpts are quoted here, never fetched at fulfil time.
  input         Json          @map("input")
  /// Evidence rows the response is allowed to cite. A citation outside this set is
  /// a validation failure, not a review finding.
  allowedEvidenceIds String[] @map("allowed_evidence_ids")
  subjectType   String        @map("subject_type")
  subjectId     String        @map("subject_id")
  status        LlmTaskStatus @default(pending) @map("status")
  statusReason  ReasonCode?   @map("status_reason")
  output        Json?         @map("output")
  /// Who fulfilled it, and with what. 'claude-code-session' for the handoff path,
  /// a model id for the API path. Recorded so a brief's origin is auditable.
  fulfilledBy   String?       @map("fulfilled_by")
  costUsd       Decimal?      @map("cost_usd") @db.Decimal(12, 6)
  attempts      Int           @default(0) @map("attempts")
  createdAt     DateTime      @default(now()) @map("created_at")
  claimedAt     DateTime?     @map("claimed_at")
  fulfilledAt   DateTime?     @map("fulfilled_at")

  @@index([status, kind])
  @@index([subjectType, subjectId])
  @@map("llm_task")
}
```

### The CLI, and why validation lives there

```
npm run llm:list                    # pending tasks, one line each
npm run llm:next -- --kind brief    # claim one task, print its payload as JSON
npm run llm:fulfil -- --id <id> --file out.json
npm run llm:reject  -- --id <id> --reason weak_evidence
```

`llm:fulfil` is the choke point. Before writing anything it must:

1. Validate `out.json` against the task's stored `responseSchema`. Reject on any mismatch.
2. Assert every `evidenceId` cited in the output is in `allowedEvidenceIds`. **This is the mechanism behind `handover.md` §11's golden test** — an unsupported claim becomes a schema error rather than something a human is expected to catch.
3. Assert no output field contains text matching the redaction patterns.
4. Write `output`, set `status = fulfilled`, `fulfilledBy = 'claude-code-session'`, `costUsd = 0`, and an `AuditLog` row.

Validation is in the CLI, not in the session's discipline, precisely because the session is the thing being validated. A session that writes sloppy output gets rejected by code it does not control.

### Why the session must not fetch

Stated plainly because it is the one genuinely dangerous shortcut available here:

> If a Claude Code session reads live scraped pages while holding Bash, Write and database access, it becomes the tool-calling LLM in the research path that Part G forbids, and a hostile careers page is then talking directly to something that can write to the database and, from F5, the mailbox. It would also break provenance: `Evidence.excerpt` must be verbatim, and a session's summary is a paraphrase.
>
> So: `FetchPolicyGate` fetches, code writes `Evidence`, the session reads `Evidence` from an `LlmTask` payload. One direction, no exceptions.

### What stays deterministic regardless

Scoring (A1/A11 require replayability), normalization, dedup, HMAC, state transitions, the send gate, and every ATS/JSON parse. Parsing Greenhouse JSON with a model would be slower, nondeterministic, unreplayable and would produce no `contentHash`.

---

---

## Where this gets used

| Milestone | Use |
|---|---|
| F2 | Research briefs (`ResearchBrief`), track classification beyond the keyword dictionaries. **Build the gateway here.** |
| F3 | `ApplicationPacket` prefilled answers, drawn only from `ApprovedClaim` |
| F4 | Draft composition with a per-sentence `evidenceId`. The citation rule stops being a convenience and becomes the Quality Gate. |
| F5 | Reply classification |

## Day-to-day operation, in plain terms

Three kinds of work, and they do not all need the same actor.

**Collecting runs unattended.** Scheduled jobs check ATS boards and careers pages
through `FetchPolicyGate`, record what they saw and where. They decide nothing.

**Thinking needs a session.** The operator opens Claude Code and drains the pending
`LlmTask` backlog — briefs, classifications, packet answers, drafts. Minutes.

**Deciding needs the human.** They review what is queued, accept or reject, submit
applications themselves through the company's own site, and approve any email
individually.

The tradeoff to state plainly: because the model is a session rather than an API,
briefs and drafts do not appear overnight. Collection does; writing waits for the
operator. That is the price of no per-request bill, and swapping in
`AnthropicLlmGateway` reverses it later without touching callers.


---

## As built (F2)

Everything above holds. What implementation added or resolved:

### Modules

| Path | What it is |
|---|---|
| `prisma/migrations/20260909061117_llm_task/` | The `LlmTask` table and `LlmTaskStatus` enum, exactly as specified above |
| `src/core/llm/tasks.ts` | The task-kind registry: Zod schema, prompt version, and description per kind |
| `src/core/llm/handoff-gateway.ts` | `NullLlmGateway`, `HandoffLlmGateway`, `fulfilTask`, `claimNextTask`, `rejectTask` |
| `src/intel/brief/queue-brief.ts` | F2's only caller: queues a `research_brief` for a qualified lead |
| `tools/llm.ts` | The CLI: `llm:list`, `llm:next`, `llm:fulfil`, `llm:reject`, `llm:kinds` |

### Four things the spec left open, and how they were resolved

**1. Validation uses the Zod schema, not the stored JSON Schema.** The row stores a
JSON Schema (derived with `z.toJSONSchema`) so the session can read the contract
without running any of our code. `llm:fulfil` validates against the **Zod** schema
from the registry in `tasks.ts`, keyed by `kind` + `promptVersion`. The JSON Schema
is a derivative, so validating against it would be validating against a copy — and
doing so would need a JSON-Schema validator, a new dependency in the one code path
whose whole job is to be the thing that cannot be talked out of checking. A task
whose kind/version is no longer registered **fails closed**: `no_schema`, never
"accept it unvalidated".

**2. `complete()` cannot return a value, so it throws.** The `LlmGateway` interface
returns `Promise<{ value, costUsd }>`, and the handoff implementation has no honest
value to return — the answer arrives when a human opens a session. It queues, then
throws `LlmTaskPendingError` carrying the task id. `enqueue()` is the non-throwing
form and is what every F2 caller uses. `NullLlmGateway` throws `LlmDisabledError`.

**3. The citation check walks the whole response.** `collectCitedEvidenceIds`
recurses the output object and collects every `evidenceId`, `evidence_id`,
`citedEvidenceIds` and `evidenceIds` at any depth, then asserts the set is a subset
of `allowedEvidenceIds`. Reading a known field would have let a future schema nest
citations one level deeper and escape the check.

**4. Enqueue is idempotent per (kind, promptVersion, subjectType, subjectId).** A
weekly refresh must not pile up identical asks in the operator's queue, so an
existing `pending` or `claimed` row is returned rather than duplicated.

Also added, beyond the spec: a **redaction check** — if `redact()` changes the
output, it is refused as `redaction` and nothing is stored; and an **attempts
counter**, incremented on every rejection, so a session that keeps failing is
visible rather than silently retried.

### Proven end to end on live data (F2 session)

21 briefs queued from the live corpus; one claimed with `llm:next`, fulfilled with
`llm:fulfil` and accepted; one deliberately fulfilled with a citation belonging to
another company's task and refused:

```
REJECTED (uncited_evidence): cited evidence outside allowedEvidenceIds: ...
```

That refusal is `handover.md` §11's golden test, running against the real CLI.

### What F3 and F4 should know

- Add a task kind by adding a Zod schema to `LLM_TASK_SCHEMAS`. Nothing else
  changes: the CLI, the validation and the citation rule are kind-agnostic.
- `promptVersion` is unique across kinds (`findTaskSchemaByPromptVersion` relies on
  it). Version a prompt by bumping the suffix — `research_brief@2` — and keep the
  old entry until no pending rows reference it.

---

## As built (F3)

F3 used the gateway for the first time as a consumer rather than only a producer, and
that surfaced one thing the spec had not needed to answer.

### `ResearchBrief` persistence — closed

`src/apply/brief/persist-brief.ts` writes an accepted `research_brief` task's output
into the table. Two decisions worth recording:

- **`citedEvidenceIds` is copied straight from the validated output**, as this file
  instructed. `llm:fulfil` has already proved every cited id is inside the task's
  `allowedEvidenceIds`; re-deriving them at write time would be a second, weaker
  implementation of a check that already passed, and if the two ever disagreed the
  stored brief would cite a different set than the one that was validated.
- **Idempotent per `(companyId, promptVersion)`.** A brief is a snapshot of what the
  evidence supported when it was written, so re-draining refreshes it rather than
  stacking a second row — otherwise F4's `Draft.researchBriefId` would have to choose
  between duplicates. A new prompt version is a genuinely different artefact and gets
  its own row.

### The allow-set is now two-sided

`Evidence` bounds what may be said about the **company**. F3 needed the same rule for
what may be said about the **candidate**, because a prefilled application answer makes
both kinds of statement in a single sentence.

`LlmTask.allowedApprovedClaimIds` is the `ApprovedClaim` analogue of
`allowedEvidenceIds`, and `fulfilTask` refuses output citing outside it with a new
`uncited_claim` failure. `collectCitedApprovedClaimIds` walks the whole response the
way the evidence collector does, for the same reason: a future schema that nests
citations one level deeper must not escape the check.

An omitted or empty `allowedApprovedClaimIds` means **cite none**, never "cite
anything" — which is what made it safe to add to a kind (`research_brief`) that makes
no candidate claims.

### The F3 task kind

`packet_answers@1` — the two application questions that need judgment ("why this
company", "what of your experience is relevant"). Its schema requires
`approvedClaimIds` to be non-empty on every answer, so an uncited claim about the
candidate is a schema error rather than a review finding.

Everything else on a packet is deterministic and needs no model: a name, a degree, a
work-authorization status is already in `ApprovedClaim`, and the answer text is the
cited claims' own words concatenated, never reworded.

### H10 held, and was measured

`npm run packets:run` produced **37 complete packets with the LLM backlog untouched**
— eight prefilled answers each, with the judgment questions listed as unanswered and a
reason. Draining the backlog upgrades a packet; it never unblocks one. A packet is
never blocked on a session being opened.

---

## As built (F4)

F4 is where the citation rule stops being a convenience and becomes the thing the
product is sold on. The operator's scope note (`docs/F4-HANDOVER.md` §10.1) names
per-sentence evidence citation as the edge over template spray and adds: *"do not
weaken it to go faster."*

### The F4 task kind

`outreach_draft@1` — a subject line, **one** sentence about the company, and one or two
about the candidate. It is the first kind where **both** citation arrays are `.min(1)`:

| field | must cite | why |
|---|---|---|
| `companySentence.evidenceIds` | ≥1 `Evidence` | D5's invariant, finally load-bearing: F4 is the first milestone that composes a message |
| `candidateSentences[].approvedClaimIds` | ≥1 `ApprovedClaim` | F3 §4.1's candidate side. A statement made on the operator's behalf must trace to a document they wrote |

Everything else in the message is deterministic and needs no model: the TL;DR, the
resume link, the ask and the sign-off are **registered templates** rendered from stored
values, and the availability sentence is an `ApprovedClaim`'s own words. That is not
only economy — an uncited free-text role would be the obvious way around both citation
rules, so `src/outreach/draft/message.ts` requires a `templateId` on every role that
carries no citation.

### Three things F4 added to the payload contract

**1. The recipient's address is never in the payload.** The session gets the contact
*type* and public title only. It has no reason to know who the message goes to, and a
payload is also where a scraped page's own text lives. Pinned by test.

**2. The allow-set is scoped to the company.** `tempo.fit` was detected as using
Greenhouse board token `tempo`, which belongs to Tempo Energy — so its evidence
included eight postings hosted on `tempoenergy.com`. Offering those excerpts would
invite a confident, correctly-cited sentence about the **wrong company**, which every
existing check would pass: the citation is real, the excerpt verbatim, the URL
resolves. `src/outreach/draft/evidence-scope.ts` filters the allow-set to the company's
own registrable domain and genuine ATS hosts before the task is written, and the
Quality Gate re-checks what a stored draft cites.

yc-oss hosts are deliberately excluded. H7 makes the seed index a discovery source
whose facts must be re-verified from the company's own site before being cited, and a
draft is exactly the place that rule is for.

**3. The instructions name the failure modes, rather than trusting them not to
happen.** No generic praise (`handover.md` §8 names "I love what you're building"
specifically), no claim of work authorization or a graduation date or an availability
window, no claimed knowledge of internal hiring plans, no `Re:` subject. The Quality
Gate checks for these afterwards regardless — the instruction tells the session the
rule, the gate is what enforces it.

### H10 degrades differently here, deliberately

F3 measured H10 by producing 37 usable packets with the backlog untouched: an operator
can submit an application with two questions blank.

A message cannot work that way. Its evidence-cited sentence **is** the edge, so a draft
with no fulfilled task is complete as a **record** and deliberately fails the Quality
Gate with `missing_required_role`. The pipeline is not broken and nothing else is
blocked; there is simply no honest message yet. Draining upgrades a draft, and never
unblocks one.

### Proven end to end on live data (F4 session)

Four `outreach_draft` tasks queued from the live corpus. One claimed with `llm:next`,
fulfilled with a message citing two real `Evidence` rows (the employer's own careers
page and their own open posting) and three real `ApprovedClaim` rows, merged, gated and
approved with a frozen `approval_hash`. The other three sit at `gate_failed`, correctly,
waiting for their sentences.
