import { canonicalJson, sha256Hex } from '../../core/evidence/content-hash.js'
import type { DraftComposition } from './message.js'

/**
 * `approval_hash` — A7, at the milestone A7 was written for.
 *
 * ## A7, verbatim
 *
 * > `approval_hash = sha256(canonical_json({subject, body_text,
 * > recipient_email_normalized, resume_version_id, attachment_sha256[],
 * > cited_evidence_ids[], sender_identity, prompt_version}))` — frozen at human
 * > approval, compared byte-for-byte before transmission. Mismatch returns to
 * > `awaiting_approval`; never auto-resolve.
 *
 * Every field is present below. `src/apply/packet/hash.ts` is the rehearsal F3 ran a
 * milestone early, and the two non-obvious decisions it made are inherited rather
 * than re-derived:
 *
 * **The resume's file hash, not only its row id.** A7 hashes `attachment_sha256[]`
 * for a reason the F3 handover states plainly: the operator edits their resume in
 * place, so a row id is stable across a document that changed. An approval must not
 * survive that.
 *
 * **Citation arrays are sorted; sentence order is not.** Citation arrays are sets
 * whose order carries no meaning, and a re-derivation could reorder them, breaking a
 * comparison that should have passed. Sentence order is what the human read, so it is
 * part of what they approved.
 *
 * ## What F4 adds to the rehearsal
 *
 * `approvedClaimIds`, which has no A7 analogue because A7 predates the two-sided
 * citation rule (F3 §4.1). A draft asserts things about the candidate, those
 * assertions are bounded by `ApprovedClaim`, and an approval that did not cover them
 * would let a withdrawn claim's text survive into a sent message.
 *
 * And **the composition, not only the rendered body**. `bodyText` is a function of
 * the sentences, but hashing only the rendering would let a sentence's *citations*
 * change while its text stayed identical — the message would read the same and cite
 * something the human never saw. The per-sentence citation is the thing §10.1 says
 * not to weaken, so it is inside the hash.
 *
 * ## Why it is never recomputed from live rows at send time
 *
 * A7 again: recomputing from live data at send time "always matches and proves
 * nothing". The frozen value is stored at approval; F5's send gate recomputes this
 * same input from live rows and compares byte-for-byte, so a swapped recipient, an
 * edited resume, a withdrawn claim or a reworded sentence all fail closed.
 */
export type ApprovalHashInput = {
  subject: string
  bodyText: string
  /** A7's `recipient_email_normalized`. Pinned on the draft, not read via the lead. */
  recipientEmailNormalized: string
  resumeVersionId: string | null
  /** A7's `attachment_sha256[]`: the FILE, so an edit in place invalidates approval. */
  resumeSha256: string | null
  citedEvidenceIds: string[]
  approvedClaimIds: string[]
  senderIdentity: string | null
  promptVersion: string | null
  /** Which of Part C's cases permitted this message at all. */
  outreachCase: string
  composition: DraftComposition
}

export function approvalHashInput(input: ApprovalHashInput): Record<string, unknown> {
  return {
    subject: input.subject,
    bodyText: input.bodyText,
    recipientEmailNormalized: input.recipientEmailNormalized,
    resumeVersionId: input.resumeVersionId,
    resumeSha256: input.resumeSha256,
    senderIdentity: input.senderIdentity,
    promptVersion: input.promptVersion,
    outreachCase: input.outreachCase,
    // Order preserved: this is the message the human read, top to bottom.
    sentences: input.composition.sentences.map((s) => ({
      role: s.role,
      text: s.text,
      templateId: s.templateId,
      source: s.source,
      evidenceIds: [...s.evidenceIds].sort(),
      approvedClaimIds: [...s.approvedClaimIds].sort(),
    })),
    citedEvidenceIds: [...input.citedEvidenceIds].sort(),
    approvedClaimIds: [...input.approvedClaimIds].sort(),
  }
}

export function computeApprovalHash(input: ApprovalHashInput): string {
  return sha256Hex(canonicalJson(approvalHashInput(input)))
}
