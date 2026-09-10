import { z } from 'zod'

/**
 * The task kinds a Claude Code session can be asked to fulfil, and the schema each
 * response is validated against.
 *
 * ## Why the registry is in code rather than only in the row
 *
 * `LlmTask.responseSchema` stores a JSON Schema so the session can read what shape
 * is expected without running any of our code. Validation, though, uses the Zod
 * schema here, keyed by `kind` + `promptVersion`. Two reasons:
 *
 *  1. The JSON Schema is DERIVED from the Zod schema (`z.toJSONSchema`), so the Zod
 *     schema is the source of truth and validating against the derivative would be
 *     validating against a copy.
 *  2. Validating stored JSON Schema at fulfil time needs a JSON-Schema validator —
 *     a new dependency in the one code path whose entire job is to be the thing
 *     that cannot be talked out of checking.
 *
 * A task whose `kind`/`promptVersion` pair is not in this registry cannot be
 * fulfilled at all. That is deliberate: a row written by an older build, whose
 * schema no longer exists, must fail closed rather than be accepted unvalidated.
 */

/** A citation the response makes. Every id must be in the task's allowedEvidenceIds. */
const Citation = z.object({
  evidenceId: z.string().min(1),
  /** The claim this evidence supports, in the session's own words. */
  claim: z.string().min(1).max(500),
})

/**
 * F2's only task kind: a research brief.
 *
 * `handover.md` §4 defines `ResearchBrief` as "2-4 evidence-backed company facts
 * and a relevance explanation; citations are mandatory". The schema enforces the
 * count and the citation, so a brief without support is a schema error rather than
 * something a human is expected to catch (Part G's golden-test mechanism).
 */
const ResearchBriefResponse = z.object({
  facts: z
    .array(
      z.object({
        fact: z.string().min(1).max(500),
        citations: z.array(Citation).min(1),
      }),
    )
    .min(2)
    .max(4),
  relevanceNote: z.string().min(1).max(1000),
  /** The track the session judges most relevant, from the deterministic shortlist. */
  suggestedTrack: z.enum(['ios_android', 'ai_engineer', 'sde', 'swe']).nullable(),
})

export type ResearchBriefResponse = z.infer<typeof ResearchBriefResponse>

/**
 * F3's task kind: the two application answers that need judgment.
 *
 * Everything else on a packet is deterministic — a name, a degree, a work-
 * authorization status is already sitting in `ApprovedClaim` and needs no model. What
 * needs one is "why this company" and "what of your experience is relevant here",
 * because the answer has to hold company `Evidence` and candidate `ApprovedClaim`
 * side by side.
 *
 * Both citation arrays are mandatory in spirit and one of them in schema:
 * `approvedClaimIds` is `.min(1)` because an answer about the candidate that cites no
 * approved claim is a fact this system was never authorized to state, and
 * `handover.md` §11's golden test is that such a thing is a schema error rather than
 * something a reviewer is expected to notice. `citedEvidenceIds` may be empty — an
 * answer about the candidate's own experience need say nothing about the employer —
 * but anything it does cite must be in the task's allow-set.
 */
const PacketAnswerResponse = z.object({
  answers: z
    .array(
      z.object({
        questionKey: z.enum(['why_company', 'relevant_experience']),
        answer: z.string().min(1).max(1200),
        approvedClaimIds: z.array(z.string().min(1)).min(1),
        citedEvidenceIds: z.array(z.string().min(1)).default([]),
      }),
    )
    .min(1)
    .max(2),
})

export type PacketAnswerResponse = z.infer<typeof PacketAnswerResponse>

/**
 * F4's task kind: the two sentences of an outreach message that need judgment.
 *
 * Everything else in a message is deterministic — the TL;DR, the resume link, the
 * ask and the sign-off are registered templates (`src/outreach/draft/templates.ts`)
 * rendered from values already in the database, and the availability sentence is an
 * `ApprovedClaim`'s own words. What needs a session is the evidence-cited company
 * sentence and the candidate sentence that answers it.
 *
 * Both citation arrays are `.min(1)`, and that is the milestone's whole point:
 *
 *  - `evidenceIds` on the company sentence is D5's invariant — *"an unsupported claim
 *    is a schema error, not a review finding"* — finally load-bearing rather than
 *    latent, because F4 is the first milestone that composes a message.
 *  - `approvedClaimIds` on the candidate sentence is F3 §4.1's candidate-side
 *    analogue. A statement this system makes about the operator must trace to a
 *    document the operator wrote.
 *
 * The operator's instruction in §10.1 — *"do not weaken it to go faster"* — is
 * enforced here, at the schema, rather than in whoever is reviewing. A response that
 * omits a citation cannot be accepted by `llm:fulfil` at all.
 */
