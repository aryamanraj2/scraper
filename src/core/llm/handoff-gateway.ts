import type { z } from 'zod'
import type { Db } from '../audit/audit-log.js'
import { writeAudit } from '../audit/audit-log.js'
import type { Prisma } from '../../../generated/prisma/client.js'
import type { LlmGateway } from '../interfaces/providers.js'
import type { ReasonCodeValue } from '../reason-codes/registry.js'
import { redact } from '../logging/redact.js'
import {
  collectCitedApprovedClaimIds,
  collectCitedEvidenceIds,
  findTaskSchema,
  findTaskSchemaByPromptVersion,
  jsonSchemaFor,
  type LlmTaskKind,
} from './tasks.js'

/**
 * `HandoffLlmGateway` — the app never calls a model.
 *
 * Full design: `docs/handoff-llm-gateway.md`. This is that design as built.
 *
 * F0's deviation §4.9, a user decision: the LLM in this system is the operator's
 * own Claude Code session, not the Claude API, which makes marginal LLM cost zero.
 * A session is not callable from a pg-boss worker, so the gateway inverts the call:
 * the app records a request and moves on, and a session drains the backlog later
 * through the `llm:*` CLI.
 *
 * Four properties hold regardless of which implementation is in use:
 *
 *  1. **The app never calls a model.** `complete()` on this implementation cannot
 *     return a value; it writes a row and throws `LlmTaskPendingError`. Callers
 *     that expect an answer must tolerate "not yet" — which is why `enqueue()`
 *     exists as the non-throwing form, and why every F2 caller uses it.
 *  2. **The session never fetches.** `input` carries `Evidence` excerpts that
 *     `FetchPolicyGate` already captured. One direction: gate fetches, code writes
 *     Evidence, session reads Evidence from a payload. A session reading live pages
 *     while holding Bash and database access is the tool-calling LLM in the research
 *     path that Part G forbids, and it would break provenance, since an excerpt must
 *     be verbatim and a summary is not.
 *  3. **Validation lives in the CLI**, not in the session's discipline — the session
 *     is the thing being validated. See `fulfilTask` below.
 *  4. **Everything deterministic stays deterministic.** Scoring, normalization,
 *     dedup, HMAC, state transitions, the send gate and every ATS/JSON parse are
 *     unaffected by whether any of this is switched on (H10).
 */

export class LlmDisabledError extends Error {
  constructor(readonly promptVersion: string) {
    super(
      `LLM is disabled; "${promptVersion}" must be produced manually. H10: the pipeline degrades to ` +
        `manual drafting, never to a broken pipeline.`,
    )
    this.name = 'LlmDisabledError'
  }
}

export class LlmTaskPendingError extends Error {
  constructor(readonly taskId: string, readonly promptVersion: string) {
    super(`LLM task ${taskId} (${promptVersion}) is queued for a Claude Code session; no value yet.`)
    this.name = 'LlmTaskPendingError'
  }
}

/**
 * H10's floor. Always available, never throws at construction, and turns every
 * request into a typed error the caller converts into a manual task.
 */
export class NullLlmGateway implements LlmGateway {
  readonly enabled = false

  complete<T>(s: { promptVersion: string; schema: z.ZodType<T>; input: unknown; maxTokens: number }): Promise<{
    value: T
    costUsd: number
  }> {
    return Promise.reject(new LlmDisabledError(s.promptVersion))
  }
}

export type EnqueueSpec = {
  kind: LlmTaskKind
  promptVersion: string
  /** Payload. Evidence excerpts are quoted here; nothing is fetched at fulfil time. */
  input: Record<string, unknown>
  /** The only evidence ids a response may cite. */
  allowedEvidenceIds: string[]
  /**
   * The only `ApprovedClaim` ids a response may cite (F3). Optional because most
   * kinds make no candidate claims; an omitted or empty set means "cite none", never
   * "cite anything", which is what makes the check safe to add to existing kinds.
   */
  allowedApprovedClaimIds?: string[]
  subjectType: string
  subjectId: string
}

export class HandoffLlmGateway implements LlmGateway {
  /** True: the gateway works. It queues rather than answers, which is not the same as off. */
  readonly enabled = true

  constructor(private readonly db: Db) {}

