import { Prisma } from '../../../generated/prisma/client.js'
import type { OutreachCase } from '../../../generated/prisma/enums.js'
import type { Db } from '../../core/audit/audit-log.js'
import { writeAudit } from '../../core/audit/audit-log.js'
import { decideOutreachCase, type OutreachFacts } from '../../core/policy/outreach-case.js'
import type { ReasonCodeValue } from '../../core/reason-codes/registry.js'
import { ACTIVE_SCORE_VERSION } from '../../intel/scoring/score-version.js'
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
import { INTRO, WINDOW, type PitchSentence } from './pitch.js'
import { recipientFirstName } from './greeting.js'
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
  /**
   * Rewrite drafts that already exist. Off by default: re-composing resets a draft to
   * template sentences and drops the session-written text until the next drain. F6 step
   * 3b measured what the default cost: a plain `drafts:run` silently took 34 written,
   * gated drafts back to `composing` minutes before the operator's review.
   */
  recompose?: boolean
  /** Only these companies, by display name: a sample run touches nothing else. */
  companyNames?: string[]
  /** Only these existing drafts; nothing new is created. A company can hold two. */
  onlyDraftIds?: string[]
}

/** Statuses a composer may overwrite. Everything later is an approval or a record of a send. */
const RECOMPOSABLE = new Set(['composing', 'quality_gate', 'gate_failed', 'awaiting_approval'])

