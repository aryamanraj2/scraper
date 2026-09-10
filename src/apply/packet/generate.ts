import type { Prisma } from '../../../generated/prisma/client.js'
import type { Db } from '../../core/audit/audit-log.js'
import { writeAudit } from '../../core/audit/audit-log.js'
import {
  buildDeterministicAnswers,
  citedClaimIds,
  citedEvidenceIdsOf,
  loadActiveClaims,
  validateAnswers,
  type PrefilledAnswers,
} from './answers.js'
import { computePacketHash } from './hash.js'
import { JUDGMENT_QUESTIONS, renderPrompt } from './questions.js'
import {
  auditCappedCandidates,
  selectPacketCandidates,
  PACKETS_PER_COMPANY_CAP,
  type PacketCandidate,
} from './select.js'

/**
 * `ApplicationPacket` generation — F3's payload.
 *
 * ## H8, stated where the code is
 *
 * **This module prepares an application. Nothing here submits one.** Greenhouse
 * exposes an authenticated application-submission endpoint; we do not call it, and no
 * code path in this system posts to an ATS. H8 is marked irreversible in Part H, and
 * auto-applying is precisely the volume-over-quality failure `handover.md` exists to
 * reject — quite apart from breaching ATS terms. A packet's terminal act is putting a
 * URL, a resume and a set of prefilled answers in front of the operator.
 *
 * ## Regeneration is an update
 *
 * `(opportunityId, resumeVersionId)` is unique, so re-running is idempotent: the
 * operator gets the same packet refreshed, not a second copy of the same application.
 *
 * An **accepted** packet is not refreshed. Once the human has approved an artefact,
 * `packet_hash` is a claim about what they approved; rewriting the answers under it
 * would make that claim false. Regeneration skips accepted packets and says so.
 */

export type GeneratedPacket = {
  packetId: string
  opportunityId: string
  companyName: string
  trackKey: string
  resumeLabel: string
  officialUrl: string
  answers: number
  unanswered: number
  created: boolean
}

export type GenerateOutcome = {
  packets: GeneratedPacket[]
  skipped: { opportunityId: string; companyName: string; reason: string }[]
  cappedOut: number
  companies: number
  cap: number
}

export type GenerateOptions = {
  cap?: number
  campaignCycle?: string
  now?: Date
  /** Queue an `LlmTask` for the judgment questions. Off in tests that assert no queueing. */
  queueJudgmentTasks?: boolean
}