  /**
   * Writes the task and returns its id. The non-throwing form, and the one every
   * caller in F2 uses.
   *
   * Idempotent per (kind, promptVersion, subject): re-running a refresh must not
   * pile up identical asks in the operator's queue. An existing pending or claimed
   * row is returned as-is.
   */
  async enqueue(spec: EnqueueSpec): Promise<{ taskId: string; created: boolean }> {
    const entry = findTaskSchema(spec.kind, spec.promptVersion)
    if (!entry) {
      throw new Error(
        `No registered schema for ${spec.kind}/${spec.promptVersion}. A task nothing can validate must not be written.`,
      )
    }

    const existing = await this.db.llmTask.findFirst({
      where: {
        kind: spec.kind,
        promptVersion: spec.promptVersion,
        subjectType: spec.subjectType,
        subjectId: spec.subjectId,
        status: { in: ['pending', 'claimed'] },
      },
      select: { id: true },
    })
    if (existing) return { taskId: existing.id, created: false }

    const task = await this.db.llmTask.create({
      data: {
        kind: spec.kind,
        promptVersion: spec.promptVersion,
        responseSchema: jsonSchemaFor(entry.schema) as Prisma.InputJsonValue,
        input: spec.input as Prisma.InputJsonValue,
        allowedEvidenceIds: spec.allowedEvidenceIds,
        allowedApprovedClaimIds: spec.allowedApprovedClaimIds ?? [],
        subjectType: spec.subjectType,
        subjectId: spec.subjectId,
      },
      select: { id: true },
    })

    await writeAudit(this.db, {
      actorType: 'system',
      actorId: 'llm-gateway',
      action: 'llm.task_queued',
      subjectType: spec.subjectType,
      subjectId: spec.subjectId,
      metadata: {
        taskId: task.id,
        kind: spec.kind,
        promptVersion: spec.promptVersion,
        allowed: spec.allowedEvidenceIds.length,
        allowedClaims: (spec.allowedApprovedClaimIds ?? []).length,
      },
    })
    return { taskId: task.id, created: true }
  }

  /**
   * The `LlmGateway` shape, for callers written against the interface. It queues
   * and then throws `LlmTaskPendingError`, because there is no honest value to
   * return: the answer arrives when a human opens a session, not when this promise
   * settles.
   */
  async complete<T>(s: {
    promptVersion: string
    schema: z.ZodType<T>
    input: unknown
    maxTokens: number
  }): Promise<{ value: T; costUsd: number }> {
    const entry = findTaskSchemaByPromptVersion(s.promptVersion)
    if (!entry) throw new Error(`No registered schema for prompt version ${s.promptVersion}.`)
    const { taskId } = await this.enqueue({
      kind: entry.kind,
      promptVersion: s.promptVersion,
      input: (s.input ?? {}) as Record<string, unknown>,
      allowedEvidenceIds: [],
      allowedApprovedClaimIds: [],
      subjectType: 'Unspecified',
      subjectId: 'unspecified',
    })
    throw new LlmTaskPendingError(taskId, s.promptVersion)
  }
}

// ---------------------------------------------------------------------------
// Fulfilment — the choke point (docs/handoff-llm-gateway.md)
// ---------------------------------------------------------------------------

export type FulfilFailure = {
  ok: false
  problem:
    | 'unknown_task'
    | 'wrong_status'
    | 'no_schema'
    | 'schema_mismatch'
    | 'uncited_evidence'
    | 'uncited_claim'
    | 'redaction'
  detail: string
}

export type FulfilResult = { ok: true; taskId: string } | FulfilFailure

/**
 * Validates and accepts a session's output.
 *
 * Everything here is a check the session cannot perform on its own behalf, which is
 * the entire point: the session is the thing being validated, so a session that
 * writes sloppy output gets rejected by code it does not control.
 *
 *  1. The task exists and is still open.
 *  2. Its `kind`/`promptVersion` has a registered schema, and the output parses
 *     against it.
 *  3. **Every cited `evidenceId` is in `allowedEvidenceIds`.** This is the mechanism
 *     behind `handover.md` §11's golden test: an unsupported claim becomes a schema
 *     error rather than something a human is expected to catch.
 *  4. **Every cited `approvedClaimId` is in `allowedApprovedClaimIds`** (F3). The same
 *     rule, pointed at the candidate rather than the employer — an application answer
 *     asserts things about both, and only one of them was covered before.
 *  5. No field carries text matching the redaction patterns.
 */
