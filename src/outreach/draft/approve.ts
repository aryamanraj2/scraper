import type { Db } from '../../core/audit/audit-log.js'
import { writeAudit } from '../../core/audit/audit-log.js'
import type { ReasonCodeValue } from '../../core/reason-codes/registry.js'
import { computeApprovalHash, type ApprovalHashInput } from './hash.js'
import type { DraftComposition } from './message.js'

/**
 * The approval flow — A7, and the one thing F5's send gate rests on.
 *
 * ## What approval is
 *
 * `handover.md` §1.6, unamended and confirmed by the operator in §10.7: *"No message
 * may send without immutable user approval."* At 2,000 contacts that is 2,000
 * individual approvals, and the operator was asked directly and said *"Yes — per
 * message, unchanged."* So this function is called once per message, by a human, and
 * there is deliberately no bulk form of it.
 *
 * ## What the hash is for
 *
 * A7: frozen at human approval, compared byte-for-byte before transmission, and
 * *"recomputing it from live data at send time always matches and proves nothing"*.
 * So the value is computed **here**, from the rows as they stand at the moment a human
 * says yes, and stored. F5 recomputes the same input from live rows immediately before
 * the provider call and compares. A swapped recipient, an edited resume file, a
 * withdrawn claim, a reworded sentence or a changed citation all produce a different
 * hash and abort the send with `approval_hash_mismatch`.
 *
 * A7 again, and it is worth quoting because it is the part people relax: *"Mismatch
 * returns to `awaiting_approval`; never auto-resolve."*
 *
 * ## Why an approved draft is frozen
 *
 * Composition and the answer-merge both refuse a draft with `approvedAt` set, exactly
 * as F3 §4.11 froze an accepted packet. A hash is a claim about what a human read; if
 * the row underneath it can still change, the claim is false while the hash still
 * looks like proof.
 */

export type ApproveResult =
  | { ok: true; draftId: string; approvalHash: string }
  | {
      ok: false
      reason:
        | 'unknown_draft'
        | 'not_gated'
        | 'already_approved'
        | 'no_recipient'
        | 'no_composition'
        | 'no_sender_identity'
      detail: string
    }

/**
 * ## Where `senderIdentity` comes from, and the hole this closed *(F5 §4.2)*
 *
 * A7's field list includes `sender_identity`, and until F5 it was a caller option that
 * no caller passed: `tools/run-drafts.ts` called `approveDraft(db, id, by)` and every
 * stored `approval_hash` was therefore computed over `null`. The send gate would have
 * had to pass `null` too in order to match — so the hash bound the subject, the body,
 * the recipient, the resume file and every citation, and did *not* bind the one field
 * that decides whose name is on the message. Swapping the sending account would have
 * left the approval valid.
 *
 * It is read from `CandidateProfile.senderIdentity` here, stored on the draft, and
 * read back from the draft when the gate recomputes. An approval with no identity to
 * freeze is refused rather than defaulted, because defaulting is what produced the
 * hole.
 */