export async function generateApplicationPackets(
  db: Db,
  opts: GenerateOptions = {},
): Promise<GenerateOutcome> {
  const now = opts.now ?? new Date()
  const cap = opts.cap ?? PACKETS_PER_COMPANY_CAP

  const selection = await selectPacketCandidates(db, {
    cap,
    ...(opts.campaignCycle === undefined ? {} : { campaignCycle: opts.campaignCycle }),
  })
  await auditCappedCandidates(db, selection.cappedOut, cap)

  const claims = await loadActiveClaims(db)
  const resumesByTrack = await loadTrackResumes(db)

  const packets: GeneratedPacket[] = []
  const skipped: GenerateOutcome['skipped'] = []

  for (const candidate of selection.selected) {
    const resume = resumesByTrack.get(candidate.trackKey)
    if (!resume) {
      // No resume for the track means no honest packet: F3's whole promise is a
      // track-tailored resume, and attaching the wrong one is worse than none.
      skipped.push({
        opportunityId: candidate.opportunityId,
        companyName: candidate.companyName,
        reason: `no active ResumeVersion is the default for track ${candidate.trackKey}`,
      })
      continue
    }

    const existing = await db.applicationPacket.findUnique({
      where: {
        opportunityId_resumeVersionId: {
          opportunityId: candidate.opportunityId,
          resumeVersionId: resume.id,
        },
      },
      select: { id: true, status: true, acceptedAt: true },
    })
    if (existing && existing.acceptedAt !== null) {
      skipped.push({
        opportunityId: candidate.opportunityId,
        companyName: candidate.companyName,
        reason: 'packet already accepted; the approved artefact is immutable',
      })
      continue
    }

    const built = buildDeterministicAnswers(claims, candidate.companyName)
    const answers: PrefilledAnswers = {
      answers: built.answers,
      unanswered: [
        ...built.unanswered,
        ...JUDGMENT_QUESTIONS.map((q) => ({
          questionKey: q.key,
          question: renderPrompt(q, candidate.companyName),
          reason: q.note ?? 'needs judgment; queued for a Claude Code session',
        })),
      ],
      generatedAt: now.toISOString(),
      promptVersion: null,
    }

    const validated = await validateAnswers(db, answers)
    if (!validated.ok) {
      // A packet whose own generated answers fail validation is a bug, not an
      // outcome. Recording it rather than throwing keeps one bad company from
      // aborting a run over the other sixteen.
      skipped.push({
        opportunityId: candidate.opportunityId,
        companyName: candidate.companyName,
        reason: `answers failed validation (${validated.problem}): ${validated.detail}`,
      })
      continue
    }

    const claimIds = citedClaimIds(validated.value)
    const evidenceIds = citedEvidenceIdsOf(validated.value)
    const hash = computePacketHash({
      companyId: candidate.companyId,
      opportunityId: candidate.opportunityId,
      officialUrl: candidate.roleUrl,
      resumeVersionId: resume.id,
      resumeSha256: resume.fileSha256,
      prefilledAnswers: validated.value,
      citedEvidenceIds: evidenceIds,
      approvedClaimIds: claimIds,
    })

    const data = {
      companyId: candidate.companyId,
      opportunityId: candidate.opportunityId,
      leadId: candidate.leadId,
      resumeVersionId: resume.id,
      // H8: the route the OPERATOR submits through. F2 asserts by test that
      // Opportunity.roleUrl survives scoring untouched, which is what makes this the
      // employer's own published URL rather than something this system composed.
      officialUrl: candidate.roleUrl,
      prefilledAnswers: validated.value as unknown as Prisma.InputJsonValue,
      citedEvidenceIds: evidenceIds,
      approvedClaimIds: claimIds,
      // Computed on every regeneration but only FROZEN at accept. Until then it is a
      // fingerprint of the current draft, not a record of an approval.
      packetHash: hash,
    }

    const row = existing
      ? await db.applicationPacket.update({ where: { id: existing.id }, data, select: { id: true } })
      : await db.applicationPacket.create({ data, select: { id: true } })

    await writeAudit(db, {
      actorType: 'system',
      actorId: 'packet-generator',
      action: existing ? 'packet.regenerated' : 'packet.prepared',
      subjectType: 'ApplicationPacket',
      subjectId: row.id,
      metadata: {
        companyId: candidate.companyId,
        opportunityId: candidate.opportunityId,
        leadId: candidate.leadId,
        track: candidate.trackKey,
        resumeVersionId: resume.id,
        officialUrl: candidate.roleUrl,
        answers: validated.value.answers.length,
        unanswered: validated.value.unanswered.length,
        packetHash: hash,
      },
    })

    packets.push({
      packetId: row.id,
      opportunityId: candidate.opportunityId,
      companyName: candidate.companyName,
      trackKey: candidate.trackKey,
      resumeLabel: resume.label,
      officialUrl: candidate.roleUrl,
      answers: validated.value.answers.length,
      unanswered: validated.value.unanswered.length,
      created: existing === null,
    })

    if (opts.queueJudgmentTasks) {
      const { queuePacketAnswers } = await import('./queue-answers.js')
      await queuePacketAnswers(db, row.id)
    }
  }

  return {
    packets,
    skipped,
    cappedOut: selection.cappedOut.length,
    companies: selection.companies,
    cap,
  }
}

export type TrackResume = { id: string; label: string; fileSha256: string | null }

/**
 * The track-tailored resume per track, read from `RoleTrack.defaultResumeVersionId` —
 * the seam F2's seeder left null because it is operator data (F3 §8.1.2).
 */
export async function loadTrackResumes(db: Db): Promise<Map<string, TrackResume>> {
  const tracks = await db.roleTrack.findMany({
    select: {
      key: true,
      defaultResumeVersion: { select: { id: true, label: true, fileSha256: true, isActive: true } },
    },
  })
  const out = new Map<string, TrackResume>()
  for (const track of tracks) {
    const resume = track.defaultResumeVersion
    if (!resume || !resume.isActive) continue
    out.set(track.key, { id: resume.id, label: resume.label, fileSha256: resume.fileSha256 })
  }
  return out
}

export type { PacketCandidate }
