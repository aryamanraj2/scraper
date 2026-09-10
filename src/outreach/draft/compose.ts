import type { OutreachCase } from '../../../generated/prisma/enums.js'
import type { Db } from '../../core/audit/audit-log.js'
import { writeAudit } from '../../core/audit/audit-log.js'
import { decideOutreachCase, type OutreachFacts } from '../../core/policy/outreach-case.js'
import type { ReasonCodeValue } from '../../core/reason-codes/registry.js'
import { SCORE_VERSION_V1 } from '../../intel/scoring/score-version.js'
import { loadTrackResumes } from '../../apply/packet/generate.js'
import { checkJurisdiction } from './jurisdiction.js'
import {
  compositionClaimIds,
  compositionEvidenceIds,
  renderBody,
  validateComposition,
  type DraftComposition,
  type DraftSentence,
} from './message.js'
import { selectContactSlots } from './slots.js'
import { renderTemplate, TEMPLATE_IDS, type TemplateVars } from './templates.js'
import { GATE_VERSION, runQualityGate } from './quality-gate.js'
import { partitionEvidenceByScope } from './evidence-scope.js'

/**
 * The composer — F4's payload, and the milestone where three mechanisms that have
 * been sitting unreachable since F0 finally run against real rows.
 *
 * ## What is finally reachable here
 *
 * `decideOutreachCase` was written and fully unit-tested in **F0** and has never been
 * called from a pipeline path, because nothing created a draft. Part G calls the test
 * it enables — *"posted-role lead with no application → `outreach_not_permitted`"* —
 * the single most important policy test in the suite. This function is what makes it
 * a test of the system rather than of a helper.
 *
 * ## H10, which binds here as it did in F3
 *
 * A draft is generated with the LLM backlog untouched. The deterministic sentences —
 * TL;DR, availability, resume link, ask, sign-off — are composed immediately from
 * registered templates and `ApprovedClaim` rows, and the draft sits in `composing`
 * with an `outreach_draft` task queued for the two judgment sentences. Draining
 * upgrades a draft to `quality_gate`; it never unblocks one.
 *
 * The difference from F3 is worth stating: an application packet is *usable* without
 * its judgment answers, because the operator can submit it with two questions blank.
 * A message is not sendable without its evidence-cited sentence — that sentence is
 * the entire stated edge over template spray (§10.1). So a draft with no fulfilled
 * task is complete as a **record** and deliberately cannot pass the Quality Gate.
 * That is H10 degrading honestly rather than H10 not applying.
 */

export type ComposeOutcome = {
  draftsCreated: number
  draftsUpdated: number
  tasksQueued: number
  refusals: { companyId: string; companyName: string; reason: ReasonCodeValue; detail: string }[]
  drafts: { draftId: string; companyName: string; contactEmail: string; outreachCase: OutreachCase; touchSlot: number }[]
}

export type ComposeOptions = {
  now?: Date
  /** Cap on companies processed, for a first look at what the composer produces. */
  limit?: number
  /** The operator's own identity, for the sign-off and A7's `sender_identity`. */
  senderIdentity?: string | null
}

/** The claim keys the deterministic sentences draw on. */
const AVAILABILITY_CLAIM_KEY = 'eligibility.internship_window'
const NAME_CLAIM_KEY = 'identity.full_name'

