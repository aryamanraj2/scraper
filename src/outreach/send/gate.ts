import type { Db } from '../../core/audit/audit-log.js'
import { writeAudit } from '../../core/audit/audit-log.js'
import { emailHmac, domainOf } from '../../core/crypto/secret-store.js'
import { checkProfileComplete } from '../../core/config/profile-fields.js'
import { resolveSendingEnabled } from '../../core/config/config.js'
import { MILESTONE_STAGE, type Milestone } from '../../core/config/stage.js'
import { decideOutreachCase } from '../../core/policy/outreach-case.js'
import type { ReasonCodeValue } from '../../core/reason-codes/registry.js'
import { verifyApprovalHash } from '../draft/approve.js'
import { factsFor } from '../draft/compose.js'
import { deriveIdempotencyKey, deriveMessageId } from '../mail/message-id.js'
import { checkCaps, type SendCaps } from './caps.js'
import { checkBreaker, type BreakerConfig } from './breaker.js'
import { checkRecipient, resolveRecipientPolicy } from './recipient-policy.js'

/**
 * D6 — the send gate. One choke point, one transaction, every condition re-evaluated
 * immediately before the provider call.
 *
 * > *"All conditions re-evaluated in a single transaction immediately before the
 * > provider call. Any failure aborts with a reason code; none auto-resolves."*
 *
 * D6 lists nine. This evaluates **eleven**, and the two additions are stated here
 * rather than buried:
 *
 * - **The owned-inbox condition** (`recipient_not_owned`). Part F's F5 deliverable is
 *   "verified sends to owned inboxes only" and D6 describes the steady state after the
 *   pilot has started. Every one of D6's nine passes for the approved draft in the
 *   live database, whose recipient is a real third party. See `recipient-policy.ts`.
 * - **`user_paused`**. `handover.md` §8 requires an immediate stop for "reply, bounce,
 *   rejection, opt-out, wrong contact, application submitted, or user pause", and D6's
 *   list does not contain the operator pressing pause on one lead. A kill switch is
 *   global, per-domain or per-account; a paused lead is none of those.
 *
 * ## Order, and why it is not arbitrary
 *
 * Cheap and absolute first, expensive and contingent last, with one override: the
 * conditions that say *"this build must not send at all"* run before anything that
 * reads a draft, so a misconfigured build cannot get far enough to look like it nearly
 * sent something. Everything that could plausibly be the operator's fault is reported
 * before anything that would be ours.
 *
 * ## Why the reason is returned rather than thrown
 *
 * Every other refusal in this system is a reason code plus an audit row, and F1's
 * invariant — *"a skipped source is an OUTCOME, not an exception"* — applies with more
 * force here: a thrown send abort inside a job would unwind the transaction that was
 * about to record why it aborted.
 */

export type SendPlan = {
  draftId: string
  leadId: string
  contactId: string
  companyId: string
  campaignCycle: string
  touchNumber: number
  touchSlot: number
  to: string
  subject: string
  bodyText: string
  fromIdentity: string
  replyTo: string
  idempotencyKey: string
  /** A9: derived here, persisted on `SendAttempt` BEFORE the provider call. */
  rfc822MessageId: string
  inReplyToMessageId: string | undefined
}

export type GateDecision =
  | { allowed: true; plan: SendPlan }
  | { allowed: false; reason: ReasonCodeValue; detail: string }

export type SendGateOptions = {
  now?: Date
  stage?: Milestone
  envFlag?: boolean
  ownedInboxes: string[]
  externalRecipientsEnabled: boolean
  sendingAccount?: string | undefined
  messageIdDomain: string
  suppressionSalt: string
  maxEvidenceAgeDays?: number
  caps?: SendCaps
  breaker?: BreakerConfig
  touchNumber?: number
}

/**
 * A8: *"Nothing re-checks evidence freshness between approval and send… A draft
 * approved Friday can send Monday citing a closed req."*
 *
 * Thirty days matches the window F2's research refresh already works to. It is an
 * envelope rather than a measurement, like F1's starting budget caps were, and the
 * right way to change it is with a number from the pilot.
 */
export const DEFAULT_MAX_EVIDENCE_AGE_DAYS = 30

