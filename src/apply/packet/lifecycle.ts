import type { Prisma } from '../../../generated/prisma/client.js'
import type { Db } from '../../core/audit/audit-log.js'
import { writeAudit } from '../../core/audit/audit-log.js'
import { MILESTONE_STAGE } from '../../core/config/stage.js'
import { reachableReasonCodes, type ReasonCodeValue } from '../../core/reason-codes/registry.js'
import { PrefilledAnswers } from './answers.js'
import { computePacketHash } from './hash.js'

/**
 * Review outcomes, and the one reason code F3 owns.
 *
 * ## The shape of the decision
 *
 * The scorer decides whether a lead is *qualified*. The human decides whether to
 * *act on it*. Those are different facts and they live in different places: the
 * scorer writes `qualified`, review writes `accepted` / `deferred` / `rejected`.
 * Collapsing them would make "the weights liked this company" and "I chose to apply
 * here" the same row, and F4's outreach predicate has to tell them apart.
 *
 * `deferred` carries `insufficient_evidence` deliberately. D1 defines that code as
 * re-entrant and a budget decision rather than a verdict, which is exactly what
 * deferring means: not now, still eligible, come back with more research.
 *
 * ## `application_submitted` is a state transition, not a UI flag
 *
 * F3 owns exactly one reason code and it is the one that **stops outreach for an
 * opportunity**. Part C permits a cold message in three cases, and case 3 — a
 * targeted follow-up — is permitted only *after* an application exists. F4's predicate
 * reads this state to decide that. So marking a packet submitted writes three things
 * together: the packet's own status, the reason code onto the lead, and an audit row.
 * A flag that lived only in the UI would leave F4 with a hole where its precondition
 * should be.
 *
 * ## What is deliberately absent
 *
 * **Nothing here submits anything.** H8 is marked irreversible in Part H: the system
 * prepares, the operator submits. `markPacketSubmitted` records that a human already
 * applied through the employer's own site. It issues no request, and there is no code
 * path in this system that posts to an ATS.
 */

export type ReviewOutcome =
  | { ok: true; leadId: string; packetId: string }
  | { ok: false; problem: 'unknown_packet' | 'no_lead' | 'not_accepted' | 'already_submitted' | 'bad_reason'; detail: string }

function assertReachable(code: ReasonCodeValue): boolean {
  return reachableReasonCodes(MILESTONE_STAGE).includes(code)
}

/**
 * Accept: the operator will apply through this packet.
 *
 * Freezes `packetHash` over the artefact as it stands and stamps `acceptedAt`. From
 * here the packet is immutable — `generateApplicationPackets` skips it, so a later
 * regeneration cannot rewrite the answers a human approved. That immutability is what
 * the F3 handover asks for so F4 can compute A7's `approval_hash` over an equivalent
 * structure without redesigning this table.
 */
export async function acceptPacket(
  db: Db,
  packetId: string,
  opts: { actorId?: string; now?: Date } = {},
): Promise<ReviewOutcome> {
  const now = opts.now ?? new Date()
  const packet = await db.applicationPacket.findUnique({
    where: { id: packetId },
    select: {
      id: true,
      companyId: true,
      opportunityId: true,
      leadId: true,
      officialUrl: true,
      resumeVersionId: true,
      prefilledAnswers: true,
      citedEvidenceIds: true,
      approvedClaimIds: true,
      acceptedAt: true,
      resumeVersion: { select: { fileSha256: true } },
    },
  })
  if (!packet) return { ok: false, problem: 'unknown_packet', detail: `no packet ${packetId}` }
  if (!packet.leadId) return { ok: false, problem: 'no_lead', detail: 'packet has no lead to advance' }

  // Re-hash from the stored row rather than trusting the value generation left
  // behind: the hash must describe the artefact as it is at the moment of approval.
  const answers = PrefilledAnswers.parse(packet.prefilledAnswers)
  const hash = computePacketHash({
    companyId: packet.companyId,
    opportunityId: packet.opportunityId,
    officialUrl: packet.officialUrl,
    resumeVersionId: packet.resumeVersionId,
    resumeSha256: packet.resumeVersion.fileSha256,
    prefilledAnswers: answers,
    citedEvidenceIds: packet.citedEvidenceIds,
    approvedClaimIds: packet.approvedClaimIds,
  })

  await db.applicationPacket.update({
    where: { id: packetId },
    data: { acceptedAt: packet.acceptedAt ?? now, packetHash: hash },
  })
  await db.lead.update({
    where: { id: packet.leadId },
    data: { status: 'accepted', statusReason: null },
  })

  await writeAudit(db, {
    actorType: 'user',
    actorId: opts.actorId ?? 'operator',
    action: 'packet.accepted',
    subjectType: 'ApplicationPacket',
    subjectId: packetId,
    metadata: { leadId: packet.leadId, companyId: packet.companyId, packetHash: hash, officialUrl: packet.officialUrl },
  })

  return { ok: true, leadId: packet.leadId, packetId }
}

/** Defer: not now, still eligible. `insufficient_evidence` is re-entrant by D1. */
export async function deferLead(
  db: Db,
  packetId: string,
  opts: { actorId?: string; reason?: ReasonCodeValue; note?: string } = {},
): Promise<ReviewOutcome> {
  const reason = opts.reason ?? ('insufficient_evidence' as ReasonCodeValue)
  if (!assertReachable(reason)) {
    return { ok: false, problem: 'bad_reason', detail: `${reason} is not reachable at stage ${MILESTONE_STAGE}` }
  }
  return transitionLead(db, packetId, 'deferred', reason, 'packet.deferred', opts)
}

