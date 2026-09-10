import { canonicalJson, sha256Hex } from '../../core/evidence/content-hash.js'
import type { PrefilledAnswers } from './answers.js'

/**
 * `packet_hash` — "the human approved exactly this", one milestone before A7 needs it.
 *
 * ## Why F3 computes a hash at all
 *
 * A7 says the approval hash must be *frozen at human approval and compared
 * byte-for-byte before transmission*, and that recomputing it from live data at send
 * time "always matches and proves nothing". F4 builds that for a `Draft`. F3's packet
 * is the first artefact in this system with an approval shape, and the F3 handover
 * asks that an accepted packet stay immutable so F4 can hash an equivalent structure
 * without redesigning the table.
 *
 * So this is deliberately A7's field list, translated:
 *
 * | A7 (a Draft) | here (a packet) |
 * |---|---|
 * | `subject`, `body_text` | `prefilledAnswers` — the text the human read |
 * | `recipient_email_normalized` | `officialUrl` — the route the artefact is for |
 * | `resume_version_id` | same |
 * | `attachment_sha256[]` | `resumeSha256` — the file, not just its row id |
 * | `cited_evidence_ids[]` | same, sorted |
 * | `sender_identity` | (no sender: F3 sends nothing) |
 * | `prompt_version` | same |
 *
 * plus `approvedClaimIds`, which has no A7 analogue because A7 predates the packet.
 *
 * ## Two details that are the whole point
 *
 * **The resume's file hash, not only its id.** A7 hashes `attachment_sha256[]` rather
 * than an attachment id for exactly this reason: the operator edits their resume in
 * place, so a row id is stable across a document that changed. A packet approved
 * against one PDF must not silently become an approval of a different one.
 *
 * **Ids are sorted; answers are not.** Citation arrays are sets — their order carries
 * no meaning and a re-derivation could reorder them, which would break a comparison
 * that should have passed. Answer order is display order, which the human saw, so it
 * is part of what they approved.
 */
export type PacketHashInput = {
  companyId: string
  opportunityId: string | null
  officialUrl: string
  resumeVersionId: string
  resumeSha256: string | null
  prefilledAnswers: PrefilledAnswers
  citedEvidenceIds: string[]
  approvedClaimIds: string[]
}

export function packetHashInput(input: PacketHashInput): Record<string, unknown> {
  return {
    companyId: input.companyId,
    opportunityId: input.opportunityId,
    officialUrl: input.officialUrl,
    resumeVersionId: input.resumeVersionId,
    resumeSha256: input.resumeSha256,
    promptVersion: input.prefilledAnswers.promptVersion,
    // Order preserved: this is what the human read, top to bottom.
    answers: input.prefilledAnswers.answers.map((a) => ({
      questionKey: a.questionKey,
      question: a.question,
      answer: a.answer,
      approvedClaimIds: [...a.approvedClaimIds].sort(),
      citedEvidenceIds: [...a.citedEvidenceIds].sort(),
      source: a.source,
    })),
    // Blank questions are part of the approved artefact too: approving a packet with
    // "expected graduation" unanswered is not the same act as approving one where it
    // has since been filled in.
    unanswered: input.prefilledAnswers.unanswered.map((u) => ({
      questionKey: u.questionKey,
      question: u.question,
    })),
    citedEvidenceIds: [...input.citedEvidenceIds].sort(),
    approvedClaimIds: [...input.approvedClaimIds].sort(),
  }
}

export function computePacketHash(input: PacketHashInput): string {
  return sha256Hex(canonicalJson(packetHashInput(input)))
}