/** The claim keys the deterministic sentences draw on. */
const NAME_CLAIM_KEY = 'identity.full_name'
const LINK_CLAIM_KEYS = ['identity.portfolio', 'identity.github']

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
    where: {
      status: { in: ['qualified', 'accepted'] },
      ...(opts.companyNames ? { company: { displayName: { in: opts.companyNames } } } : {}),
    },
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
            select: { id: true, contactType: true, verified: true, emailNormalized: true, discoveryMethod: true, evidenceId: true },
          },
        },
      },
    },
    orderBy: { score: 'desc' },
    ...(opts.limit === undefined ? {} : { take: opts.limit }),
  })

  // A company's LATEST lead speaks for it, whatever that lead's status. F2 §4.15 keeps
  // one lead per company per cycle, not one per company, so re-scoring in a new month
  // leaves last month's `qualified` row standing beside this month's. Measured
  // 2026-10-04: 95 companies were qualified in both 2026-09 and 2026-10, and A2's
  // indexes count per cycle, so a draft under each lead would have been two first
  // touches to one human, both legal to the database (F6-DECISIONS §3.3 says one).
  // And 4 companies qualified in 2026-09 re-scored to `qualifying` in 2026-10: the
  // current score says research-needed, and a stale row must not overrule it.
  const latestCycle = new Map(
    (
      await db.lead.groupBy({
        by: ['companyId'],
        where: { companyId: { in: [...new Set(leads.map((l) => l.company.id))] } },
        _max: { campaignCycle: true },
      })
    ).map((g) => [g.companyId, g._max.campaignCycle]),
  )

  const resumesByTrack = await loadTrackResumes(db)
  const claims = await db.approvedClaim.findMany({
    where: { isActive: true },
    select: { id: true, key: true, text: true },
  })
  const claimByKey = new Map(claims.map((c) => [c.key, c]))

  for (const lead of leads) {
    const company = lead.company
    if (lead.campaignCycle !== latestCycle.get(company.id)) continue

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

      const contactEvidence = await db.evidence.findUnique({
        where: { id: contact.evidenceId },
        select: { excerpt: true, sourceUrl: true },
      })
      const fullName = claimByKey.get(NAME_CLAIM_KEY)?.text ?? 'the candidate'
      const vars: TemplateVars = {
        companyName: company.displayName,
        roleTitle: lead.opportunity?.title ?? null,
        resumeUrl: resumeRow?.linkUrl ?? '',
        candidateName: fullName,
        candidateFirstName: fullName.split(/\s+/)[0] ?? fullName,
        candidateLinks:
          LINK_CLAIM_KEYS.map((k) => claimByKey.get(k)?.text.replace(/^https?:\/\//, ''))
            .filter((t): t is string => Boolean(t))
            .join(' · ') || null,
        recipientFirstName: recipientFirstName({ ...contact, evidence: contactEvidence }),
      }

      const composition = deterministicComposition({
        vars,
        claimByKey,
        roleInbox: !contact.contactType.startsWith('named'),
        now,
      })

      // This person's existing draft at this company, under ANY lead. Matching on the
      // current lead alone would leave a draft composed under last cycle's lead beside a
      // new one to the same human; re-composing re-homes it onto the current lead
      // instead, so one person has one draft.
      const existing = await db.draft.findFirst({
        where: { contactId: contact.id, lead: { companyId: company.id } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, approvedAt: true, status: true },
      })

      // An approved draft is frozen, exactly as an accepted packet is (F3 §4.11).
      // `approval_hash` is a claim about what a human read; regenerating underneath it
      // would make that claim false while leaving the hash in place. Anything past
      // approval (scheduled, sent, an outcome) is history and is never rewritten.
      if (existing?.approvedAt || (existing && !RECOMPOSABLE.has(existing.status))) continue
      if (existing && !opts.recompose) continue
      if (opts.onlyDraftIds && !(existing && opts.onlyDraftIds.includes(existing.id))) continue

      const content = {
        leadId: lead.id,
        touchSlot: slot.touchSlot,
        resumeVersionId: resume.id,
        outreachCase: decision.outreachCase,
        subject: composition.subject,
        bodyText: renderBody(composition),
        composition,
        citedEvidenceIds: compositionEvidenceIds(composition),
        approvedClaimIds: compositionClaimIds(composition),
      }

      // A re-composed draft holds template sentences only, so it goes back to
      // `composing` with its old verdict and prompt version cleared. Leaving the status
      // alone let a draft that had reached `awaiting_approval` be approved after a
      // re-run had stripped its cited company sentence.
      const draft = existing
        ? await db.draft.update({
            where: { id: existing.id },
            data: { ...content, status: 'composing', statusReason: null, gateResult: Prisma.DbNull, promptVersion: null },
            select: { id: true },
          })
        : await db.draft.create({
            data: { ...content, contactId: contact.id, status: 'composing' },
            select: { id: true },
          })

      const created = !existing
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
      lead.leadKind === 'speculative' && (lead.score ?? 0) >= ACTIVE_SCORE_VERSION.thresholds.queue,
    hasVerifiedContact: contact?.verified === true,
    leadQualified: lead.status === 'qualified' || lead.status === 'accepted',
  }
}

/**
 * The sentences that need no judgment, composed immediately (H10).
 *
 * F6-EMAIL-SPEC (`outreach_draft@3`): the operator's email, minus what depends on the
 * session's answer. The tldr, the modules and the resume link wait for the track and
 * modules it picks, and `mergeV3` adds them with the via, hook and scene. The intro and
 * the window are cited sentences (`pitch.ts`); everything else is a template.
 */
export function deterministicComposition(input: {
  vars: TemplateVars
  claimByKey: Map<string, { id: string; key: string; text: string }>
  /** A role inbox gets "Hi <Company> team," and the ask that also asks for a redirect. */
  roleInbox: boolean
  now: Date
}): DraftComposition {
  const { vars, claimByKey } = input
  const sentences: DraftSentence[] = []

  sentences.push(template(vars.recipientFirstName ? 'greeting.named@1' : 'greeting.team@1', 'greeting', vars))
  const intro = citedSentence(INTRO, 'intro', claimByKey)
  if (intro) sentences.push(intro)
  sentences.push(template('bridge.keep_building@1', 'bridge', vars))
  const window = citedSentence(WINDOW, 'availability', claimByKey)
  if (window) sentences.push(window)
  sentences.push(template(input.roleInbox ? 'ask.talk_or_route@1' : 'ask.talk@1', 'ask', vars))
  sentences.push(template('signoff.plain@6', 'signoff', vars))

  return {
    subject: `Engineering internship at ${vars.companyName}`,
    sentences,
    promptVersion: null,
    composedAt: input.now.toISOString(),
    layout: 'v3',
  }
}

/**
 * A fixed candidate sentence, citing the claims it is bounded by. Dropped — never sent
 * uncited — when any of those claims is missing or withdrawn.
 */
function citedSentence(
  p: PitchSentence,
  role: DraftSentence['role'],
  claimByKey: Map<string, { id: string; key: string; text: string }>,
): DraftSentence | null {
  const ids = p.claimKeys.map((k) => claimByKey.get(k)?.id)
  if (ids.some((id) => id === undefined)) return null
  return {
    role,
    text: p.text,
    evidenceIds: [],
    approvedClaimIds: ids as string[],
    templateId: null,
    source: 'deterministic',
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