const OutreachDraftResponse = z.object({
  /**
   * No "Re:", no false urgency. The Quality Gate checks this too; requiring it in the
   * schema means the session is told the rule rather than only judged by it.
   */
  subject: z.string().min(1).max(90),
  /** One sentence about the employer, every clause of it supported by cited Evidence. */
  companySentence: z.object({
    text: z.string().min(1).max(400),
    evidenceIds: z.array(z.string().min(1)).min(1),
  }),
  /**
   * One or two sentences about the candidate (§10.8), each citing the ApprovedClaim
   * rows its facts come from.
   */
  candidateSentences: z
    .array(
      z.object({
        text: z.string().min(1).max(400),
        approvedClaimIds: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1)
    .max(2),
})

export type OutreachDraftResponse = z.infer<typeof OutreachDraftResponse>

export const LLM_TASK_KINDS = {
  researchBrief: 'research_brief',
  packetAnswers: 'packet_answers',
  outreachDraft: 'outreach_draft',
} as const

export type LlmTaskKind = (typeof LLM_TASK_KINDS)[keyof typeof LLM_TASK_KINDS]

export type LlmTaskSchemaEntry = {
  kind: LlmTaskKind
  promptVersion: string
  schema: z.ZodType<unknown>
  /** One line the CLI prints, so an operator knows what they are being asked for. */
  description: string
}

export const LLM_TASK_SCHEMAS: LlmTaskSchemaEntry[] = [
  {
    kind: LLM_TASK_KINDS.researchBrief,
    promptVersion: 'research_brief@1',
    schema: ResearchBriefResponse,
    description: '2-4 evidence-backed facts about the company, each with a citation, plus a relevance note.',
  },
  {
    kind: LLM_TASK_KINDS.packetAnswers,
    promptVersion: 'packet_answers@1',
    schema: PacketAnswerResponse,
    description:
      'Application answers for "why this company" and "relevant experience", each citing at least one ApprovedClaim and any company Evidence it leans on.',
  },
  {
    kind: LLM_TASK_KINDS.outreachDraft,
    promptVersion: 'outreach_draft@1',
    schema: OutreachDraftResponse,
    description:
      'A short outreach message: a subject line, one Evidence-cited sentence about the company, and one or two ApprovedClaim-cited sentences about the candidate. Every citation must come from the task\'s allow-sets.',
  },
]

export function findTaskSchema(kind: string, promptVersion: string): LlmTaskSchemaEntry | undefined {
  return LLM_TASK_SCHEMAS.find((e) => e.kind === kind && e.promptVersion === promptVersion)
}

/**
 * Prompt versions are unique across kinds, so a caller holding only the version —
 * which is all the `LlmGateway` interface passes — can still be routed.
 */
export function findTaskSchemaByPromptVersion(promptVersion: string): LlmTaskSchemaEntry | undefined {
  return LLM_TASK_SCHEMAS.find((e) => e.promptVersion === promptVersion)
}

/** JSON Schema for the row, so the session sees the contract without running code. */
export function jsonSchemaFor(schema: z.ZodType<unknown>): unknown {
  return z.toJSONSchema(schema, { io: 'output' })
}

/**
 * Every `evidenceId` appearing anywhere in a response, at any depth.
 *
 * Walking the whole object rather than reading a known field is deliberate: the
 * citation rule has to hold for schemas that do not exist yet, and a future schema
 * that nests citations one level deeper must not quietly escape the check.
 */
export function collectCitedEvidenceIds(value: unknown, found = new Set<string>()): Set<string> {
  return collectIds(value, EVIDENCE_ID_KEYS, EVIDENCE_ID_ARRAY_KEYS, found)
}

/**
 * The same walk for candidate facts (F3).
 *
 * `Evidence` bounds what may be said about the COMPANY; `ApprovedClaim` bounds what
 * may be said about the CANDIDATE. A prefilled application answer makes both kinds of
 * statement in one sentence, so both need an allow-set and both need to be checked
 * the same way — by walking the whole response rather than reading a known field, so
 * a schema that nests citations one level deeper cannot escape the check.
 */
export function collectCitedApprovedClaimIds(value: unknown, found = new Set<string>()): Set<string> {
  return collectIds(value, CLAIM_ID_KEYS, CLAIM_ID_ARRAY_KEYS, found)
}

const EVIDENCE_ID_KEYS = new Set(['evidenceId', 'evidence_id'])
const EVIDENCE_ID_ARRAY_KEYS = new Set(['citedEvidenceIds', 'evidenceIds', 'cited_evidence_ids'])
const CLAIM_ID_KEYS = new Set(['approvedClaimId', 'approved_claim_id', 'claimId'])
const CLAIM_ID_ARRAY_KEYS = new Set(['approvedClaimIds', 'approved_claim_ids', 'claimIds'])

function collectIds(
  value: unknown,
  scalarKeys: ReadonlySet<string>,
  arrayKeys: ReadonlySet<string>,
  found: Set<string>,
): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectIds(item, scalarKeys, arrayKeys, found)
    return found
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (scalarKeys.has(key) && typeof child === 'string') found.add(child)
      else if (arrayKeys.has(key) && Array.isArray(child)) {
        for (const id of child) if (typeof id === 'string') found.add(id)
      } else collectIds(child, scalarKeys, arrayKeys, found)
    }
  }
  return found
}