export async function fulfilTask(
  db: Db,
  taskId: string,
  output: unknown,
  opts: { fulfilledBy?: string; now?: Date } = {},
): Promise<FulfilResult> {
  const task = await db.llmTask.findUnique({ where: { id: taskId } })
  if (!task) return { ok: false, problem: 'unknown_task', detail: `no task ${taskId}` }
  if (task.status === 'fulfilled' || task.status === 'abandoned') {
    return { ok: false, problem: 'wrong_status', detail: `task is ${task.status}` }
  }

  const entry = findTaskSchema(task.kind, task.promptVersion)
  if (!entry) {
    return {
      ok: false,
      problem: 'no_schema',
      detail: `no registered schema for ${task.kind}/${task.promptVersion}; refusing to accept unvalidated output`,
    }
  }

  const parsed = entry.schema.safeParse(output)
  if (!parsed.success) {
    await db.llmTask.update({ where: { id: taskId }, data: { attempts: { increment: 1 } } })
    return { ok: false, problem: 'schema_mismatch', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }
  }

  const allowed = new Set(task.allowedEvidenceIds)
  const cited = collectCitedEvidenceIds(parsed.data)
  const uncited = [...cited].filter((id) => !allowed.has(id))
  if (uncited.length > 0) {
    await db.llmTask.update({ where: { id: taskId }, data: { attempts: { increment: 1 } } })
    return {
      ok: false,
      problem: 'uncited_evidence',
      detail: `cited evidence outside allowedEvidenceIds: ${uncited.join(', ')}`,
    }
  }

  const allowedClaims = new Set(task.allowedApprovedClaimIds)
  const citedClaims = collectCitedApprovedClaimIds(parsed.data)
  const uncitedClaims = [...citedClaims].filter((id) => !allowedClaims.has(id))
  if (uncitedClaims.length > 0) {
    await db.llmTask.update({ where: { id: taskId }, data: { attempts: { increment: 1 } } })
    return {
      ok: false,
      problem: 'uncited_claim',
      detail: `cited approved claims outside allowedApprovedClaimIds: ${uncitedClaims.join(', ')}`,
    }
  }

  // The output is about to become quotable by F3 and F4. A credential that reached
  // it — pasted from a page, echoed from a header — must not be stored, and
  // redacting it silently would hide that it happened.
  const serialized = JSON.stringify(parsed.data)
  if (JSON.stringify(redact(parsed.data)) !== serialized) {
    await db.llmTask.update({ where: { id: taskId }, data: { attempts: { increment: 1 } } })
    return { ok: false, problem: 'redaction', detail: 'output matched a secret pattern; not stored' }
  }

  const now = opts.now ?? new Date()
  await db.llmTask.update({
    where: { id: taskId },
    data: {
      status: 'fulfilled',
      output: parsed.data as Prisma.InputJsonValue,
      // Recorded so a brief's origin is auditable: a session, or a model id if the
      // API implementation is ever switched on.
      fulfilledBy: opts.fulfilledBy ?? 'claude-code-session',
      // Zero by construction on this path — that is the point of the handoff.
      costUsd: 0,
      fulfilledAt: now,
      attempts: { increment: 1 },
    },
  })

  await writeAudit(db, {
    actorType: 'user',
    actorId: opts.fulfilledBy ?? 'claude-code-session',
    action: 'llm.task_fulfilled',
    subjectType: task.subjectType,
    subjectId: task.subjectId,
    costUsd: 0,
    metadata: {
      taskId,
      kind: task.kind,
      promptVersion: task.promptVersion,
      cited: [...cited],
      citedClaims: [...citedClaims],
    },
  })

  return { ok: true, taskId }
}

/** Claims a pending task so two sessions do not answer the same one. */
export async function claimNextTask(
  db: Db,
  opts: { kind?: string; now?: Date } = {},
): Promise<{ id: string; kind: string; promptVersion: string; input: unknown; responseSchema: unknown; allowedEvidenceIds: string[]; subjectType: string; subjectId: string } | null> {
  const task = await db.llmTask.findFirst({
    where: { status: 'pending', ...(opts.kind ? { kind: opts.kind } : {}) },
    orderBy: { createdAt: 'asc' },
  })
  if (!task) return null
  await db.llmTask.update({
    where: { id: task.id },
    data: { status: 'claimed', claimedAt: opts.now ?? new Date() },
  })
  return {
    id: task.id,
    kind: task.kind,
    promptVersion: task.promptVersion,
    input: task.input,
    responseSchema: task.responseSchema,
    allowedEvidenceIds: task.allowedEvidenceIds,
    subjectType: task.subjectType,
    subjectId: task.subjectId,
  }
}

/** Rejects a task with one of the closed reason codes. */
export async function rejectTask(
  db: Db,
  taskId: string,
  reason: ReasonCodeValue,
  detail?: string,
): Promise<{ ok: boolean }> {
  const task = await db.llmTask.findUnique({ where: { id: taskId }, select: { id: true, subjectType: true, subjectId: true } })
  if (!task) return { ok: false }
  await db.llmTask.update({
    where: { id: taskId },
    data: { status: 'rejected', statusReason: reason, attempts: { increment: 1 } },
  })
  await writeAudit(db, {
    actorType: 'user',
    actorId: 'claude-code-session',
    action: 'llm.task_rejected',
    subjectType: task.subjectType,
    subjectId: task.subjectId,
    reasonCode: reason,
    metadata: { taskId, ...(detail === undefined ? {} : { detail }) },
  })
  return { ok: true }
}