export async function composeDrafts(db: Db, opts: ComposeOptions = {}): Promise<ComposeOutcome> {
  const now = opts.now ?? new Date()
  const out: ComposeOutcome = {
    draftsCreated: 0,
    draftsUpdated: 0,
    tasksQueued: 0,
    refusals: [],
    drafts: [],
  }

  const leads = await db.lead.findMany({
    where: { status: { in: ['qualified', 'accepted'] } },
    select: {
      id: true,
      status: true,
      statusReason: true,
      leadKind: true,
      score: true,
      primaryTrack: true,
      campaignCycle: true,
      opportunity: { select: { id: true, title: true, roleUrl: true, status: true, roleTrackId: true } },
      company: {
        select: {
          id: true,
          displayName: true,
          canonicalDomain: true,
          countries: true,
          teamSize: true,
          contacts: {
            where: { status: 'active' },
            select: { id: true, contactType: true, verified: true, emailNormalized: true, discoveryMethod: true },
          },
        },
      },
    },
    orderBy: { score: 'desc' },
    ...(opts.limit === undefined ? {} : { take: opts.limit }),
  })

  const resumesByTrack = await loadTrackResumes(db)
  const claims = await db.approvedClaim.findMany({
    where: { isActive: true },
    select: { id: true, key: true, text: true },
  })
  const claimByKey = new Map(claims.map((c) => [c.key, c]))

  for (const lead of leads) {
    const company = lead.company

    // §10.7: one slot, or two for a company big enough that a second route reaches a
    // genuinely different human.
    const slots = selectContactSlots(company.contacts, company.teamSize)

    if (slots.length === 0) {
      // No VERIFIED contact — but the predicate still gets asked, because the two
      // no-draft outcomes here are genuinely different facts and the operator should
      // be able to tell them apart:
      //
      //   no contact at all           -> `no_public_recruiting_route` (§8: keep the
      //                                  company researched, create no email lead)
      //   a contact, but unverified   -> `outreach_not_permitted`, which is Part G's
      //                                  most important policy test and the state a
      //                                  pattern-inferred address is written in
      //
      // Collapsing them would report "no route found" for a company where a route was
      // found and rejected, and would make the second code unreachable by any real path.
      const routeExists = company.contacts.length > 0
      const decision = decideOutreachCase(factsFor(lead, null, routeExists))
      const reason = decision.permitted ? 'no_public_recruiting_route' : decision.reason
      const detail = routeExists
        ? `${company.contacts.length} contact(s), none verified`
        : 'no contact at this company'
      await recordRefusal(db, company.id, reason, detail)
      out.refusals.push({
        companyId: company.id,
        companyName: company.displayName,
        reason,
        detail,
      })
      continue
    }

    for (const slot of slots) {
      const contact = company.contacts.find((c) => c.id === slot.contactId)
      if (!contact) continue

      // The amended path only. Tier A never reaches this (§10.3).
      const jurisdiction = checkJurisdiction({
        discoveryMethod: contact.discoveryMethod,
        countries: company.countries,
      })
      if (!jurisdiction.permitted) {
        await recordRefusal(db, company.id, jurisdiction.reason, jurisdiction.detail)
        out.refusals.push({
          companyId: company.id,
          companyName: company.displayName,
          reason: jurisdiction.reason,
          detail: jurisdiction.detail,
        })
        continue
      }

      // Part C plus the operator's fourth case. Nothing composes before this passes.
      const decision = decideOutreachCase(factsFor(lead, contact, true))
      if (!decision.permitted) {
        await recordRefusal(db, company.id, decision.reason, `contact ${contact.id}, lead ${lead.id}`)
        out.refusals.push({
          companyId: company.id,
          companyName: company.displayName,
          reason: decision.reason,
          detail: `slot ${slot.touchSlot}`,
        })
        continue
      }

      const resume = resumesByTrack.get(lead.primaryTrack)
      if (!resume) {
        // F3's rule: no resume for the track means no honest artefact, and sending the
        // wrong one is worse than sending none.
        await recordRefusal(db, company.id, 'insufficient_evidence', `no active resume for track ${lead.primaryTrack}`)
        continue
      }

      const resumeRow = await db.resumeVersion.findUnique({
        where: { id: resume.id },
        select: { linkUrl: true },
      })

      const vars: TemplateVars = {
        companyName: company.displayName,
        roleTitle: lead.opportunity?.title ?? null,
        resumeUrl: resumeRow?.linkUrl ?? '',
        candidateName: claimByKey.get(NAME_CLAIM_KEY)?.text ?? 'the candidate',
      }

      const composition = deterministicComposition(decision.outreachCase, vars, claimByKey, now)

      const existing = await db.draft.findUnique({
        where: {
          leadId_contactId_touchSlot: {
            leadId: lead.id,
            contactId: contact.id,
            touchSlot: slot.touchSlot,
          },
        },
        select: { id: true, approvedAt: true },
      })

      // An approved draft is frozen, exactly as an accepted packet is (F3 §4.11).
      // `approval_hash` is a claim about what a human read; regenerating underneath it
      // would make that claim false while leaving the hash in place.
      if (existing?.approvedAt) continue

      const draft = await db.draft.upsert({
        where: {
          leadId_contactId_touchSlot: {
            leadId: lead.id,
            contactId: contact.id,
            touchSlot: slot.touchSlot,
          },
        },
        create: {
          leadId: lead.id,
          contactId: contact.id,
          touchSlot: slot.touchSlot,
          resumeVersionId: resume.id,
          status: 'composing',
          outreachCase: decision.outreachCase,
          subject: composition.subject,
          bodyText: renderBody(composition),
          composition,
          citedEvidenceIds: compositionEvidenceIds(composition),
          approvedClaimIds: compositionClaimIds(composition),
        },
        update: {
          resumeVersionId: resume.id,
          outreachCase: decision.outreachCase,
          subject: composition.subject,
          bodyText: renderBody(composition),
          composition,
          citedEvidenceIds: compositionEvidenceIds(composition),
          approvedClaimIds: compositionClaimIds(composition),
        },
        select: { id: true, createdAt: true, updatedAt: true },
      })

      const created = draft.createdAt.getTime() === draft.updatedAt.getTime()
      if (created) out.draftsCreated += 1
      else out.draftsUpdated += 1

      await writeAudit(db, {
        actorType: 'system',
        actorId: 'draft-composer',
        action: created ? 'draft.composed' : 'draft.recomposed',
        subjectType: 'Draft',
        subjectId: draft.id,
        metadata: {
          leadId: lead.id,
          companyId: company.id,
          contactId: contact.id,
          touchSlot: slot.touchSlot,
          outreachCase: decision.outreachCase,
        },
      })

      out.drafts.push({
        draftId: draft.id,
        companyName: company.displayName,
        contactEmail: contact.emailNormalized,
        outreachCase: decision.outreachCase,
        touchSlot: slot.touchSlot,
      })
    }
  }

  return out
}

