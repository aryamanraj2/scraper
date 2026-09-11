import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeTestDb, testDb, truncateAll } from '../helpers/db.js'
import {
  ingestInboundMessage,
  markWrongContact,
  pauseLead,
  type InboundForIngest,
} from '../../src/outreach/send/ingest-outcomes.js'
import { emailHmac } from '../../src/core/crypto/secret-store.js'
import { evaluateSendGate, type SendGateOptions } from '../../src/outreach/send/gate.js'
import { seedApprovedClaims } from '../../src/apply/claims/seed-claims.js'
import { seedCandidateProfile } from '../../src/apply/claims/seed-profile.js'

/**
 * Outcome ingestion, as red-team attempts.
 *
 * The property under test throughout is A12's, and it is a *separation* rather than a
 * rule: **stopping** a conversation and **suppressing** an address are different acts,
 * and only some outcomes do both. A soft bounce that permanently suppressed would
 * violate A12; a soft bounce that left the lead live would keep sending to a failing
 * address. Both failures are tested for.
 */

const SALT = 'test-suppression-salt'
const RECIPIENT = 'careers@acme.example'
const OUR_MESSAGE_ID = '<oi.' + 'a'.repeat(32) + '@aryamanj.in>'

async function sentWorld() {
  const db = testDb()
  // D6 condition 3 runs before the suppression check, so a world with no profile
  // reports `profile_incomplete` for everything and the tests below would be asserting
  // that instead of what they mean to.
  await seedApprovedClaims(db)
  await seedCandidateProfile(db)
  const company = await db.company.create({
    data: { canonicalDomain: 'acme.example', displayName: 'Acme', countries: [], locations: [], tags: [] },
    select: { id: true },
  })
  const evidence = await db.evidence.create({
    data: {
      companyId: company.id,
      sourceUrl: 'https://acme.example/careers',
      sourceType: 'company_page',
      excerpt: 'Careers.',
      contentHash: 'h',
      observedAt: new Date(),
      confidence: 1,
      fetchedVia: 'static_fetch',
    },
    select: { id: true },
  })
  const contact = await db.contact.create({
    data: {
      companyId: company.id,
      emailNormalized: RECIPIENT,
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
      score: 88,
      scoreVersionId: scoreVersion.id,
    },
    select: { id: true },
  })
  const draft = await db.draft.create({
    data: {
      leadId: lead.id,
      contactId: contact.id,
      status: 'sent',
      subject: 'Internship enquiry',
      bodyText: 'body',
      outreachCase: 'intern_availability_inquiry',
      citedEvidenceIds: [evidence.id],
      approvedClaimIds: [],
    },
    select: { id: true },
  })
  const attempt = await db.sendAttempt.create({
    data: {
      draftId: draft.id,
      contactId: contact.id,
      companyId: company.id,
      campaignCycle: '2026-Q3',
      touchNumber: 1,
      idempotencyKey: 'key-1',
      rfc822MessageId: OUR_MESSAGE_ID,
      providerThreadId: 'thread-1',
      status: 'sent',
      providerMessageId: 'pm-1',
    },
    select: { id: true },
  })
  return { db, company, contact, lead, draft, attempt }
}

function inbound(over: Partial<InboundForIngest> = {}): InboundForIngest {
  return {
    providerMessageId: `in-${Math.random().toString(16).slice(2)}`,
    threadId: 'thread-1',
    from: 'someone@acme.example',
    subject: 'Re: Internship enquiry',
    bodyText: 'Thanks for writing.',
    inReplyTo: OUR_MESSAGE_ID,
    receivedAt: new Date(),
    ...over,
  }
}

beforeEach(async () => truncateAll())
afterAll(async () => closeTestDb())

describe('A12 — a soft bounce stops the conversation and does NOT permanently suppress', () => {
  it('writes a soft Bounce, no Suppression, and leaves the contact active', async () => {
    const { db, contact } = await sentWorld()
    const result = await ingestInboundMessage(
      db,
      inbound({
        from: 'mailer-daemon@googlemail.com',
        subject: 'Delivery Status Notification (Delay)',
        bodyText: 'Action: failed\nStatus: 4.2.2\nDiagnostic-Code: smtp; 452 4.2.2 over quota',
      }),
      { suppressionSalt: SALT },
    )

    expect(result).toMatchObject({ kind: 'bounce', reasonCode: 'soft_bounce', suppressed: false })
    expect(await db.bounce.count({ where: { hardness: 'soft' } })).toBe(1)
    // The rule, stated as an assertion.
    expect(await db.suppression.count()).toBe(0)
    const row = await db.contact.findUniqueOrThrow({ where: { id: contact.id }, select: { status: true } })
    expect(row.status).toBe('active')
  })

  it('but still stops the lead, so nothing is re-sent to a failing address', async () => {
    const { db, lead, draft } = await sentWorld()
    await ingestInboundMessage(
      db,
      inbound({
        from: 'mailer-daemon@googlemail.com',
        subject: 'Delivery Status Notification (Delay)',
        bodyText: 'Action: failed\nStatus: 4.2.2',
      }),
      { suppressionSalt: SALT },
    )
    const leadRow = await db.lead.findUniqueOrThrow({ where: { id: lead.id }, select: { statusReason: true } })
    expect(leadRow.statusReason).toBe('soft_bounce')
    const draftRow = await db.draft.findUniqueOrThrow({ where: { id: draft.id }, select: { status: true } })
    expect(draftRow.status).toBe('bounced_soft')
  })
})

