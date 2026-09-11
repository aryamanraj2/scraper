import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeTestDb, testDb, truncateAll } from '../helpers/db.js'
import { seedApprovedClaims } from '../../src/apply/claims/seed-claims.js'
import { seedCandidateProfile } from '../../src/apply/claims/seed-profile.js'
import { approveDraft } from '../../src/outreach/draft/approve.js'
import { evaluateSendGate, type SendGateOptions } from '../../src/outreach/send/gate.js'
import { sendApprovedDraft, reconcileInFlight } from '../../src/outreach/send/send.js'
import { FakeMailProvider } from '../../src/outreach/mail/fake.js'
import { engageKillSwitch } from '../../src/core/killswitch/kill-switch.js'
import { emailHmac } from '../../src/core/crypto/secret-store.js'

/**
 * D6's send gate, as red-team attempts.
 *
 * Every test here is an attempt to get a message out that should not go out. The gate
 * is the one choke point where that is decided, and Part G's framing applies: each is
 * a red-team attempt that must fail closed.
 *
 * The stage is passed explicitly as `'F5'` throughout. These tests must keep passing
 * when the build stage moves on — F2 §4.9's lesson — and pinning the stage is also the
 * only honest way to test a gate whose first condition is the stage.
 */

const SALT = 'test-suppression-salt'
const OWNED = ['owner@owned.example']

function baseOptions(over: Partial<SendGateOptions> = {}): SendGateOptions {
  return {
    stage: 'F5',
    envFlag: true,
    ownedInboxes: OWNED,
    externalRecipientsEnabled: false,
    sendingAccount: 'aryamanj250@gmail.com',
    messageIdDomain: 'owned.example',
    suppressionSalt: SALT,
    ...over,
  }
}

type WorldOpts = {
  contactEmail?: string
  teamSize?: number
  evidenceObservedAt?: Date
  leadStatusReason?: string | null
}

/**
 * An approved draft, built through the REAL approval flow.
 *
 * The composition is constructed directly rather than driven through the LLM handoff —
 * that chain is F4's and is tested in `outreach-draft.test.ts`. What matters here is
 * that `approveDraft` computed and froze the hash over these exact rows, because the
 * gate's first condition recomputes it.
 */
async function world(opts: WorldOpts = {}) {
  const db = testDb()
  await seedApprovedClaims(db)
  await seedCandidateProfile(db, { sendingAccount: 'aryamanj250@gmail.com' })

  const claims = await db.approvedClaim.findMany({ where: { isActive: true }, take: 1, select: { id: true, text: true } })
  const claim = claims[0]!

  const resume = await db.resumeVersion.create({
    data: {
      label: 'SDE — backend / systems',
      trackKey: 'sde',
      linkUrl: 'https://aryamanj.in/resume/backend.pdf',
      filePath: '/r.pdf',
      fileSha256: 'a'.repeat(64),
    },
    select: { id: true },
  })
  const company = await db.company.create({
    data: {
      canonicalDomain: 'acme.example',
      displayName: 'Acme',
      countries: ['India'],
      locations: [],
      tags: [],
      teamSize: opts.teamSize ?? 40,
    },
    select: { id: true },
  })
  const evidence = await db.evidence.create({
    data: {
      companyId: company.id,
      sourceUrl: 'https://acme.example/careers',
      sourceType: 'company_page',
      excerpt: 'Our platform team writes Go and runs Postgres at scale in Bengaluru.',
      contentHash: 'h1',
      observedAt: opts.evidenceObservedAt ?? new Date(),
      confidence: 0.8,
      fetchedVia: 'static_fetch',
    },
    select: { id: true },
  })
  const contact = await db.contact.create({
    data: {
      companyId: company.id,
      emailNormalized: opts.contactEmail ?? OWNED[0]!,
      contactType: 'careers_alias',
      discoveryMethod: 'page_published',
      verified: true,
      evidenceId: evidence.id,
      capturedAt: new Date(),
    },
    select: { id: true },
  })
  const scoreVersion = await db.scoreVersion.create({
    data: { label: 'f2-v1', weights: {}, thresholds: {}, maxRiskDeduction: 40 },
  })
  const lead = await db.lead.create({
    data: {
      companyId: company.id,
      contactId: contact.id,
      leadKind: 'speculative',
      primaryTrack: 'sde',
      primaryTrackReason: 'fixture',
      campaignCycle: '2026-Q3',
      status: 'qualified',
      statusReason: (opts.leadStatusReason ?? null) as never,
      score: 88,
      scoreVersionId: scoreVersion.id,
    },
    select: { id: true },
  })

  const composition = {
    subject: 'Internship enquiry — Acme',
    sentences: [
      {
        role: 'company',
        text: 'Your careers page says the platform team writes Go and runs Postgres at scale in Bengaluru.',
        evidenceIds: [evidence.id],
        approvedClaimIds: [],
        templateId: null,
        source: 'llm',
      },
      {
        role: 'candidate',
        text: claim.text,
        evidenceIds: [],
        approvedClaimIds: [claim.id],
        templateId: null,
        source: 'deterministic',
      },
      {
        role: 'ask',
        text: 'Is Acme taking engineering interns in that window, or is there a better route than this address?',
        evidenceIds: [],
        approvedClaimIds: [],
        templateId: 'ask.intern_availability@1',
        source: 'deterministic',
      },
    ],
    promptVersion: 'outreach_draft@1',
    composedAt: new Date().toISOString(),
  }

  const draft = await db.draft.create({
    data: {
      leadId: lead.id,
      contactId: contact.id,
      touchSlot: 0,
      resumeVersionId: resume.id,
      status: 'awaiting_approval',
      subject: composition.subject,
      bodyText: composition.sentences.map((s) => s.text).join('\n\n'),
      composition,
      outreachCase: 'intern_availability_inquiry',
      citedEvidenceIds: [evidence.id],
      approvedClaimIds: [claim.id],
      promptVersion: 'outreach_draft@1',
    },
    select: { id: true },
  })

  const approved = await approveDraft(db, draft.id, 'operator')
  if (!approved.ok) throw new Error(`approve failed: ${approved.reason} ${approved.detail}`)

  return { db, draftId: draft.id, leadId: lead.id, contactId: contact.id, companyId: company.id, evidenceId: evidence.id }
}

