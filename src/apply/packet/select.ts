import type { Db } from '../../core/audit/audit-log.js'
import { writeAudit } from '../../core/audit/audit-log.js'

/**
 * Which postings become packets.
 *
 * ## The per-company cap, and why there is one
 *
 * The qualified corpus concentrates hard: of 73 packet-eligible postings across 17
 * companies, one company holds 13 and the top six hold 53. Generating a packet per
 * eligible posting would hand the operator a review queue that is a third Deepgram,
 * and `handover.md` §15 sizes the daily review at ten leads — a queue dominated by
 * one employer wastes most of that budget re-reading the same company.
 *
 * The cap is **3 per company**, which yields 37 packets from the current corpus:
 * clear of Part F's 30 with enough headroom to survive a few drops, and flat enough
 * that no employer exceeds ~8% of the review set. It is a *selection* rule, not a
 * filter on eligibility — every posting over the cap is recorded in an audit row and
 * stays eligible, so an operator who wants Deepgram's other ten can raise the cap and
 * re-run without re-researching anything.
 *
 * ## Ranking inside a company
 *
 * In order, because each key answers a question the one below it cannot:
 *
 *  1. **Does the title read as an internship or early-career role?** This system
 *     exists to find internships (`handover.md` §1). A posting that says "Intern"
 *     outranks one that does not, whatever else is true of it.
 *  2. **Is the title beyond an intern's reach?** Senior/Staff/Lead/Manager postings
 *     rank last. Measured, not assumed — see `looksSenior`.
 *  3. **Does the posting's own track match the lead's primary track?** The lead's
 *     primary track is the one the company's evidence supports best, so a posting on
 *     it is the one the operator's strongest resume fits.
 *  4. **Freshness**, newest `postedAt` first, nulls last. A8's concern in miniature:
 *     a stale req is a worse application than a fresh one.
 *  5. **Id**, so the selection is deterministic and re-running produces the same
 *     three packets rather than a reshuffle.
 *
 * Note what is *not* a ranking key: the score. Every posting in a company shares its
 * company's score, so it cannot order anything within one.
 */

export const PACKETS_PER_COMPANY_CAP = 3

/** Title shapes that mark a posting as early-career. Deliberately narrow. */
const EARLY_CAREER_PATTERNS = [
  /\bintern(ship)?\b/i,
  /\bnew ?grad(uate)?\b/i,
  /\buniversity\b/i,
  /\bearly[ -]career\b/i,
  /\bapprentice(ship)?\b/i,
  /\bco[ -]?op\b/i,
  /\bstudent\b/i,
]

export function looksEarlyCareer(title: string | null): boolean {
  if (!title) return false
  return EARLY_CAREER_PATTERNS.some((p) => p.test(title))
}

/**
 * Title shapes that mark a posting as beyond an intern's reach.
 *
 * Measured, not assumed: the first generation run produced 37 packets of which **20
 * were titled Senior, Staff, Lead or Manager**. Every one was a valid packet — real
 * application URL, real provenance — and almost none was an application a
 * second-year undergraduate could sensibly make. A queue that is mostly unreachable
 * roles wastes the ten-minute review `handover.md` §15 budgets.
 *
 * This is deliberately a **selection** rule and not a score change. A11 freezes the
 * weights and thresholds during the pilot, and seniority is not evidence about the
 * company — it is a property of one posting, which is exactly the kind of thing
 * ranking inside a company is for.
 *
 * Excluding these outright was rejected: a "Senior Software Engineer" at a strong
 * company is still worth the operator seeing when nothing better exists there, and
 * dropping them would take the corpus below Part F's 30. They rank last instead, and
 * `seniorityMismatch` travels with the candidate so the UI can label it.
 */
const SENIOR_PATTERNS = [
  /\bsenior\b/i,
  /\bstaff\b/i,
  /\bprincipal\b/i,
  /\bdistinguished\b/i,
  /\bfellow\b/i,
  /\blead\b/i,
  /\bmanager\b/i,
  /\bdirector\b/i,
  /\bhead of\b/i,
  /\bvp\b/i,
  /\bIII\b/,
  /\bIV\b/,
]

export function looksSenior(title: string | null): boolean {
  if (!title) return false
  // An early-career posting is never senior, whatever else the title says — e.g.
  // "Senior Thesis Intern" or a "New Grad" req that mentions a lead engineer.
  if (looksEarlyCareer(title)) return false
  return SENIOR_PATTERNS.some((p) => p.test(title))
}

export type PacketCandidate = {
  opportunityId: string
  companyId: string
  companyName: string
  leadId: string
  leadScore: number | null
  primaryTrack: string
  trackKey: string
  title: string | null
  roleUrl: string
  postedAt: Date | null
  earlyCareer: boolean
  /** True when the title reads Senior/Staff/Lead/Manager. Ranked last, and shown. */
  seniorityMismatch: boolean
}

export type SelectionOutcome = {
  selected: PacketCandidate[]
  /** Eligible postings the cap left out. Recorded, never discarded. */
  cappedOut: PacketCandidate[]
  companies: number
}