export async function approveDraft(
  db: Db,
  draftId: string,
  approvedBy: string,
  opts: { now?: Date; senderIdentity?: string | null } = {},
): Promise<ApproveResult> {
  const now = opts.now ?? new Date()

  const draft = await db.draft.findUnique({
    where: { id: draftId },
    select: {
      id: true,
      status: true,
      subject: true,
      bodyText: true,
      composition: true,
      outreachCase: true,
      approvedAt: true,
      promptVersion: true,
      citedEvidenceIds: true,
      approvedClaimIds: true,
      contact: { select: { emailNormalized: true } },
      resumeVersion: { select: { id: true, fileSha256: true, linkUrl: true } },
    },
  })
  if (!draft) return { ok: false, reason: 'unknown_draft', detail: draftId }
  if (draft.approvedAt) return { ok: false, reason: 'already_approved', detail: draft.approvedAt.toISOString() }

  // Only a draft that passed the Quality Gate may be approved. Part F puts the gate
  // before approval for a reason: a human approving an ungated draft is a human doing
  // the gate's job from memory.
  if (draft.status !== 'awaiting_approval') {
    return { ok: false, reason: 'not_gated', detail: `status is "${draft.status}", not awaiting_approval` }
  }
  if (!draft.contact) return { ok: false, reason: 'no_recipient', detail: 'draft has no contact' }
  if (!draft.composition) return { ok: false, reason: 'no_composition', detail: draft.id }

  // An explicit argument wins — a test pins a value — but the real source is the
  // profile, and there is no fallback to null.
  const profile = await db.candidateProfile.findFirst({ select: { senderIdentity: true } })
  const senderIdentity = opts.senderIdentity ?? profile?.senderIdentity ?? null
  if (!senderIdentity) {
    return {
      ok: false,
      reason: 'no_sender_identity',
      detail:
        'CandidateProfile.senderIdentity is unset: there is no identity to freeze into the ' +
        'approval, and A7 hashes it. Run `npm run seed:operator`.',
    }
  }

  const input: ApprovalHashInput = {
    subject: draft.subject ?? '',
    bodyText: draft.bodyText ?? '',
    recipientEmailNormalized: draft.contact.emailNormalized,
    resumeVersionId: draft.resumeVersion?.id ?? null,
    // The FILE, not just the row id: the operator edits resumes in place (A7, F3 §4.11).
    resumeSha256: draft.resumeVersion?.fileSha256 ?? null,
    // And the LINK, because H3 links rather than attaches and the URL is what the
    // recipient receives (F5 — see hash.ts for the measurement that required this).
    resumeLinkUrl: draft.resumeVersion?.linkUrl ?? null,
    citedEvidenceIds: draft.citedEvidenceIds,
    approvedClaimIds: draft.approvedClaimIds,
    senderIdentity,
    promptVersion: draft.promptVersion,
    outreachCase: draft.outreachCase ?? '',
    composition: draft.composition as DraftComposition,
  }
  const approvalHash = computeApprovalHash(input)

  await db.draft.update({
    where: { id: draftId },
    data: {
      status: 'approved',
      approvalHash,
      senderIdentity,
      approvedBy,
      approvedAt: now,
    },
  })

  await writeAudit(db, {
    actorType: 'user',
    actorId: approvedBy,
    action: 'draft.approved',
    subjectType: 'Draft',
    subjectId: draftId,
    metadata: {
      approvalHash,
      senderIdentity,
      outreachCase: draft.outreachCase,
      // Recorded so an auditor can see WHAT was approved without re-reading the row,
      // which is the point of handover.md §11's reconstruction criterion.
      citedEvidenceIds: draft.citedEvidenceIds,
      approvedClaimIds: draft.approvedClaimIds,
      // Sending is still hard-disabled; this is a record, not a release.
      sendingEnabled: false,
    },
  })

  return { ok: true, draftId, approvalHash }
}

/**
 * Recomputes the hash from live rows and compares it byte-for-byte with the frozen
 * value — the check F5's send gate runs immediately before the provider call (D6.1).
 *
 * It lives here rather than in F5 so that F4 can prove the property it is responsible
 * for: that editing any hashed field after approval invalidates the approval. F5 calls
 * it; F4 tests it.
 *
 * A mismatch NEVER auto-resolves (A7). The caller's only correct response is to return
 * the draft to `awaiting_approval` and let a human look at it again.
 */
export type HashVerification =
  | { matches: true }
  | { matches: false; reason: ReasonCodeValue; frozen: string | null; recomputed: string }

export async function verifyApprovalHash(
  db: Db,
  draftId: string,
  opts: { senderIdentity?: string | null } = {},
): Promise<HashVerification> {
  const draft = await db.draft.findUniqueOrThrow({
    where: { id: draftId },
    // NOTE: `senderIdentity` is read from the DRAFT, not re-derived from the profile.
    // That is the asymmetry A7 asks for and it is easy to get backwards. Every other
    // field here is deliberately live — a swapped recipient or an edited resume must
    // invalidate the approval — but the identity the human approved is a property of
    // the approval itself. Re-deriving it from `CandidateProfile` would mean editing
    // the profile silently re-validated every outstanding approval, which is the
    // "recomputing from live data always matches and proves nothing" failure applied
    // to the one field that says whose name is on the message.
    select: {
      subject: true,
      bodyText: true,
      composition: true,
      outreachCase: true,
      approvalHash: true,
      senderIdentity: true,
      promptVersion: true,
      citedEvidenceIds: true,
      approvedClaimIds: true,
      contact: { select: { emailNormalized: true } },
      resumeVersion: { select: { id: true, fileSha256: true, linkUrl: true } },
    },
  })

  const recomputed = computeApprovalHash({
    subject: draft.subject ?? '',
    bodyText: draft.bodyText ?? '',
    recipientEmailNormalized: draft.contact?.emailNormalized ?? '',
    resumeVersionId: draft.resumeVersion?.id ?? null,
    resumeSha256: draft.resumeVersion?.fileSha256 ?? null,
    resumeLinkUrl: draft.resumeVersion?.linkUrl ?? null,
    citedEvidenceIds: draft.citedEvidenceIds,
    approvedClaimIds: draft.approvedClaimIds,
    senderIdentity: opts.senderIdentity ?? draft.senderIdentity,
    promptVersion: draft.promptVersion,
    outreachCase: draft.outreachCase ?? '',
    composition: draft.composition as DraftComposition,
  })

  if (draft.approvalHash !== null && draft.approvalHash === recomputed) return { matches: true }
  return {
    matches: false,
    reason: 'approval_hash_mismatch',
    frozen: draft.approvalHash,
    recomputed,
  }
}