describe('a hard bounce suppresses permanently', () => {
  it('writes a Suppression keyed on the HMAC and retires the contact', async () => {
    const { db, contact } = await sentWorld()
    const result = await ingestInboundMessage(
      db,
      inbound({
        from: 'mailer-daemon@googlemail.com',
        subject: 'Delivery Status Notification (Failure)',
        bodyText: 'Action: failed\nStatus: 5.1.1\nDiagnostic-Code: smtp; 550 5.1.1 no such user',
      }),
      { suppressionSalt: SALT },
    )
    expect(result).toMatchObject({ kind: 'bounce', reasonCode: 'hard_bounce', suppressed: true })

    const suppression = await db.suppression.findFirstOrThrow()
    expect(suppression.scope).toBe('contact')
    expect(suppression.emailHmac).toBe(emailHmac(RECIPIENT, SALT))
    // A10: the plaintext address is nowhere on the row.
    expect(JSON.stringify(suppression)).not.toContain(RECIPIENT)

    const row = await db.contact.findUniqueOrThrow({ where: { id: contact.id }, select: { status: true } })
    expect(row.status).toBe('suppressed')
  })

  it('and the send gate then refuses the next draft to that address', async () => {
    const { db, contact, company } = await sentWorld()
    await ingestInboundMessage(
      db,
      inbound({
        from: 'mailer-daemon@googlemail.com',
        subject: 'Delivery Status Notification (Failure)',
        bodyText: 'Status: 5.1.1',
      }),
      { suppressionSalt: SALT },
    )

    // A brand-new draft to the same person, next cycle.
    const lead = await db.lead.create({
      data: {
        companyId: company.id,
        contactId: contact.id,
        leadKind: 'speculative',
        primaryTrack: 'sde',
        primaryTrackReason: 'fixture',
        campaignCycle: '2026-Q4',
        status: 'qualified',
        score: 88,
        scoreVersionId: (await db.scoreVersion.findFirstOrThrow()).id,
      },
      select: { id: true },
    })
    const next = await db.draft.create({
      data: {
        leadId: lead.id,
        contactId: contact.id,
        status: 'approved',
        approvedAt: new Date(),
        approvalHash: 'whatever',
        subject: 's',
        bodyText: 'b',
        outreachCase: 'intern_availability_inquiry',
        citedEvidenceIds: [],
        approvedClaimIds: [],
      },
      select: { id: true },
    })

    const opts: SendGateOptions = {
      stage: 'F5',
      envFlag: true,
      ownedInboxes: [RECIPIENT],
      externalRecipientsEnabled: false,
      messageIdDomain: 'aryamanj.in',
      suppressionSalt: SALT,
    }
    const decision = await evaluateSendGate(db, next.id, opts)
    expect(decision.allowed).toBe(false)
    if (decision.allowed) throw new Error('unreachable')
    // The contact was retired by the ingestion, which the gate reports as suppressed.
    expect(decision.reason).toBe('suppressed')
  })
})