/**
 * Eligible postings, ranked and capped.
 *
 * Eligibility is deliberately strict and every clause earns its place:
 *
 *  - the lead is `qualified` or already `accepted` — regenerating packets for a lead
 *    the operator accepted must not drop them;
 *  - the posting has a `roleTrackId`, because without one there is no basis for
 *    choosing a resume, and F2 §4.14 set it from the posting's own title rather than
 *    inheriting the company's;
 *  - the posting has a `roleUrl`, because that URL *is* the application route (H8:
 *    the operator submits through it, by hand);
 *  - the posting is not closed.
 */
export async function selectPacketCandidates(
  db: Db,
  opts: { cap?: number; campaignCycle?: string } = {},
): Promise<SelectionOutcome> {
  const cap = opts.cap ?? PACKETS_PER_COMPANY_CAP

  const leads = await db.lead.findMany({
    where: {
      status: { in: ['qualified', 'accepted'] },
      ...(opts.campaignCycle ? { campaignCycle: opts.campaignCycle } : {}),
    },
    select: {
      id: true,
      companyId: true,
      score: true,
      primaryTrack: true,
      company: { select: { id: true, displayName: true } },
    },
  })
  if (leads.length === 0) return { selected: [], cappedOut: [], companies: 0 }

  const leadByCompany = new Map(leads.map((l) => [l.companyId, l]))

  const opportunities = await db.opportunity.findMany({
    where: {
      companyId: { in: [...leadByCompany.keys()] },
      roleTrackId: { not: null },
      roleUrl: { not: null },
      status: { not: 'closed' },
    },
    select: {
      id: true,
      companyId: true,
      title: true,
      roleUrl: true,
      postedAt: true,
      roleTrack: { select: { key: true } },
    },
  })

  const byCompany = new Map<string, PacketCandidate[]>()
  for (const opp of opportunities) {
    const lead = leadByCompany.get(opp.companyId)
    if (!lead || !opp.roleUrl || !opp.roleTrack) continue
    const candidate: PacketCandidate = {
      opportunityId: opp.id,
      companyId: opp.companyId,
      companyName: lead.company.displayName,
      leadId: lead.id,
      leadScore: lead.score,
      primaryTrack: lead.primaryTrack,
      trackKey: opp.roleTrack.key,
      title: opp.title,
      roleUrl: opp.roleUrl,
      postedAt: opp.postedAt,
      earlyCareer: looksEarlyCareer(opp.title),
      seniorityMismatch: looksSenior(opp.title),
    }
    const list = byCompany.get(opp.companyId) ?? []
    list.push(candidate)
    byCompany.set(opp.companyId, list)
  }

  const selected: PacketCandidate[] = []
  const cappedOut: PacketCandidate[] = []
  for (const list of byCompany.values()) {
    list.sort(rankCandidates)
    selected.push(...list.slice(0, cap))
    cappedOut.push(...list.slice(cap))
  }

  return { selected, cappedOut, companies: byCompany.size }
}

export function rankCandidates(a: PacketCandidate, b: PacketCandidate): number {
  if (a.earlyCareer !== b.earlyCareer) return a.earlyCareer ? -1 : 1

  // Ahead of the track match on purpose. For an intern, a "Software Engineer" one
  // track over is a better application than a "Senior Backend Engineer" dead on
  // track — the second is not an application they can make.
  if (a.seniorityMismatch !== b.seniorityMismatch) return a.seniorityMismatch ? 1 : -1

  const aOnTrack = a.trackKey === a.primaryTrack
  const bOnTrack = b.trackKey === b.primaryTrack
  if (aOnTrack !== bOnTrack) return aOnTrack ? -1 : 1

  const aTime = a.postedAt?.getTime() ?? null
  const bTime = b.postedAt?.getTime() ?? null
  if (aTime !== bTime) {
    if (aTime === null) return 1
    if (bTime === null) return -1
    return bTime - aTime
  }

  return a.opportunityId < b.opportunityId ? -1 : a.opportunityId > b.opportunityId ? 1 : 0
}

/**
 * Records what the cap left out, so "why only three Deepgram packets" is answerable
 * from the audit log rather than by re-reading this file.
 */
export async function auditCappedCandidates(db: Db, cappedOut: PacketCandidate[], cap: number): Promise<void> {
  const byCompany = new Map<string, PacketCandidate[]>()
  for (const c of cappedOut) {
    const list = byCompany.get(c.companyId) ?? []
    list.push(c)
    byCompany.set(c.companyId, list)
  }
  for (const [companyId, list] of byCompany) {
    await writeAudit(db, {
      actorType: 'system',
      actorId: 'packet-selector',
      action: 'packet.capped',
      subjectType: 'Company',
      subjectId: companyId,
      metadata: {
        cap,
        withheld: list.length,
        company: list[0]?.companyName,
        opportunityIds: list.map((c) => c.opportunityId),
      },
    })
  }
}
