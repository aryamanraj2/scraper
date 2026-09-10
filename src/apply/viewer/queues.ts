import type { Db } from '../../core/audit/audit-log.js'
import { MILESTONE_STAGE, isAtOrAfter, type Milestone } from '../../core/config/stage.js'
import { loadEvidenceViews, projectScore, type EvidenceView, type ScoreView } from './projection.js'
import { PrefilledAnswers, type PrefilledAnswers as PrefilledAnswersType } from '../packet/answers.js'

/**
 * `handover.md` §9's dashboard queues.
 *
 * ## Why a queue can be "unavailable" rather than empty
 *
 * §9 names twelve queues. F3 can populate five of them and its own four; the rest —
 * `Draft ready`, `Awaiting approval`, `Scheduled`, `Sent`, `Reply needs review`,
 * `Bounced`, `Suppressed` — belong to F4 and F5 and have no rows because the code
 * that would create them does not exist yet.
 *
 * Rendering those as `0` would be a lie of exactly the kind B3 warns about: *"Do not
 * build a reputation chart that renders empty and implies health."* A zero next to
 * "Bounced" reads as "nothing has bounced". The honest rendering is "not built yet",
 * so each queue carries the milestone that fills it and an `available` flag the UI
 * must respect.
 */

export type QueueKey =
  | 'new_seeds'
  | 'researching'
  | 'needs_evidence'
  | 'qualified'
  | 'packets_prepared'
  | 'accepted'
  | 'submitted'
  | 'deferred'
  | 'rejected'
  | 'draft_ready'
  | 'awaiting_approval'
  | 'scheduled'
  | 'sent'
  | 'reply_needs_review'
  | 'bounced'
  | 'suppressed'

export type QueueDescriptor = {
  key: QueueKey
  label: string
  /** The milestone whose code populates this queue. */
  milestone: Milestone
  description: string
}

export const QUEUES: QueueDescriptor[] = [
  { key: 'new_seeds', label: 'New seeds', milestone: 'F1', description: 'Ingested, not yet researched.' },
  { key: 'researching', label: 'Researching', milestone: 'F2', description: 'Signal graph is still gathering sources.' },
  { key: 'needs_evidence', label: 'Needs evidence', milestone: 'F2', description: 'Public text describes a product, never an engineering stack. Re-entrant, not a verdict.' },
  { key: 'qualified', label: 'Qualified', milestone: 'F2', description: 'Cleared the queue threshold; awaiting review.' },
  { key: 'packets_prepared', label: 'Packets ready', milestone: 'F3', description: 'Application packets prepared for review.' },
  { key: 'accepted', label: 'Accepted', milestone: 'F3', description: 'Approved by the operator; apply through the official URL.' },
  { key: 'submitted', label: 'Applied', milestone: 'F3', description: 'The operator submitted this application by hand.' },
  { key: 'deferred', label: 'Deferred', milestone: 'F3', description: 'Not now; still eligible for more research.' },
  { key: 'rejected', label: 'Rejected', milestone: 'F2', description: 'Below threshold, or rejected in review.' },
  { key: 'draft_ready', label: 'Draft ready', milestone: 'F4', description: 'Composed outreach awaiting the quality gate.' },
  { key: 'awaiting_approval', label: 'Awaiting approval', milestone: 'F4', description: 'Drafts awaiting per-message human approval.' },
  { key: 'scheduled', label: 'Scheduled', milestone: 'F5', description: 'Approved and queued for send.' },
  { key: 'sent', label: 'Sent', milestone: 'F5', description: 'Transmitted to an owned inbox or a real recipient.' },
  { key: 'reply_needs_review', label: 'Reply needs review', milestone: 'F5', description: 'A reply arrived and is unclassified.' },
  { key: 'bounced', label: 'Bounced', milestone: 'F5', description: 'Hard or soft delivery failure.' },
  { key: 'suppressed', label: 'Suppressed', milestone: 'F5', description: 'Permanent do-not-contact.' },
]

export type QueueCount = QueueDescriptor & {
  /** False when the milestone that populates this queue has not shipped. */
  available: boolean
  /** Null when unavailable — never 0, which would read as "none have happened". */
  count: number | null
}