/**
 * The facts the Part C predicate reads, assembled from real rows.
 *
 * Every field is derived, not assumed — this is the function that decides whether a
 * message is permitted at all, and a wrong `applicationSubmitted` here would let a
 * case-3 follow-up be sent for an application that was never made.
 */
export function factsFor(
  lead: {
    status: string
    statusReason: string | null
    leadKind: string
    score: number | null
    opportunity: { status: string; roleUrl: string | null; roleTrackId: string | null } | null
  },
  contact: { verified: boolean } | null,
  /**
   * Whether ANY active contact exists at the company, which is a different question
   * from whether the selected one is verified — and the distinction is what makes
   * `outreach_not_permitted` reachable at all.
   *
   * `hasPublicRecruitingContact` asks *"is there a public recruiting route here"*;
   * `hasVerifiedContact` asks *"is the address we would use one we actually read off
   * a page"*. Deriving both from the same field collapses them, and then a company
   * with an unverified contact reports `no_public_recruiting_route` — which is false,
   * a route was found — while Part G's most important policy test becomes unreachable
   * through any real path. `test/unit/outreach-case.test.ts` pins the two as separate
   * inputs; this is that contract, honoured.
   */
  routeExists: boolean = contact?.verified === true,
): OutreachFacts {
  // "Relevant" means the posting is open AND matched to a track. F2 §4.14 sets
  // `roleTrackId` from the posting's own title, so an untracked posting is one whose
  // own text supported no label — which is not a posting we can claim is relevant.
  const hasRelevantPosting =
    lead.opportunity !== null && lead.opportunity.status === 'open' && lead.opportunity.roleTrackId !== null

  return {
    hasRelevantPosting,
    hasClearApplicationRoute: (lead.opportunity?.roleUrl ?? null) !== null,
    // F3 §4.13 writes this onto the LEAD, which is where the predicate was always
    // meant to read it from.
    applicationSubmitted: lead.statusReason === 'application_submitted',
    hasPublicRecruitingContact: routeExists,
    speculativeEvidenceStrong:
      lead.leadKind === 'speculative' && (lead.score ?? 0) >= SCORE_VERSION_V1.thresholds.queue,
    hasVerifiedContact: contact?.verified === true,
    leadQualified: lead.status === 'qualified' || lead.status === 'accepted',
  }
}

/**
 * The sentences that need no judgment, composed immediately (H10).
 *
 * The availability sentence is an `ApprovedClaim`'s own text, unreworded — F3 §4.2's
 * rule, which is what makes "every candidate sentence traces to an approved claim"
 * checkable by containment rather than by reading for smuggled facts.
 */
export function deterministicComposition(
  outreachCase: OutreachCase,
  vars: TemplateVars,
  claimByKey: Map<string, { id: string; key: string; text: string }>,
  now: Date,
): DraftComposition {
  const sentences: DraftSentence[] = []

  const tldrId =
    outreachCase === 'post_application_followup'
      ? 'tldr.post_application@1'
      : outreachCase === 'application_route_unclear'
        ? 'tldr.posted_role@1'
        : 'tldr.intern_inquiry@1'
  sentences.push(template(tldrId, 'tldr', vars))

  // The company and candidate sentences are the LLM's; they are merged in later.

  const availability = claimByKey.get(AVAILABILITY_CLAIM_KEY)
  if (availability) {
    sentences.push({
      role: 'availability',
      text: availability.text,
      evidenceIds: [],
      approvedClaimIds: [availability.id],
      templateId: null,
      source: 'deterministic',
    })
  }

  if (vars.resumeUrl) sentences.push(template('resume.link@1', 'resume_link', vars))

  const askId =
    outreachCase === 'post_application_followup'
      ? 'ask.post_application@1'
      : outreachCase === 'application_route_unclear'
        ? 'ask.route_unclear@1'
        : 'ask.intern_availability@1'
  sentences.push(template(askId, 'ask', vars))
  sentences.push(template('signoff.plain@1', 'signoff', vars))

  return {
    subject: `Internship enquiry — ${vars.companyName}`,
    sentences,
    promptVersion: null,
    composedAt: now.toISOString(),
  }
}

