import { z } from 'zod'
import type { Db } from '../../core/audit/audit-log.js'

/**
 * The message as **sentences**, and the rule that a sentence asserting something it
 * cannot cite is a schema error rather than a review finding.
 *
 * ## Why sentences and not a string
 *
 * D5 states the citation invariant per sentence: *"the drafting schema requires an
 * `evidenceId` on every personalization sentence, so an unsupported claim is a schema
 * error, not a review finding — this is the missing mechanism behind §11's golden
 * test."* A rendered body cannot carry that. Once the sentences are joined, which
 * citation supported which claim is unrecoverable, and F4's exit criterion — *"a
 * sentence with no `evidenceId` is refused"* — has nothing to test against.
 *
 * So the draft is composed as a list, checked as a list, and rendered to `bodyText`
 * only at the end. `src/apply/packet/answers.ts` is the same mechanism pointed at an
 * application form, and F3 proved it works.
 *
 * ## The two-sided rule (F3 §4.1)
 *
 * `Evidence` bounds what may be said about the **company**. `ApprovedClaim` bounds
 * what may be said about the **candidate**. An outreach message asserts both, often
 * in one sentence, so both need an allow-set and both are enforced here:
 *
 * | role | must cite | who writes it |
 * |---|---|---|
 * | `company` | ≥1 `evidenceId` | a Claude Code session, from quoted `Evidence` |
 * | `candidate` | ≥1 `approvedClaimId` | a session, from quoted `ApprovedClaim` |
 * | `availability` | ≥1 `approvedClaimId` | deterministic, from the claim's own words |
 * | `tldr` `resume_link` `ask` `signoff` | nothing to cite | a registered template |
 *
 * ## Why the uncited roles cannot smuggle a fact
 *
 * A role with no citation requirement would be an obvious hole — write the company
 * claim in the `tldr` and no check fires. F3 §4.2 closed the same hole by making a
 * deterministic answer *exactly* the concatenation of the claims it cites, so
 * traceability is checkable by string containment rather than by a human reading for
 * smuggled facts.
 *
 * The analogue here: an uncited sentence may only be a **registered template**,
 * rendered from values the database already holds. `templateId` is required on those
 * roles and must name a real template, so free text cannot enter the message through
 * a role that is not checked. The operator can still edit a draft — that is what the
 * approval flow is for — but the composer cannot invent one.
 *
 * ## The operator's instruction
 *
 * §10.1: *"do not weaken it to go faster."* Per-sentence citation is the stated edge
 * over template spray and the one thing in this milestone not to trade for
 * throughput. Every relaxation below the line above is a change to that.
 */

/** §10.8's shape, in order. A message is these roles and nothing else. */
export const SENTENCE_ROLES = [
  'tldr',
  'company',
  'candidate',
  'availability',
  'resume_link',
  'ask',
  'signoff',
] as const
export type SentenceRole = (typeof SENTENCE_ROLES)[number]

/** Roles whose text is a claim about the employer, and therefore needs `Evidence`. */
export const COMPANY_CITED_ROLES = new Set<SentenceRole>(['company'])

/** Roles whose text is a claim about the candidate, and therefore needs an `ApprovedClaim`. */
export const CANDIDATE_CITED_ROLES = new Set<SentenceRole>(['candidate', 'availability'])

/**
 * Roles that assert nothing about either party and are rendered from a registered
 * template. Anything here carries no citation, so it must carry a `templateId`.
 */
export const TEMPLATE_ROLES = new Set<SentenceRole>(['tldr', 'resume_link', 'ask', 'signoff'])

export const DraftSentence = z.object({
  role: z.enum(SENTENCE_ROLES),
  text: z.string().min(1).max(600),
  evidenceIds: z.array(z.string().min(1)).default([]),
  approvedClaimIds: z.array(z.string().min(1)).default([]),
  /** Required on a template role; forbidden on a cited one. See `validateComposition`. */
  templateId: z.string().min(1).nullable().default(null),
  source: z.enum(['deterministic', 'llm', 'operator']),
})
export type DraftSentence = z.infer<typeof DraftSentence>

export const DraftComposition = z.object({
  subject: z.string().min(1).max(200),
  sentences: z.array(DraftSentence).min(1),
  /** Set once a `outreach_draft` task's output has been merged in. */
  promptVersion: z.string().nullable().default(null),
  composedAt: z.string().min(1),
})
export type DraftComposition = z.infer<typeof DraftComposition>

export type CompositionProblem =
  | 'schema'
  | 'uncited_evidence'
  | 'uncited_claim'
  | 'unknown_evidence'
  | 'unknown_claim'
  | 'unknown_template'
  | 'untemplated_sentence'
  | 'citation_on_template'
  | 'missing_required_role'

export type CompositionValidation =
  | { ok: true; value: DraftComposition }
  | { ok: false; problem: CompositionProblem; detail: string }

/**
 * The roles a message must contain to be a message at all.
 *
 * `company` is the load-bearing one: without it there is no evidence-cited sentence
 * and the draft is template spray, which is the thing §10.1 says the citation rule
 * exists to beat. `ask` is what makes it an inquiry rather than a statement.
 */
export const REQUIRED_ROLES: SentenceRole[] = ['company', 'candidate', 'ask']

