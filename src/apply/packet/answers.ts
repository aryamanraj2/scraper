import { z } from 'zod'
import type { Db } from '../../core/audit/audit-log.js'
import {
  DETERMINISTIC_QUESTIONS,
  PACKET_QUESTIONS,
  renderPrompt,
  type PacketQuestion,
} from './questions.js'

/**
 * Prefilled answers, and the rule that an answer citing no `ApprovedClaim` is a
 * **schema error rather than a review finding**.
 *
 * This is the same mechanism as D5's citation rule for company facts, pointed at the
 * candidate instead: `Evidence` bounds what may be said about the employer,
 * `ApprovedClaim` bounds what may be said about the applicant. Both are enforced at a
 * choke point rather than trusted, and for the same reason — a rule that lives in
 * whoever remembers it is not a rule.
 *
 * Enforcement happens twice, on purpose:
 *
 *  1. `PrefilledAnswer` requires `approvedClaimIds` to be non-empty, so an
 *     uncited answer cannot be *constructed*.
 *  2. `validateAnswers` checks every cited id against the live `ApprovedClaim` rows
 *     and refuses ids that do not exist or are inactive, so an answer cannot cite a
 *     claim that was withdrawn after it was written.
 *
 * The first catches the LLM path and the operator path alike. The second catches
 * time.
 */

export const PrefilledAnswer = z.object({
  questionKey: z.string().min(1),
  question: z.string().min(1),
  answer: z.string().min(1),
  /**
   * At least one. An answer about the candidate that cites no approved claim is a
   * fact this system was never authorized to state.
   */
  approvedClaimIds: z.array(z.string().min(1)).min(1),
  /** Company evidence, where the answer says anything about the employer. */
  citedEvidenceIds: z.array(z.string().min(1)).default([]),
  source: z.enum(['deterministic', 'llm', 'operator']),
})
export type PrefilledAnswer = z.infer<typeof PrefilledAnswer>

/** A question deliberately left blank, with the reason. H10's visible degradation. */
export const UnansweredQuestion = z.object({
  questionKey: z.string().min(1),
  question: z.string().min(1),
  reason: z.string().min(1),
})
export type UnansweredQuestion = z.infer<typeof UnansweredQuestion>

export const PrefilledAnswers = z.object({
  answers: z.array(PrefilledAnswer),
  unanswered: z.array(UnansweredQuestion),
  generatedAt: z.string().min(1),
  /** Set once a judgment answer from an `LlmTask` has been merged in. */
  promptVersion: z.string().nullable().default(null),
})
export type PrefilledAnswers = z.infer<typeof PrefilledAnswers>

export type ActiveClaim = { id: string; key: string; text: string; category: string }

export async function loadActiveClaims(db: Db): Promise<Map<string, ActiveClaim>> {
  const rows = await db.approvedClaim.findMany({
    where: { isActive: true },
    select: { id: true, key: true, text: true, category: true },
  })
  return new Map(rows.map((r) => [r.key, r]))
}

/**
 * Builds the answers that need no judgment.
 *
 * The answer text is the cited claims' own text joined with a space — never a
 * rewording. A question whose claims are not all present is recorded as unanswered
 * with the question's own note, rather than answered from the subset: a partial
 * answer to "will you require sponsorship" is worse than a blank one, because the
 * operator would not know it was partial.
 */
