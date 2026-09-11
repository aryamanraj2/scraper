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
 * ## What F5 adds, and the defect that required it
 *
 * `resumeLinkUrl` — the URL the recipient actually clicks.
 *
 * The F5 handover §8.5 stated that hosting the resumes *"will change every approved
 * draft's `approval_hash`, which is the mechanism working"*. It was measured, and it
 * is false. After `seed:operator` re-ran with real hosted URLs, the one approved draft
 * in the live database still verified as `{ matches: true }` — over a body containing
 * `Resume: file:///Users/.../Resume_AI.pdf`.
 *
 * A7 was doing exactly what A7 says. Its field list binds `resume_version_id` and
 * `attachment_sha256[]`, and neither moved: the row id is the same row and the FILE is
 * byte-identical — only where it is published changed. `bodyText` and `composition`
 * were frozen at composition time and did not move either.
 *
 * The gap is that A7 was written for an **attachment**, where the document's content
 * hash is the thing the recipient receives. H3 makes this system link rather than
 * attach (B5: a new sending domain plus an attachment is the worst deliverability
 * combination available), and for a link the URL *is* the payload — a correct hash over
 * a dead link is a valid approval for a message that does not work.
 *
 * So the URL is hashed too. Re-hosting a resume now invalidates every approval that
 * linked it, which is what §8.5 claimed and now describes.
 *
 * Note what this does NOT fix: the stored `bodyText` still contains whatever link was
 * rendered at composition. Invalidating the approval sends the draft back to a human,
 * and the correct repair is re-composition, not re-approval.
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
  /** F5: the URL the recipient clicks. For a LINKED resume this is the payload. */
  resumeLinkUrl: string | null
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
    resumeLinkUrl: input.resumeLinkUrl,
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