describe('replies', () => {
  it('a plain reply stops the follow-up and does NOT suppress', async () => {
    // A person who replied has started a conversation, not asked us to stop.
    // Suppressing them would block the operator's own answer.
    const { db, lead } = await sentWorld()
    const result = await ingestInboundMessage(
      db,
      inbound({ bodyText: 'We do run a summer internship — applications open in November.' }),
      { suppressionSalt: SALT },
    )
    expect(result).toMatchObject({ kind: 'reply', reasonCode: 'replied', suppressed: false })
    expect(await db.suppression.count()).toBe(0)
    const leadRow = await db.lead.findUniqueOrThrow({ where: { id: lead.id }, select: { statusReason: true } })
    expect(leadRow.statusReason).toBe('replied')
  })

  it('an opt-out suppresses permanently and records an OptOut row', async () => {
    const { db } = await sentWorld()
    const result = await ingestInboundMessage(
      db,
      inbound({ bodyText: "I'd rather you didn't write again." }),
      { suppressionSalt: SALT },
    )
    expect(result).toMatchObject({ kind: 'opt_out', reasonCode: 'opt_out', suppressed: true })
    expect(await db.optOut.count()).toBe(1)
    const suppression = await db.suppression.findFirstOrThrow()
    expect(suppression.reasonCode).toBe('opt_out')
  })

  it('a wrong-contact report suppresses the ADDRESS, not the company', async () => {
    const { db, company } = await sentWorld()
    const result = await ingestInboundMessage(
      db,
      inbound({ bodyText: "I'm not the right person for this — try our careers team." }),
      { suppressionSalt: SALT },
    )
    expect(result).toMatchObject({ kind: 'wrong_contact', reasonCode: 'wrong_contact', suppressed: true })
    const suppression = await db.suppression.findFirstOrThrow()
    expect(suppression.scope).toBe('contact')
    // Nothing at domain or global scope: the company may well have a correct route,
    // and the whole point of the report is that this was not it.
    expect(await db.suppression.count({ where: { scope: { in: ['domain', 'global'] } } })).toBe(0)
    expect(await db.company.count({ where: { id: company.id } })).toBe(1)
  })

  it('an auto-reply changes no state at all', async () => {
    const { db, lead } = await sentWorld()
    const result = await ingestInboundMessage(
      db,
      inbound({
        subject: 'Automatic reply: Internship enquiry',
        bodyText: 'I am out of the office until Monday.',
      }),
      { suppressionSalt: SALT },
    )
    expect(result).toMatchObject({ kind: 'auto_reply', reasonCode: null, suppressed: false })
    const leadRow = await db.lead.findUniqueOrThrow({ where: { id: lead.id }, select: { statusReason: true } })
    expect(leadRow.statusReason).toBeNull()
    expect(await db.suppression.count()).toBe(0)
  })
})

describe('matching a received message to the attempt it is about', () => {
  it('matches on In-Reply-To carrying our own derived Message-ID', async () => {
    const { db, attempt } = await sentWorld()
    const result = await ingestInboundMessage(db, inbound({ threadId: 'unknown-thread' }), {
      suppressionSalt: SALT,
    })
    expect(result).toMatchObject({ sendAttemptId: attempt.id })
  })

  it('matches on the quoted Message-ID inside a DSN body when no In-Reply-To is set', async () => {
    // A bounce frequently quotes the original headers inside a message/rfc822 part
    // rather than setting In-Reply-To at all.
    const { db, attempt } = await sentWorld()
    const result = await ingestInboundMessage(
      db,
      inbound({
        inReplyTo: null,
        threadId: 'unknown-thread',
        from: 'mailer-daemon@googlemail.com',
        subject: 'Delivery Status Notification (Failure)',
        bodyText: `Status: 5.1.1\n\n----- Original message -----\nMessage-ID: ${OUR_MESSAGE_ID}\nSubject: Internship enquiry`,
      }),
      { suppressionSalt: SALT },
    )
    expect(result).toMatchObject({ sendAttemptId: attempt.id, reasonCode: 'hard_bounce' })
  })

  it('records an unmatched message rather than dropping it', async () => {
    // B3: silently discarding a bounce is how "nothing is bouncing" becomes a belief
    // rather than a measurement.
    const { db } = await sentWorld()
    const result = await ingestInboundMessage(
      db,
      inbound({ inReplyTo: '<someone-elses@example.com>', threadId: 'other' }),
      { suppressionSalt: SALT },
    )
    expect(result).toMatchObject({ kind: 'unmatched' })
    const audit = await db.auditLog.findFirst({ where: { action: 'inbox.unmatched' } })
    expect(audit).not.toBeNull()
  })
})

describe('the two manual outcomes', () => {
  it('markWrongContact suppresses by hand, with no inbound message', async () => {
    const { db, contact } = await sentWorld()
    await markWrongContact(db, contact.id, { suppressionSalt: SALT })
    const suppression = await db.suppression.findFirstOrThrow()
    expect(suppression.reasonCode).toBe('wrong_contact')
    const row = await db.contact.findUniqueOrThrow({ where: { id: contact.id }, select: { status: true } })
    expect(row.status).toBe('suppressed')
  })

  it('pauseLead records user_paused, which the gate reads', async () => {
    const { db, lead } = await sentWorld()
    await pauseLead(db, lead.id, { note: 'operator is rethinking this company' })
    const row = await db.lead.findUniqueOrThrow({ where: { id: lead.id }, select: { statusReason: true } })
    expect(row.statusReason).toBe('user_paused')
  })
})