export function buildDeterministicAnswers(
  claims: Map<string, ActiveClaim>,
  companyName: string,
  questions: PacketQuestion[] = DETERMINISTIC_QUESTIONS,
): { answers: PrefilledAnswer[]; unanswered: UnansweredQuestion[] } {
  const answers: PrefilledAnswer[] = []
  const unanswered: UnansweredQuestion[] = []

  for (const question of questions) {
    const prompt = renderPrompt(question, companyName)
    const resolved = (question.claimKeys ?? []).map((key) => claims.get(key))
    const missing = (question.claimKeys ?? []).filter((key) => !claims.has(key))

    if (resolved.length === 0 || missing.length > 0) {
      unanswered.push({
        questionKey: question.key,
        question: prompt,
        reason:
          question.note ??
          `no approved claim for ${missing.join(', ') || 'this question'}`,
      })
      continue
    }

    const present = resolved.filter((c): c is ActiveClaim => c !== undefined)
    answers.push({
      questionKey: question.key,
      question: prompt,
      answer: present.map((c) => c.text).join(' '),
      approvedClaimIds: present.map((c) => c.id),
      citedEvidenceIds: [],
      source: 'deterministic',
    })
  }

  return { answers, unanswered }
}

export type AnswerValidationFailure = {
  ok: false
  problem: 'schema' | 'uncited_claim' | 'unknown_claim' | 'unknown_evidence' | 'unknown_question'
  detail: string
}
export type AnswerValidationResult = { ok: true; value: PrefilledAnswers } | AnswerValidationFailure

/**
 * The choke point. Nothing writes `ApplicationPacket.prefilledAnswers` without
 * passing through here.
 *
 * Refuses, in order:
 *  - output that does not parse (which includes an empty `approvedClaimIds`, so the
 *    "an answer citing no approved claim is refused" criterion is a schema failure);
 *  - a claim id that is not a live, active `ApprovedClaim`;
 *  - an evidence id that is not a real `Evidence` row;
 *  - a question key that is not in the registry, so an answer cannot invent the
 *    question it is answering.
 */
export async function validateAnswers(
  db: Db,
  candidate: unknown,
): Promise<AnswerValidationResult> {
  const parsed = PrefilledAnswers.safeParse(candidate)
  if (!parsed.success) {
    const uncited = parsed.error.issues.some(
      (i) => i.path.includes('approvedClaimIds') && i.code === 'too_small',
    )
    return {
      ok: false,
      problem: uncited ? 'uncited_claim' : 'schema',
      detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    }
  }

  const value = parsed.data
  const knownQuestions = new Set(PACKET_QUESTIONS.map((q) => q.key))
  for (const answer of value.answers) {
    if (!knownQuestions.has(answer.questionKey)) {
      return {
        ok: false,
        problem: 'unknown_question',
        detail: `answer for unregistered question "${answer.questionKey}"`,
      }
    }
  }

  const claimIds = [...new Set(value.answers.flatMap((a) => a.approvedClaimIds))]
  if (claimIds.length > 0) {
    const live = await db.approvedClaim.findMany({
      where: { id: { in: claimIds }, isActive: true },
      select: { id: true },
    })
    const found = new Set(live.map((r) => r.id))
    const bad = claimIds.filter((id) => !found.has(id))
    if (bad.length > 0) {
      return {
        ok: false,
        problem: 'unknown_claim',
        detail: `cited claim ids that are not active ApprovedClaim rows: ${bad.join(', ')}`,
      }
    }
  }

  const evidenceIds = [...new Set(value.answers.flatMap((a) => a.citedEvidenceIds))]
  if (evidenceIds.length > 0) {
    const live = await db.evidence.findMany({
      where: { id: { in: evidenceIds } },
      select: { id: true },
    })
    const found = new Set(live.map((r) => r.id))
    const bad = evidenceIds.filter((id) => !found.has(id))
    if (bad.length > 0) {
      return {
        ok: false,
        problem: 'unknown_evidence',
        detail: `cited evidence ids with no Evidence row: ${bad.join(', ')}`,
      }
    }
  }

  return { ok: true, value }
}

/** Every distinct claim id an answer set cites. */
export function citedClaimIds(answers: PrefilledAnswers): string[] {
  return [...new Set(answers.answers.flatMap((a) => a.approvedClaimIds))]
}

/** Every distinct evidence id an answer set cites. */
export function citedEvidenceIdsOf(answers: PrefilledAnswers): string[] {
  return [...new Set(answers.answers.flatMap((a) => a.citedEvidenceIds))]
}
