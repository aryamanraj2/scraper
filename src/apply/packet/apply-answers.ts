import type { Prisma } from '../../../generated/prisma/client.js'
import type { Db } from '../../core/audit/audit-log.js'
import { writeAudit } from '../../core/audit/audit-log.js'
import { PACKET_ANSWERS_PROMPT_VERSION } from './queue-answers.js'
import {
  PrefilledAnswers,
  citedClaimIds,
  citedEvidenceIdsOf,
  validateAnswers,
  type PrefilledAnswer,
} from './answers.js'
import { computePacketHash } from './hash.js'
import { PACKET_QUESTIONS } from './questions.js'

/**
 * Merges a fulfilled `packet_answers` task into its packet.
 *
 * ## Why this re-validates something the CLI already validated
 *
 * `llm:fulfil` proved the output parses, that every cited evidence id is in
 * `allowedEvidenceIds`, and that every cited claim id is in
 * `allowedApprovedClaimIds`. This runs `validateAnswers` again anyway, against the
 * *live* `ApprovedClaim` rows.
 *
 * The two checks answer different questions. The CLI asks "did the session cite
 * outside the set it was given" — a question about the session. This asks "are those
 * claims still approved" — a question about time. A task fulfilled last week may cite
 * a claim the operator has since withdrawn, and a withdrawn claim must not walk into
 * a packet because the check that would have caught it ran before the withdrawal.
 *
 * ## Accepted packets are not touched
 *
 * `packetHash` is a claim about what a human approved. Merging new text under it
 * would make that claim false, so an accepted packet is refused here as it is in
 * generation.
 */

export type ApplyAnswersOutcome =
  | { ok: true; packetId: string; merged: number; stillUnanswered: number }
  | {
      ok: false
      problem: 'unknown_task' | 'not_fulfilled' | 'unknown_packet' | 'accepted' | 'invalid' | 'wrong_kind'
      detail: string
    }

export async function applyPacketAnswers(db: Db, taskId: string): Promise<ApplyAnswersOutcome> {
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
  if (task.kind !== 'packet_answers') {
    return { ok: false, problem: 'wrong_kind', detail: `task ${taskId} is ${task.kind}` }
  }
  if (task.status !== 'fulfilled' || task.output === null) {
    return { ok: false, problem: 'not_fulfilled', detail: `task ${taskId} is ${task.status}` }
  }

  const packet = await db.applicationPacket.findUnique({
    where: { id: task.subjectId },
    select: {
      id: true,
      companyId: true,
      opportunityId: true,
      officialUrl: true,
      resumeVersionId: true,
      prefilledAnswers: true,
      acceptedAt: true,
      resumeVersion: { select: { fileSha256: true } },
    },
  })
  if (!packet) return { ok: false, problem: 'unknown_packet', detail: `no packet ${task.subjectId}` }
  if (packet.acceptedAt !== null) {
    return { ok: false, problem: 'accepted', detail: 'the approved artefact is immutable' }
  }

  const current = PrefilledAnswers.parse(packet.prefilledAnswers)
  const output = task.output as { answers?: { questionKey: string; answer: string; approvedClaimIds: string[]; citedEvidenceIds?: string[] }[] }

  const questionByKey = new Map(PACKET_QUESTIONS.map((q) => [q.key, q]))
  const merged: PrefilledAnswer[] = []
  for (const answer of output.answers ?? []) {
    const question = questionByKey.get(answer.questionKey)
    if (!question) continue
    // The prompt text comes from the unanswered entry the packet already holds, so
    // the question a human reads is the one the packet posed, never one the session
    // restated.
    const posed = current.unanswered.find((u) => u.questionKey === answer.questionKey)
    merged.push({
      questionKey: answer.questionKey,
      question: posed?.question ?? question.prompt,
      answer: answer.answer,
      approvedClaimIds: answer.approvedClaimIds,
      citedEvidenceIds: answer.citedEvidenceIds ?? [],
      source: 'llm',
    })
  }

  const mergedKeys = new Set(merged.map((a) => a.questionKey))
  const next: PrefilledAnswers = {
    answers: [...current.answers.filter((a) => !mergedKeys.has(a.questionKey)), ...merged],
    unanswered: current.unanswered.filter((u) => !mergedKeys.has(u.questionKey)),
    generatedAt: current.generatedAt,
    promptVersion: PACKET_ANSWERS_PROMPT_VERSION,
  }

  const validated = await validateAnswers(db, next)
  if (!validated.ok) {
    return { ok: false, problem: 'invalid', detail: `${validated.problem}: ${validated.detail}` }
  }

  const claimIds = citedClaimIds(validated.value)
  const evidenceIds = citedEvidenceIdsOf(validated.value)
  const hash = computePacketHash({
    companyId: packet.companyId,
    opportunityId: packet.opportunityId,
    officialUrl: packet.officialUrl,
    resumeVersionId: packet.resumeVersionId,
    resumeSha256: packet.resumeVersion.fileSha256,
    prefilledAnswers: validated.value,
    citedEvidenceIds: evidenceIds,
    approvedClaimIds: claimIds,
  })

  await db.applicationPacket.update({
    where: { id: packet.id },
    data: {
      prefilledAnswers: validated.value as unknown as Prisma.InputJsonValue,
      citedEvidenceIds: evidenceIds,
      approvedClaimIds: claimIds,
      packetHash: hash,
    },
  })

  await writeAudit(db, {
    actorType: 'system',
    actorId: 'packet-answers',
    action: 'packet.answers_merged',
    subjectType: 'ApplicationPacket',
    subjectId: packet.id,
    metadata: {
      taskId,
      promptVersion: task.promptVersion,
      merged: merged.length,
      stillUnanswered: validated.value.unanswered.length,
      packetHash: hash,
    },
  })

  return {
    ok: true,
    packetId: packet.id,
    merged: merged.length,
    stillUnanswered: validated.value.unanswered.length,
  }
}

/** Merges every fulfilled `packet_answers` task that has not been applied yet. */
export async function applyAllFulfilledPacketAnswers(
  db: Db,
): Promise<{ applied: number; failed: { taskId: string; detail: string }[] }> {
  const tasks = await db.llmTask.findMany({
    where: { kind: 'packet_answers', status: 'fulfilled' },
    select: { id: true },
    orderBy: { fulfilledAt: 'asc' },
  })
  let applied = 0
  const failed: { taskId: string; detail: string }[] = []
  for (const task of tasks) {
    const result = await applyPacketAnswers(db, task.id)
    if (result.ok) applied += 1
    else if (result.problem !== 'accepted') failed.push({ taskId: task.id, detail: `${result.problem}: ${result.detail}` })
  }
  return { applied, failed }
}