export async function evaluateSendGate(
  db: Db,
  draftId: string,
  opts: SendGateOptions,
): Promise<GateDecision> {
  const now = opts.now ?? new Date()
  const stage = opts.stage ?? MILESTONE_STAGE
  const touchNumber = opts.touchNumber ?? 1

  // --- 9. Sending globally enabled -----------------------------------------
  // First, not ninth. Two independent factors — a reviewed source constant and an env
  // flag — and if either is unset there is nothing to discuss. Running it first also
  // means a build that cannot send never reads a draft in order to refuse it.
  const sending = resolveSendingEnabled({
    stage,
    ...(opts.envFlag === undefined ? {} : { envFlag: opts.envFlag }),
  })
  if (!sending.enabled) {
    return { allowed: false, reason: sending.reason, detail: `stage=${stage}` }
  }

  const draft = await db.draft.findUnique({
    where: { id: draftId },
    select: {
      id: true,
      leadId: true,
      status: true,
      subject: true,
      bodyText: true,
      outreachCase: true,
      approvedAt: true,
      approvalHash: true,
      senderIdentity: true,
      touchSlot: true,
      citedEvidenceIds: true,
      contact: {
        select: { id: true, emailNormalized: true, verified: true, status: true, companyId: true },
      },
      lead: {
        select: {
          id: true,
          status: true,
          statusReason: true,
          leadKind: true,
          score: true,
          companyId: true,
          campaignCycle: true,
          opportunity: { select: { status: true, roleUrl: true, roleTrackId: true, lastSeenAt: true } },
        },
      },
    },
  })
  if (!draft) return { allowed: false, reason: 'weak_evidence', detail: `no draft ${draftId}` }
  if (!draft.approvedAt || !draft.approvalHash) {
    // Not a reason code of its own: `handover.md` §1.6 makes an unapproved message
    // something that cannot be sent at all rather than something that failed a check.
    return { allowed: false, reason: 'approval_hash_mismatch', detail: 'draft is not approved' }
  }
  if (!draft.contact) return { allowed: false, reason: 'no_public_recruiting_route', detail: 'draft has no contact' }

  const contact = draft.contact
  const lead = draft.lead
  const recipientDomain = domainOf(contact.emailNormalized)

  // --- 10 (F5). Owned inboxes only -----------------------------------------
  // Before the caps, the breaker and the hash, because it is the condition that
  // decides whether this build is allowed to talk to this human at all.
  const policy = resolveRecipientPolicy({
    stage,
    externalRecipientsEnabled: opts.externalRecipientsEnabled,
    ownedInboxes: opts.ownedInboxes,
  })
  const recipient = checkRecipient(contact.emailNormalized, policy)
  if (!recipient.allowed) {
    return await refuse(db, draftId, recipient.reason, recipient.detail)
  }

  // --- 3. Candidate profile complete ---------------------------------------
  const profileRow = await db.candidateProfile.findFirst({
    select: { fullName: true, senderIdentity: true, replyToEmail: true },
  })
  const profile = checkProfileComplete(profileRow, { sendingAccount: opts.sendingAccount })
  if (!profile.complete) {
    return await refuse(db, draftId, profile.reason, profile.detail)
  }

  // --- 11. The lead is not paused ------------------------------------------
  // handover.md §8: stop immediately for reply, bounce, rejection, opt-out, wrong
  // contact, application submitted, or user pause.
  if (lead.status === 'rejected' || lead.status === 'deferred') {
    return await refuse(db, draftId, 'user_paused', `lead status is "${lead.status}"`)
  }
  if (
    lead.statusReason === 'user_paused' ||
    lead.statusReason === 'replied' ||
    lead.statusReason === 'opt_out' ||
    lead.statusReason === 'wrong_contact' ||
    lead.statusReason === 'hard_bounce'
  ) {
    return await refuse(db, draftId, lead.statusReason, `lead is stopped: ${lead.statusReason}`)
  }
  if (contact.status !== 'active') {
    return await refuse(db, draftId, 'suppressed', `contact status is "${contact.status}"`)
  }

  // --- 2. Suppression --------------------------------------------------------
  // A10: matched on the salted HMAC, which survives the Contact row being erased.
  // Checked at all three scopes, cheapest first.
  const hmac = emailHmac(contact.emailNormalized, opts.suppressionSalt)
  const suppression = await db.suppression.findFirst({
    where: {
      OR: [
        { scope: 'global' },
        { scope: 'contact', emailHmac: hmac },
        { scope: 'domain', domain: recipientDomain },
      ],
    },
    select: { scope: true, reasonCode: true },
  })
  if (suppression) {
    return await refuse(
      db,
      draftId,
      'suppressed',
      `suppressed at scope=${suppression.scope} (${suppression.reasonCode})`,
    )
  }

  // --- 5. The outreach case is one of the permitted ones --------------------
  // Re-derived from live rows rather than trusted from `draft.outreachCase`. The
  // stored value is what was true at composition; Part C is a question about now, and
  // an application submitted since approval changes the answer.
  const facts = factsFor(lead, contact, contact.verified)
  const decision = decideOutreachCase(facts)
  if (!decision.permitted) {
    return await refuse(db, draftId, decision.reason, 'the Part C predicate refuses this message now')
  }

  // --- 4. Evidence freshness, and the posting for a posted role (A8) --------
  const maxAgeDays = opts.maxEvidenceAgeDays ?? DEFAULT_MAX_EVIDENCE_AGE_DAYS
  const staleBefore = new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000)
  if (draft.citedEvidenceIds.length > 0) {
    const stale = await db.evidence.findFirst({
      where: { id: { in: draft.citedEvidenceIds }, observedAt: { lt: staleBefore } },
      select: { id: true, sourceUrl: true, observedAt: true },
    })
    if (stale) {
      return await refuse(
        db,
        draftId,
        'stale_at_send',
        `cited evidence ${stale.id} was observed ${stale.observedAt.toISOString()}, older than ${maxAgeDays}d`,
      )
    }
  }
  // For a posted role, the posting itself must still be listed. The live re-confirm
  // runs BEFORE this function (see `refreshPostingBeforeSend`) — a network call inside
  // the gate's transaction would hold a database transaction open across the internet.
  // What is checked here is the refreshed state.
  if (facts.hasRelevantPosting && lead.opportunity) {
    if (lead.opportunity.status !== 'open') {
      return await refuse(db, draftId, 'stale_at_send', `posting status is "${lead.opportunity.status}"`)
    }
    if (lead.opportunity.lastSeenAt !== null && lead.opportunity.lastSeenAt < staleBefore) {
      return await refuse(
        db,
        draftId,
        'stale_at_send',
        `posting last seen ${lead.opportunity.lastSeenAt.toISOString()}, older than ${maxAgeDays}d`,
      )
    }
  }

  // --- 1. approval_hash ------------------------------------------------------
  // A7, and the condition everything else is scaffolding for. `verifyApprovalHash` was
  // written and tested in F4; it is called, never reimplemented.
  const hash = await verifyApprovalHash(db, draftId)
  if (!hash.matches) {
    return await refuse(
      db,
      draftId,
      hash.reason,
      `frozen=${hash.frozen?.slice(0, 12) ?? 'null'} recomputed=${hash.recomputed.slice(0, 12)}`,
    )
  }

  // --- 8. No existing SendAttempt for this contact/company slot -------------
  // D3's partial unique indexes are the real enforcement and they are in the database;
  // this is the readable refusal, so an operator sees `duplicate_contact` rather than
  // a Postgres constraint name. The index still catches the race this cannot.
  const existingForContact = await db.sendAttempt.findFirst({
    where: {
      contactId: contact.id,
      campaignCycle: lead.campaignCycle,
      touchNumber,
      status: { in: ['in_flight', 'sent'] },
    },
    select: { id: true },
  })
  if (existingForContact) {
    return await refuse(db, draftId, 'duplicate_contact', `attempt ${existingForContact.id} already exists for this contact and cycle`)
  }
  const existingForCompany = await db.sendAttempt.findFirst({
    where: {
      companyId: lead.companyId,
      campaignCycle: lead.campaignCycle,
      touchNumber,
      touchSlot: draft.touchSlot,
      status: { in: ['in_flight', 'sent'] },
    },
    select: { id: true },
  })
  if (existingForCompany) {
    return await refuse(
      db,
      draftId,
      'duplicate_company',
      `slot ${draft.touchSlot} at this company is already taken by attempt ${existingForCompany.id}`,
    )
  }

  // --- 6. Caps ---------------------------------------------------------------
  const caps = await checkCaps(db, contact.emailNormalized, {
    now,
    stage,
    ...(opts.caps ? { caps: opts.caps } : {}),
  })
  if (!caps.allowed) return await refuse(db, draftId, caps.reason, caps.detail)

  // --- 7. Circuit breaker ----------------------------------------------------
  const breaker = await checkBreaker(db, {
    now,
    domain: recipientDomain,
    account: opts.sendingAccount,
    ...(opts.breaker ? { config: opts.breaker } : {}),
  })
  if (breaker.open) return await refuse(db, draftId, breaker.reason, breaker.detail)

  const idempotencyKey = deriveIdempotencyKey({
    draftId: draft.id,
    contactId: contact.id,
    campaignCycle: lead.campaignCycle,
    touchNumber,
  })

  return {
    allowed: true,
    plan: {
      draftId: draft.id,
      leadId: lead.id,
      contactId: contact.id,
      companyId: lead.companyId,
      campaignCycle: lead.campaignCycle,
      touchNumber,
      touchSlot: draft.touchSlot,
      to: contact.emailNormalized,
      subject: draft.subject ?? '',
      bodyText: draft.bodyText ?? '',
      // The identity FROZEN at approval, not the profile's current value. If they have
      // diverged the hash check above has already refused; reading the draft here keeps
      // the message identical to the one that was approved.
      fromIdentity: draft.senderIdentity ?? profile.senderIdentity,
      replyTo: profile.replyToEmail,
      idempotencyKey,
      rfc822MessageId: deriveMessageId(idempotencyKey, opts.messageIdDomain),
      inReplyToMessageId: undefined,
    },
  }
}

/**
 * Every refusal writes an audit row before it returns.
 *
 * Part G instruments refusals by reason so that a source — or here, a policy —
 * silently changing is visible rather than mistaken for absence. A send that did not
 * happen is exactly the event an operator needs to be able to find later.
 */
async function refuse(
  db: Db,
  draftId: string,
  reason: ReasonCodeValue,
  detail: string,
): Promise<GateDecision> {
  await writeAudit(db, {
    actorType: 'system',
    actorId: 'send-gate',
    action: 'send.refused',
    subjectType: 'Draft',
    subjectId: draftId,
    reasonCode: reason,
    metadata: { detail },
  })
  return { allowed: false, reason, detail }
}