/**
 * The choke point. Nothing writes `Draft.composition` without passing through here.
 *
 * Refuses, in order:
 *   1. output that does not parse;
 *   2. a company sentence with no `evidenceId`, or a candidate sentence with no
 *      `approvedClaimId` — the two halves of F4's exit criteria;
 *   3. a citation on a template role, or free text on one (the smuggling routes);
 *   4. a cited id that is not a live row — the check F3 §4.1 calls "a question about
 *      time", because a task fulfilled last week may cite a claim since withdrawn;
 *   5. a message missing a role that makes it a message.
 *
 * `allowedEvidenceIds` / `allowedApprovedClaimIds` are checked in `fulfilTask` at the
 * CLI, which asks a different question — *"did the session cite outside the set it
 * was given"*. This asks *"do these rows exist and are they still live"*. Both are
 * needed and neither subsumes the other.
 */
export async function validateComposition(
  db: Db,
  candidate: unknown,
  templateIds: ReadonlySet<string>,
): Promise<CompositionValidation> {
  const parsed = DraftComposition.safeParse(candidate)
  if (!parsed.success) {
    return {
      ok: false,
      problem: 'schema',
      detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    }
  }
  const value = parsed.data

  for (const s of value.sentences) {
    if (COMPANY_CITED_ROLES.has(s.role) && s.evidenceIds.length === 0) {
      return {
        ok: false,
        problem: 'uncited_evidence',
        detail: `a "${s.role}" sentence cites no Evidence: ${JSON.stringify(s.text.slice(0, 120))}`,
      }
    }
    if (CANDIDATE_CITED_ROLES.has(s.role) && s.approvedClaimIds.length === 0) {
      return {
        ok: false,
        problem: 'uncited_claim',
        detail: `a "${s.role}" sentence cites no ApprovedClaim: ${JSON.stringify(s.text.slice(0, 120))}`,
      }
    }
    if (TEMPLATE_ROLES.has(s.role)) {
      // Free text in an unchecked role is how a company claim escapes the evidence
      // rule. A template role renders from a registered string or it does not exist.
      if (s.templateId === null) {
        return {
          ok: false,
          problem: 'untemplated_sentence',
          detail: `a "${s.role}" sentence carries no templateId; an uncited role must be a registered template`,
        }
      }
      if (!templateIds.has(s.templateId)) {
        return {
          ok: false,
          problem: 'unknown_template',
          detail: `unregistered templateId "${s.templateId}"`,
        }
      }
      if (s.evidenceIds.length > 0 || s.approvedClaimIds.length > 0) {
        // A citation here would look like provenance while sitting on text no
        // citation rule checked. Better to refuse than to render a reassuring badge.
        return {
          ok: false,
          problem: 'citation_on_template',
          detail: `a "${s.role}" template sentence carries citations; move the claim into a company or candidate sentence`,
        }
      }
    }
  }

  const missingRole = REQUIRED_ROLES.find((r) => !value.sentences.some((s) => s.role === r))
  if (missingRole) {
    return {
      ok: false,
      problem: 'missing_required_role',
      detail: `no "${missingRole}" sentence; §10.8 requires one, and without a cited company sentence this is template spray`,
    }
  }

  const evidenceIds = [...new Set(value.sentences.flatMap((s) => s.evidenceIds))]
  if (evidenceIds.length > 0) {
    const live = await db.evidence.findMany({ where: { id: { in: evidenceIds } }, select: { id: true } })
    const found = new Set(live.map((r) => r.id))
    const bad = evidenceIds.filter((id) => !found.has(id))
    if (bad.length > 0) {
      return { ok: false, problem: 'unknown_evidence', detail: `cited evidence with no Evidence row: ${bad.join(', ')}` }
    }
  }

  const claimIds = [...new Set(value.sentences.flatMap((s) => s.approvedClaimIds))]
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
        detail: `cited claims that are not active ApprovedClaim rows: ${bad.join(', ')}`,
      }
    }
  }

  return { ok: true, value }
}

/**
 * The body the recipient reads, rendered from the sentences that were checked.
 *
 * Rendering is the LAST step and is pure, so `bodyText` is always a function of a
 * composition that passed the choke point. There is no path that writes a body
 * directly — that would be a message nobody checked.
 */
export function renderBody(composition: DraftComposition): string {
  const paragraphs: string[] = []
  const take = (role: SentenceRole) => composition.sentences.filter((s) => s.role === role).map((s) => s.text)

  paragraphs.push(...take('tldr'))
  // The evidence-cited opener and the candidate's answer to it belong together: §10.8
  // wants "one evidence-cited company sentence, one or two ApprovedClaim candidate
  // sentences", read as a single short paragraph rather than a list of assertions.
  const middle = [...take('company'), ...take('candidate')].join(' ')
  if (middle) paragraphs.push(middle)
  const closing = [...take('availability'), ...take('resume_link'), ...take('ask')].join(' ')
  if (closing) paragraphs.push(closing)
  paragraphs.push(...take('signoff'))

  return paragraphs.filter((p) => p.trim().length > 0).join('\n\n')
}

/** Every distinct evidence id the message cites. */
export function compositionEvidenceIds(c: DraftComposition): string[] {
  return [...new Set(c.sentences.flatMap((s) => s.evidenceIds))]
}

/** Every distinct approved-claim id the message cites. */
export function compositionClaimIds(c: DraftComposition): string[] {
  return [...new Set(c.sentences.flatMap((s) => s.approvedClaimIds))]
}