/** Reject: do not apply here. Defaults to `low_relevance`, the scorer's own band code. */
export async function rejectLead(
  db: Db,
  packetId: string,
  opts: { actorId?: string; reason?: ReasonCodeValue; note?: string } = {},
): Promise<ReviewOutcome> {
  const reason = opts.reason ?? ('low_relevance' as ReasonCodeValue)
  if (!assertReachable(reason)) {
    return { ok: false, problem: 'bad_reason', detail: `${reason} is not reachable at stage ${MILESTONE_STAGE}` }
  }
  return transitionLead(db, packetId, 'rejected', reason, 'packet.rejected', opts)
}

async function transitionLead(
  db: Db,
  packetId: string,
  status: 'deferred' | 'rejected',
  reason: ReasonCodeValue,
  action: string,
  opts: { actorId?: string; note?: string },
): Promise<ReviewOutcome> {
  const packet = await db.applicationPacket.findUnique({
    where: { id: packetId },
    select: { id: true, leadId: true, companyId: true },
  })
  if (!packet) return { ok: false, problem: 'unknown_packet', detail: `no packet ${packetId}` }
  if (!packet.leadId) return { ok: false, problem: 'no_lead', detail: 'packet has no lead to advance' }

  await db.lead.update({ where: { id: packet.leadId }, data: { status, statusReason: reason } })
  await writeAudit(db, {
    actorType: 'user',
    actorId: opts.actorId ?? 'operator',
    action,
    subjectType: 'ApplicationPacket',
    subjectId: packetId,
    reasonCode: reason,
    metadata: {
      leadId: packet.leadId,
      companyId: packet.companyId,
      ...(opts.note === undefined ? {} : { note: opts.note }),
    },
  })
  return { ok: true, leadId: packet.leadId, packetId }
}

/**
 * Records that the operator submitted this application, by hand, through the
 * employer's own site.
 *
 * **This does not submit anything** (H8). It is the moment `application_submitted`
 * enters the record, and it is the precondition F4's Part C case 3 reads.
 *
 * Requires the packet to have been accepted first, so the thing recorded as submitted
 * is the artefact a human approved — `packetHash` is a claim about what they saw, and
 * a submission with no approval behind it would make that claim vacuous.
 */
export async function markPacketSubmitted(
  db: Db,
  packetId: string,
  opts: { actorId?: string; now?: Date; outcomeNote?: string } = {},
): Promise<ReviewOutcome> {
  const now = opts.now ?? new Date()
  const packet = await db.applicationPacket.findUnique({
    where: { id: packetId },
    select: {
      id: true,
      leadId: true,
      companyId: true,
      opportunityId: true,
      officialUrl: true,
      status: true,
      acceptedAt: true,
      packetHash: true,
    },
  })
  if (!packet) return { ok: false, problem: 'unknown_packet', detail: `no packet ${packetId}` }
  if (!packet.leadId) return { ok: false, problem: 'no_lead', detail: 'packet has no lead to advance' }
  if (packet.acceptedAt === null) {
    return {
      ok: false,
      problem: 'not_accepted',
      detail: 'accept the packet first; a submission records what a human approved',
    }
  }
  if (packet.status === 'submitted') {
    return { ok: false, problem: 'already_submitted', detail: `packet ${packetId} is already submitted` }
  }

  await db.applicationPacket.update({
    where: { id: packetId },
    data: {
      status: 'submitted',
      submittedAt: now,
      ...(opts.outcomeNote === undefined ? {} : { outcomeNote: opts.outcomeNote }),
    },
  })

  // The reason code lands on the LEAD, because that is where F4's outreach predicate
  // looks. The lead stays `accepted`: applying is not a rejection, and the follow-up
  // Part C case 3 permits is only available while the lead is live.
  await db.lead.update({
    where: { id: packet.leadId },
    data: { status: 'accepted', statusReason: 'application_submitted' },
  })

  await writeAudit(db, {
    actorType: 'user',
    actorId: opts.actorId ?? 'operator',
    action: 'packet.submitted',
    subjectType: 'ApplicationPacket',
    subjectId: packetId,
    reasonCode: 'application_submitted',
    metadata: {
      leadId: packet.leadId,
      companyId: packet.companyId,
      opportunityId: packet.opportunityId,
      officialUrl: packet.officialUrl,
      packetHash: packet.packetHash,
      // Stated in the record, not only in a comment: this system never submits.
      submittedBy: 'human, through the employer’s own application form',
    },
  })

  return { ok: true, leadId: packet.leadId, packetId }
}

/** Records an outcome the operator heard back (acknowledged / interview / rejected / no response). */
export async function recordPacketOutcome(
  db: Db,
  packetId: string,
  outcome: 'acknowledged' | 'interview' | 'rejected' | 'no_response',
  opts: { actorId?: string; note?: string } = {},
): Promise<ReviewOutcome> {
  const packet = await db.applicationPacket.findUnique({
    where: { id: packetId },
    select: { id: true, leadId: true, companyId: true, status: true },
  })
  if (!packet) return { ok: false, problem: 'unknown_packet', detail: `no packet ${packetId}` }
  await db.applicationPacket.update({
    where: { id: packetId },
    data: { status: outcome, ...(opts.note === undefined ? {} : { outcomeNote: opts.note }) },
  })
  await writeAudit(db, {
    actorType: 'user',
    actorId: opts.actorId ?? 'operator',
    action: 'packet.outcome',
    subjectType: 'ApplicationPacket',
    subjectId: packetId,
    metadata: {
      outcome,
      companyId: packet.companyId,
      ...(packet.leadId === null ? {} : { leadId: packet.leadId }),
      ...(opts.note === undefined ? {} : { note: opts.note }),
    },
  })
  return { ok: true, leadId: packet.leadId ?? '', packetId }
}

export type { Prisma }