beforeEach(async () => truncateAll())
afterAll(async () => closeTestDb())

describe('the gate refuses before it reads anything, when the build cannot send', () => {
  it('refuses at the shipped stage even with the env flag set', async () => {
    const { db, draftId } = await world()
    // No `stage` override: this is the build as it ships.
    const decision = await evaluateSendGate(db, draftId, { ...baseOptions(), stage: 'F4', envFlag: true })
    expect(decision.allowed).toBe(false)
    if (decision.allowed) throw new Error('unreachable')
    expect(decision.reason).toBe('sending_disabled')
  })

  it('refuses when the env flag is unset, whatever the stage', async () => {
    const { db, draftId } = await world()
    const decision = await evaluateSendGate(db, draftId, baseOptions({ envFlag: false }))
    expect(decision.allowed).toBe(false)
    if (decision.allowed) throw new Error('unreachable')
    expect(decision.reason).toBe('sending_disabled')
  })
})

describe('the owned-inbox condition', () => {
  it('refuses a real third-party recipient at F5', async () => {
    const { db, draftId } = await world({ contactEmail: 'info@nanonets.com' })
    const decision = await evaluateSendGate(db, draftId, baseOptions())
    expect(decision.allowed).toBe(false)
    if (decision.allowed) throw new Error('unreachable')
    expect(decision.reason).toBe('recipient_not_owned')
  })

  it('permits an owned inbox', async () => {
    const { db, draftId } = await world()
    const decision = await evaluateSendGate(db, draftId, baseOptions())
    expect(decision.allowed).toBe(true)
  })

  it('still refuses a third party at F6 when the external flag is unset', async () => {
    const { db, draftId } = await world({ contactEmail: 'info@nanonets.com' })
    const decision = await evaluateSendGate(
      db,
      draftId,
      baseOptions({ stage: 'F6', externalRecipientsEnabled: false }),
    )
    expect(decision.allowed).toBe(false)
    if (decision.allowed) throw new Error('unreachable')
    expect(decision.reason).toBe('recipient_not_owned')
  })
})

