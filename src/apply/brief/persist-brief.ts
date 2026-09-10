import type { Prisma } from '../../../generated/prisma/client.js'
import type { Db } from '../../core/audit/audit-log.js'
import { writeAudit } from '../../core/audit/audit-log.js'

/**
 * Writes an accepted `research_brief` task into the `ResearchBrief` table.
 *
 * F2 queued 21 briefs and validated the ones that came back; **nothing consumed a
 * fulfilled task's `output`**. That is this module, and it is the one piece of F2's
 * LLM path that was left deliberately unfinished for F3.
 *
 * ## Copy the citations, do not re-derive them
 *
 * `docs/handoff-llm-gateway.md` is explicit: copy `citedEvidenceIds` straight from
 * the validated output. `llm:fulfil` has already proved every cited id is inside the
 * task's `allowedEvidenceIds`, so re-deriving them here would be a second, weaker
 * implementation of a check that already passed — and if the two ever disagreed, the
 * stored brief would cite a different set than the one that was validated.
 *
 * ## Idempotent per (company, promptVersion)
 *
 * A brief is a snapshot of what the evidence supported when it was written. Re-running
 * the drain must refresh that company's brief for that prompt version rather than
 * stack a second one, or `Draft.researchBriefId` in F4 would have to pick between
 * duplicates. A new prompt version is a genuinely different artefact and gets its own
 * row.
 */

export type PersistBriefOutcome =
  | { ok: true; briefId: string; created: boolean; facts: number; citations: number }
  | { ok: false; problem: 'unknown_task' | 'not_fulfilled' | 'wrong_kind' | 'no_lead' | 'malformed'; detail: string }

type BriefOutput = {
  facts: { fact: string; citations: { evidenceId: string; claim: string }[] }[]
  relevanceNote: string
  suggestedTrack: string | null
}

export async function persistResearchBrief(db: Db, taskId: string): Promise<PersistBriefOutcome> {
  const task = await db.llmTask.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      kind: true,
      promptVersion: true,
      status: true,
      output: true,
      subjectType: true,
      subjectId: true,
    },
  })
  if (!task) return { ok: false, problem: 'unknown_task', detail: `no task ${taskId}` }
  if (task.kind !== 'research_brief') {
    return { ok: false, problem: 'wrong_kind', detail: `task ${taskId} is ${task.kind}` }
  }
  if (task.status !== 'fulfilled' || task.output === null) {
    return { ok: false, problem: 'not_fulfilled', detail: `task ${taskId} is ${task.status}` }
  }

  const lead = await db.lead.findUnique({
    where: { id: task.subjectId },
    select: { id: true, companyId: true },
  })
  if (!lead) return { ok: false, problem: 'no_lead', detail: `no lead ${task.subjectId}` }

  const output = task.output as unknown as BriefOutput
  if (!Array.isArray(output.facts) || typeof output.relevanceNote !== 'string') {
    return { ok: false, problem: 'malformed', detail: 'output does not have the research_brief shape' }
  }

  // Straight from the validated output. Order preserved so a brief reads the way the
  // session wrote it.
  const citedEvidenceIds = [
    ...new Set(output.facts.flatMap((f) => (f.citations ?? []).map((c) => c.evidenceId))),
  ]

  const existing = await db.researchBrief.findFirst({
    where: { companyId: lead.companyId, promptVersion: task.promptVersion },
    select: { id: true },
  })

  const data = {
    facts: output.facts as unknown as Prisma.InputJsonValue,
    relevanceNote: output.relevanceNote,
    citedEvidenceIds,
    promptVersion: task.promptVersion,
  }

  const row = existing
    ? await db.researchBrief.update({ where: { id: existing.id }, data, select: { id: true } })
    : await db.researchBrief.create({ data: { companyId: lead.companyId, ...data }, select: { id: true } })

  await writeAudit(db, {
    actorType: 'system',
    actorId: 'brief-writer',
    action: existing ? 'brief.updated' : 'brief.persisted',
    subjectType: 'ResearchBrief',
    subjectId: row.id,
    metadata: {
      taskId,
      leadId: lead.id,
      companyId: lead.companyId,
      promptVersion: task.promptVersion,
      facts: output.facts.length,
      citations: citedEvidenceIds.length,
    },
  })

  return {
    ok: true,
    briefId: row.id,
    created: existing === null,
    facts: output.facts.length,
    citations: citedEvidenceIds.length,
  }
}

/** Drains every fulfilled `research_brief` task into `ResearchBrief`. */
export async function persistAllFulfilledBriefs(
  db: Db,
): Promise<{ persisted: number; failed: { taskId: string; detail: string }[] }> {
  const tasks = await db.llmTask.findMany({
    where: { kind: 'research_brief', status: 'fulfilled' },
    select: { id: true },
    orderBy: { fulfilledAt: 'asc' },
  })
  let persisted = 0
  const failed: { taskId: string; detail: string }[] = []
  for (const task of tasks) {
    const result = await persistResearchBrief(db, task.id)
    if (result.ok) persisted += 1
    else failed.push({ taskId: task.id, detail: `${result.problem}: ${result.detail}` })
  }
  return { persisted, failed }
}