export async function queueCounts(db: Db, stage: Milestone = MILESTONE_STAGE): Promise<QueueCount[]> {
  const [companies, leads, packets] = await Promise.all([
    db.company.groupBy({ by: ['status'], _count: { _all: true } }),
    db.lead.groupBy({ by: ['status'], _count: { _all: true } }),
    db.applicationPacket.groupBy({ by: ['status'], _count: { _all: true } }),
  ])
  const companyBy = new Map(companies.map((r) => [r.status, r._count._all]))
  const leadBy = new Map(leads.map((r) => [r.status, r._count._all]))
  const packetBy = new Map(packets.map((r) => [r.status, r._count._all]))

  const counts: Record<QueueKey, number> = {
    new_seeds: (companyBy.get('discovered') ?? 0) + (companyBy.get('normalized') ?? 0),
    researching: companyBy.get('researching') ?? 0,
    needs_evidence: companyBy.get('insufficient_evidence') ?? 0,
    qualified: leadBy.get('qualified') ?? 0,
    packets_prepared: packetBy.get('prepared') ?? 0,
    accepted: leadBy.get('accepted') ?? 0,
    submitted: packetBy.get('submitted') ?? 0,
    deferred: leadBy.get('deferred') ?? 0,
    rejected: leadBy.get('rejected') ?? 0,
    draft_ready: 0,
    awaiting_approval: 0,
    scheduled: 0,
    sent: 0,
    reply_needs_review: 0,
    bounced: 0,
    suppressed: 0,
  }

  return QUEUES.map((q) => {
    const available = isAtOrAfter(stage, q.milestone)
    return { ...q, available, count: available ? counts[q.key] : null }
  })
}

// ---------------------------------------------------------------------------
// Packet rows — what §9 requires every queue row to expose
// ---------------------------------------------------------------------------

/**
 * §9: *"Every queue row must expose score breakdown, all citations, why this contact
 * was selected, role track, chosen resume, history, and a one-click pause/reject
 * option."*
 *
 * Six of the seven are here. "Why this contact was selected" is structurally absent at
 * F3 and says so: no `Contact` row exists in this system yet, and F4 is the first
 * milestone permitted to create one (`handover.md` §1.2). The field is present and
 * null rather than omitted, so the UI shows the reviewer that a contact was not chosen
 * — rather than a layout with a missing panel they have to notice.
 */
export type PacketRow = {
  packetId: string
  status: string
  companyId: string
  companyName: string
  companyDomain: string
  countries: string[]
  opportunityId: string | null
  roleTitle: string | null
  roleLocation: string | null
  officialUrl: string
  trackKey: string | null
  resumeLabel: string
  resumeLinkUrl: string
  resumeFilePath: string | null
  resumeSha256: string | null
  leadId: string | null
  leadStatus: string | null
  leadStatusReason: string | null
  score: ScoreView
  answers: PrefilledAnswersType
  evidence: EvidenceView[]
  claims: { id: string; key: string; category: string; text: string; sourceRef: string | null }[]
  brief: { id: string; relevanceNote: string; facts: unknown; citedEvidenceIds: string[] } | null
  /** Null at F3 by design: no Contact exists before F4. */
  contactRoute: null
  packetHash: string | null
  acceptedAt: string | null
  submittedAt: string | null
  history: { at: string; actor: string; action: string; reasonCode: string | null }[]
}