describe('D6 condition 1 — the approval hash (A7)', () => {
  it('refuses when the body is edited after approval', async () => {
    const { db, draftId } = await world()
    await db.draft.update({ where: { id: draftId }, data: { bodyText: 'something else entirely' } })
    const decision = await evaluateSendGate(db, draftId, baseOptions())
    expect(decision.allowed).toBe(false)
    if (decision.allowed) throw new Error('unreachable')
    expect(decision.reason).toBe('approval_hash_mismatch')
  })

  it('refuses when the sender identity is swapped — the field F5 made binding', async () => {
    // Before F5 this passed: `senderIdentity` was hashed as `null` because no caller
    // ever supplied it, so changing the sending account left the approval valid.
    const { db, draftId } = await world()
    await db.draft.update({
      where: { id: draftId },
      data: { senderIdentity: 'Someone Else <someone@elsewhere.example>' },
    })
    const decision = await evaluateSendGate(db, draftId, baseOptions())
    expect(decision.allowed).toBe(false)
    if (decision.allowed) throw new Error('unreachable')
    expect(decision.reason).toBe('approval_hash_mismatch')
  })

  it('refuses a draft that was never approved', async () => {
    const { db, draftId } = await world()
    await db.draft.update({
      where: { id: draftId },
      data: { approvedAt: null, approvalHash: null, status: 'awaiting_approval' },
    })
    const decision = await evaluateSendGate(db, draftId, baseOptions())
    expect(decision.allowed).toBe(false)
    if (decision.allowed) throw new Error('unreachable')
    expect(decision.reason).toBe('approval_hash_mismatch')
  })
})

describe('D6 condition 2 — suppression (A10)', () => {
  it('refuses a contact-scope suppression matched on the HMAC', async () => {
    const { db, draftId } = await world()
    await db.suppression.create({
      data: { emailHmac: emailHmac(OWNED[0]!, SALT), scope: 'contact', reasonCode: 'opt_out' },
    })
    const decision = await evaluateSendGate(db, draftId, baseOptions())
    expect(decision.allowed).toBe(false)
    if (decision.allowed) throw new Error('unreachable')
    expect(decision.reason).toBe('suppressed')
  })

  it('refuses on a domain-scope suppression', async () => {
    const { db, draftId } = await world()
    await db.suppression.create({
      data: { emailHmac: 'unrelated', scope: 'domain', domain: 'owned.example', reasonCode: 'opt_out' },
    })
    const decision = await evaluateSendGate(db, draftId, baseOptions())
    expect(decision.allowed).toBe(false)
    if (decision.allowed) throw new Error('unreachable')
    expect(decision.reason).toBe('suppressed')
  })

  it('refuses after the contact row itself is erased, because the HMAC outlives it', async () => {
    // A10's whole point: deleting someone who asked to be forgotten must not make them
    // contactable again.
    const { db, draftId, contactId } = await world()
    await db.suppression.create({
      data: { emailHmac: emailHmac(OWNED[0]!, SALT), scope: 'contact', reasonCode: 'opt_out' },
    })
    await db.draft.update({ where: { id: draftId }, data: { contactId: null } })
    await db.sendAttempt.deleteMany({ where: { contactId } })
    const decision = await evaluateSendGate(db, draftId, baseOptions())
    expect(decision.allowed).toBe(false)
    // No contact on the draft is its own refusal, and the suppression row is still
    // there for the next cycle's contact at the same address.
    const surviving = await db.suppression.count()
    expect(surviving).toBe(1)
    if (decision.allowed) throw new Error('unreachable')
  })
})

describe('D6 condition 3 — profile completeness', () => {
  it('refuses when no CandidateProfile exists', async () => {
    const { db, draftId } = await world()
    await db.candidateProfile.deleteMany()
    const decision = await evaluateSendGate(db, draftId, baseOptions())
    expect(decision.allowed).toBe(false)
    if (decision.allowed) throw new Error('unreachable')
    expect(decision.reason).toBe('profile_incomplete')
  })

  it('refuses when the sender identity names a different account than the transport', async () => {
    const { db, draftId } = await world()
    const decision = await evaluateSendGate(
      db,
      draftId,
      baseOptions({ sendingAccount: 'someone-else@gmail.com' }),
    )
    expect(decision.allowed).toBe(false)
    if (decision.allowed) throw new Error('unreachable')
    expect(decision.reason).toBe('profile_incomplete')
  })
})

describe('D6 condition 4 — freshness (A8)', () => {
  it('refuses when cited evidence is older than the window', async () => {
    const { db, draftId } = await world({
      evidenceObservedAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
    })
    const decision = await evaluateSendGate(db, draftId, baseOptions())
    expect(decision.allowed).toBe(false)
    if (decision.allowed) throw new Error('unreachable')
    expect(decision.reason).toBe('stale_at_send')
  })
})