function template(id: string, role: DraftSentence['role'], vars: TemplateVars): DraftSentence {
  return {
    role,
    text: renderTemplate(id, vars),
    evidenceIds: [],
    approvedClaimIds: [],
    templateId: id,
    source: 'deterministic',
  }
}

async function recordRefusal(
  db: Db,
  companyId: string,
  reason: ReasonCodeValue,
  detail: string,
): Promise<void> {
  await writeAudit(db, {
    actorType: 'system',
    actorId: 'draft-composer',
    action: 'draft.refused',
    subjectType: 'Company',
    subjectId: companyId,
    reasonCode: reason,
    metadata: { detail },
  })
}

/**
 * Runs the Quality Gate over a stored draft and records the verdict.
 *
 * Separate from composition because a draft is gated **after** its judgment sentences
 * are merged, and merging happens whenever the operator drains the backlog — which
 * may be days later. Part F: *"Failed drafts return to research or are rejected."*
 */
export async function gateDraft(
  db: Db,
  draftId: string,
  now: Date = new Date(),
): Promise<{ ok: boolean; reason: ReasonCodeValue | null; detail: string }> {
  const draft = await db.draft.findUniqueOrThrow({
    where: { id: draftId },
    select: {
      id: true,
      subject: true,
      bodyText: true,
      composition: true,
      approvedAt: true,
      citedEvidenceIds: true,
      lead: { select: { company: { select: { displayName: true, canonicalDomain: true } } } },
    },
  })

  if (draft.approvedAt) return { ok: true, reason: null, detail: 'already approved; frozen' }

  const validated = await validateComposition(db, draft.composition, TEMPLATE_IDS)
  if (!validated.ok) {
    // A composition that fails the choke point never reaches the gate's judgment: the
    // citation rule is a schema error, not a gate finding (D5).
    await db.draft.update({
      where: { id: draftId },
      data: {
        status: 'gate_failed',
        statusReason: validated.problem === 'uncited_evidence' ? 'weak_evidence' : 'insufficient_evidence',
        gateResult: { version: 'schema', passed: false, problem: validated.problem, detail: validated.detail },
      },
    })
    return { ok: false, reason: 'weak_evidence', detail: `${validated.problem}: ${validated.detail}` }
  }

  // Nothing may be cited that is about a different company. Checked here as well as
  // filtered at queue time, because the two answer different questions: the filter
  // decides what a session is offered, this decides what a stored draft is allowed to
  // have cited — including one composed before the filter existed, or edited by hand.
  const cited = await db.evidence.findMany({
    where: { id: { in: draft.citedEvidenceIds } },
    select: { id: true, sourceUrl: true },
  })
  const { foreign } = partitionEvidenceByScope(cited, draft.lead.company.canonicalDomain)
  if (foreign.length > 0) {
    await db.draft.update({
      where: { id: draftId },
      data: {
        status: 'gate_failed',
        statusReason: 'weak_evidence',
        gateResult: {
          version: GATE_VERSION,
          passed: false,
          problem: 'foreign_evidence',
          detail: `cites ${foreign.length} Evidence row(s) that are not about ${draft.lead.company.canonicalDomain}: ${foreign
            .map((e) => e.sourceUrl)
            .slice(0, 3)
            .join(', ')}`,
        },
      },
    })
    return {
      ok: false,
      reason: 'weak_evidence',
      detail: `foreign_evidence: cites rows about another company (${foreign.map((e) => e.sourceUrl).slice(0, 2).join(', ')})`,
    }
  }

  const result = runQualityGate(
    {
      subject: draft.subject ?? '',
      bodyText: draft.bodyText ?? '',
      composition: validated.value,
      companyName: draft.lead.company.displayName,
    },
    now,
  )

  await db.draft.update({
    where: { id: draftId },
    data: {
      status: result.passed ? 'awaiting_approval' : 'gate_failed',
      statusReason: result.reason,
      gateResult: result,
    },
  })

  await writeAudit(db, {
    actorType: 'system',
    actorId: 'quality-gate',
    action: result.passed ? 'draft.gate_passed' : 'draft.gate_failed',
    subjectType: 'Draft',
    subjectId: draftId,
    ...(result.reason ? { reasonCode: result.reason } : {}),
    metadata: { version: result.version, failed: result.checks.filter((c) => !c.passed).map((c) => c.id) },
  })

  return {
    ok: result.passed,
    reason: result.reason,
    detail: result.checks
      .filter((c) => !c.passed)
      .map((c) => `${c.id}: ${c.detail}`)
      .join('; '),
  }
}

export type { DraftComposition }