export async function loadPacketRow(db: Db, packetId: string): Promise<PacketRow | null> {
  const packet = await db.applicationPacket.findUnique({
    where: { id: packetId },
    select: {
      id: true,
      status: true,
      officialUrl: true,
      prefilledAnswers: true,
      citedEvidenceIds: true,
      approvedClaimIds: true,
      packetHash: true,
      acceptedAt: true,
      submittedAt: true,
      companyId: true,
      opportunityId: true,
      company: { select: { displayName: true, canonicalDomain: true, countries: true } },
      opportunity: { select: { title: true, location: true, roleTrack: { select: { key: true } } } },
      resumeVersion: { select: { label: true, linkUrl: true, filePath: true, fileSha256: true } },
      lead: { select: { id: true, status: true, statusReason: true, scoreComponents: true } },
    },
  })
  if (!packet) return null

  const [evidence, claims, brief, history] = await Promise.all([
    loadEvidenceViews(db, packet.citedEvidenceIds),
    packet.approvedClaimIds.length > 0
      ? db.approvedClaim.findMany({
          where: { id: { in: packet.approvedClaimIds } },
          select: { id: true, key: true, category: true, text: true, sourceRef: true },
          orderBy: { key: 'asc' },
        })
      : Promise.resolve([]),
    db.researchBrief.findFirst({
      where: { companyId: packet.companyId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, relevanceNote: true, facts: true, citedEvidenceIds: true },
    }),
    db.auditLog.findMany({
      where: { subjectType: 'ApplicationPacket', subjectId: packetId },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true, actorId: true, action: true, reasonCode: true },
    }),
  ])

  return {
    packetId: packet.id,
    status: packet.status,
    companyId: packet.companyId,
    companyName: packet.company.displayName,
    companyDomain: packet.company.canonicalDomain,
    countries: packet.company.countries,
    opportunityId: packet.opportunityId,
    roleTitle: packet.opportunity?.title ?? null,
    roleLocation: packet.opportunity?.location ?? null,
    officialUrl: packet.officialUrl,
    trackKey: packet.opportunity?.roleTrack?.key ?? null,
    resumeLabel: packet.resumeVersion.label,
    resumeLinkUrl: packet.resumeVersion.linkUrl,
    resumeFilePath: packet.resumeVersion.filePath,
    resumeSha256: packet.resumeVersion.fileSha256,
    leadId: packet.lead?.id ?? null,
    leadStatus: packet.lead?.status ?? null,
    leadStatusReason: packet.lead?.statusReason ?? null,
    score: projectScore(packet.lead?.scoreComponents),
    answers: PrefilledAnswers.parse(packet.prefilledAnswers),
    evidence,
    claims,
    brief,
    contactRoute: null,
    packetHash: packet.packetHash,
    acceptedAt: packet.acceptedAt?.toISOString() ?? null,
    submittedAt: packet.submittedAt?.toISOString() ?? null,
    history: history.map((h) => ({
      at: h.createdAt.toISOString(),
      actor: h.actorId,
      action: h.action,
      reasonCode: h.reasonCode,
    })),
  }
}

export type PacketSummary = {
  packetId: string
  status: string
  companyName: string
  countries: string[]
  roleTitle: string | null
  trackKey: string | null
  resumeLabel: string
  score: number | null
  leadStatus: string | null
  unanswered: number
  officialUrl: string
}

/** The review list. Ordered by score desc so the ten-minute review starts at the top. */
export async function listPackets(
  db: Db,
  opts: { status?: string; leadStatus?: string } = {},
): Promise<PacketSummary[]> {
  const rows = await db.applicationPacket.findMany({
    where: {
      ...(opts.status ? { status: opts.status as never } : {}),
      ...(opts.leadStatus ? { lead: { status: opts.leadStatus as never } } : {}),
    },
    select: {
      id: true,
      status: true,
      officialUrl: true,
      prefilledAnswers: true,
      company: { select: { displayName: true, countries: true } },
      opportunity: { select: { title: true, roleTrack: { select: { key: true } } } },
      resumeVersion: { select: { label: true } },
      lead: { select: { score: true, status: true } },
    },
  })

  return rows
    .map((r) => {
      const answers = PrefilledAnswers.safeParse(r.prefilledAnswers)
      return {
        packetId: r.id,
        status: r.status,
        companyName: r.company.displayName,
        countries: r.company.countries,
        roleTitle: r.opportunity?.title ?? null,
        trackKey: r.opportunity?.roleTrack?.key ?? null,
        resumeLabel: r.resumeVersion.label,
        score: r.lead?.score ?? null,
        leadStatus: r.lead?.status ?? null,
        unanswered: answers.success ? answers.data.unanswered.length : 0,
        officialUrl: r.officialUrl,
      }
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.companyName.localeCompare(b.companyName))
}