describe('D6 conditions 6 and 7 — caps and the breaker', () => {
  it('refuses once the daily cap is reached', async () => {
    const { db, draftId } = await world()
    const decision = await evaluateSendGate(
      db,
      draftId,
      baseOptions({ caps: { perDay: 0, perDomainPerDay: 10 } }),
    )
    expect(decision.allowed).toBe(false)
    if (decision.allowed) throw new Error('unreachable')
    expect(decision.reason).toBe('cap_exceeded')
  })

  it('refuses when the manual kill switch is engaged', async () => {
    const { db, draftId } = await world()
    await engageKillSwitch(db, 'global', '*', 'operator', 'testing')
    const decision = await evaluateSendGate(db, draftId, baseOptions())
    expect(decision.allowed).toBe(false)
    if (decision.allowed) throw new Error('unreachable')
    expect(decision.reason).toBe('kill_switch_global')
  })

  it('opens the breaker on the absolute hard-bounce count, before any rate is meaningful', async () => {
    const { db, draftId } = await world()
    const attempt = await db.sendAttempt.create({
      data: {
        draftId,
        contactId: (await db.contact.findFirstOrThrow()).id,
        companyId: (await db.company.findFirstOrThrow()).id,
        campaignCycle: 'other-cycle',
        touchNumber: 1,
        idempotencyKey: 'bounced-key',
        rfc822MessageId: '<bounced@owned.example>',
        status: 'sent',
      },
      select: { id: true },
    })
    for (let i = 0; i < 3; i += 1) {
      await db.bounce.create({
        data: { sendAttemptId: attempt.id, hardness: 'hard', occurredAt: new Date() },
      })
    }
    const decision = await evaluateSendGate(db, draftId, baseOptions())
    expect(decision.allowed).toBe(false)
    if (decision.allowed) throw new Error('unreachable')
    expect(decision.reason).toBe('breaker_open')
  })
})

describe('D6 condition 8 and the lead stop-states', () => {
  it('refuses a second first touch to the same human in the same cycle', async () => {
    const { db, draftId, contactId, companyId } = await world()
    await db.sendAttempt.create({
      data: {
        draftId,
        contactId,
        companyId,
        campaignCycle: '2026-Q3',
        touchNumber: 1,
        touchSlot: 1,
        idempotencyKey: 'earlier',
        rfc822MessageId: '<earlier@owned.example>',
        status: 'sent',
      },
    })
    const decision = await evaluateSendGate(db, draftId, baseOptions())
    expect(decision.allowed).toBe(false)
    if (decision.allowed) throw new Error('unreachable')
    expect(decision.reason).toBe('duplicate_contact')
  })

  it('refuses a paused lead', async () => {
    const { db, draftId, leadId } = await world()
    await db.lead.update({ where: { id: leadId }, data: { statusReason: 'user_paused' } })
    const decision = await evaluateSendGate(db, draftId, baseOptions())
    expect(decision.allowed).toBe(false)
    if (decision.allowed) throw new Error('unreachable')
    expect(decision.reason).toBe('user_paused')
  })

  it('refuses a lead that already replied', async () => {
    const { db, draftId, leadId } = await world()
    await db.lead.update({ where: { id: leadId }, data: { statusReason: 'replied' } })
    const decision = await evaluateSendGate(db, draftId, baseOptions())
    expect(decision.allowed).toBe(false)
    if (decision.allowed) throw new Error('unreachable')
    expect(decision.reason).toBe('replied')
  })
})

describe('every refusal leaves an audit row', () => {
  it('records the reason code against the draft', async () => {
    const { db, draftId } = await world({ contactEmail: 'info@nanonets.com' })
    await evaluateSendGate(db, draftId, baseOptions())
    const row = await db.auditLog.findFirst({
      where: { action: 'send.refused', subjectId: draftId },
      select: { reasonCode: true },
    })
    expect(row?.reasonCode).toBe('recipient_not_owned')
  })
})

/**
 * Part G's first row, and the reason A9 exists:
 *
 * > *"Kill worker after the Gmail call but before the response is recorded; restart;
 * > assert the reconciliation search finds the sent message and **no second send is
 * > issued**."*
 */
describe('A9 — a crash mid-send issues no second send', () => {
  it('reconciles a lost response instead of re-sending', async () => {
    const { db, draftId } = await world()
    const mail = new FakeMailProvider({ messageIdDomain: 'owned.example' })

    // The message is delivered and then the response is lost — the dangerous state.
    mail.failNextSendAmbiguously()
    const first = await sendApprovedDraft(db, mail, draftId, baseOptions())

    expect(mail.sendCalls).toBe(1)
    expect(mail.sent).toHaveLength(1)
    // The reconciliation ran inside the same call and found it.
    expect(first.status).toBe('sent')
    if (first.status !== 'sent') throw new Error('unreachable')
    expect(first.reconciled).toBe(true)

    // And a retry afterwards must not send either.
    const second = await sendApprovedDraft(db, mail, draftId, baseOptions())
    expect(mail.sendCalls).toBe(1)
    expect(second.status).toBe('sent')
  })

  it('recovers an in_flight row left by a crash, with no second send', async () => {
    const { db, draftId } = await world()
    const mail = new FakeMailProvider({ messageIdDomain: 'owned.example' })

    // The worker dies between the provider call and recording the outcome.
    class Crash extends Error {}
    await expect(
      sendApprovedDraft(db, mail, draftId, {
        ...baseOptions(),
        onAfterProviderCall: () => {
          throw new Crash('worker killed')
        },
      }),
    ).rejects.toBeInstanceOf(Crash)

    const stranded = await db.sendAttempt.findFirstOrThrow({ select: { status: true, rfc822MessageId: true } })
    expect(stranded.status).toBe('in_flight')
    // A9 step 3: the Message-ID was persisted BEFORE the call, so it survived.
    expect(stranded.rfc822MessageId).toMatch(/^<oi\.[0-9a-f]{32}@owned\.example>$/)
    expect(mail.sendCalls).toBe(1)

    // Restart.
    const recovered = await reconcileInFlight(db, mail)
    expect(recovered).toHaveLength(1)
    expect(recovered[0]!.status).toBe('sent')
    expect(mail.sendCalls).toBe(1)

    const attempt = await db.sendAttempt.findFirstOrThrow()
    expect(attempt.status).toBe('sent')
    expect(attempt.reconciledAt).not.toBeNull()
    expect(await db.sendAttempt.count()).toBe(1)
  })

  it('marks failed, and does NOT send again, when the reconciliation finds nothing', async () => {
    const { db, draftId } = await world()
    const mail = new FakeMailProvider({ messageIdDomain: 'owned.example' })
    mail.failNextSendWith(new Error('400 malformed'))

    const result = await sendApprovedDraft(db, mail, draftId, baseOptions())
    expect(result.status).toBe('failed')
    expect(mail.sent).toHaveLength(0)
    expect(mail.sendCalls).toBe(1)

    const attempt = await db.sendAttempt.findFirstOrThrow()
    expect(attempt.status).toBe('failed')
    // The approval survives a transport failure: it was not a hash mismatch.
    const draft = await db.draft.findFirstOrThrow({ select: { status: true, approvalHash: true } })
    expect(draft.status).toBe('approved')
    expect(draft.approvalHash).not.toBeNull()
  })

  it('a provider that REWRITES the Message-ID makes the reconciliation miss — pinned deliberately', async () => {
    // This is the failure the live probe exists to rule out. If Gmail rewrites a
    // client-supplied Message-ID, an rfc822msgid: search for our derived id returns
    // nothing, the reconciliation concludes "not sent", and a retry would double-send.
    // The fake can express that, so the risk is a test rather than a hope.
    const { db, draftId } = await world()
    const mail = new FakeMailProvider({ messageIdDomain: 'owned.example', preservesMessageId: false })

    mail.failNextSendAmbiguously()
    const result = await sendApprovedDraft(db, mail, draftId, baseOptions())

    expect(mail.sent).toHaveLength(1) // it WAS delivered
    expect(result.status).toBe('failed') // and we cannot tell
    expect(mail.sendCalls).toBe(1) // but we still did not send twice
  })
})

describe('the happy path', () => {
  it('writes the SendAttempt before the provider call, and marks it sent', async () => {
    const { db, draftId } = await world()
    const mail = new FakeMailProvider({ messageIdDomain: 'owned.example' })
    const result = await sendApprovedDraft(db, mail, draftId, baseOptions())

    expect(result.status).toBe('sent')
    const attempt = await db.sendAttempt.findFirstOrThrow()
    expect(attempt.status).toBe('sent')
    expect(attempt.providerMessageId).not.toBeNull()
    expect(attempt.touchSlot).toBe(0)

    const sent = mail.sent[0]!
    expect(sent.to).toBe(OWNED[0])
    expect(sent.rfc822MessageId).toBe(attempt.rfc822MessageId)
    // A9: the id in the MIME is the id on the row, derived from the idempotency key.
    expect(sent.raw).toContain(`Message-ID: ${attempt.rfc822MessageId}`)

    const draft = await db.draft.findFirstOrThrow({ select: { status: true } })
    expect(draft.status).toBe('sent')
  })
})
