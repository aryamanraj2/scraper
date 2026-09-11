import type { PrismaClient } from '../../generated/prisma/client.js'
import { seedApprovedClaims } from '../../src/apply/claims/seed-claims.js'
import { seedCandidateProfile } from '../../src/apply/claims/seed-profile.js'
import { approveDraft } from '../../src/outreach/draft/approve.js'
import type { SendGateOptions } from '../../src/outreach/send/gate.js'

/**
 * An approved draft addressed to an owned inbox — the world every send-gate scenario
 * starts from, so each test can vary the one fact it is about.
 *
 * The composition is built directly rather than driven through the LLM handoff. That
 * chain belongs to F4 and is exercised in `test/policy/outreach-draft.test.ts`; what
 * matters here is that the **real** `approveDraft` computed and froze the hash over
 * these exact rows, because D6 condition 1 recomputes it from them.
 */

export const SEND_TEST_SALT = 'test-suppression-salt'
export const OWNED_INBOX = 'owner@owned.example'
export const SENDING_ACCOUNT = 'aryamanj250@gmail.com'

export function sendGateOptions(over: Partial<SendGateOptions> = {}): SendGateOptions {
  return {
    // Pinned rather than defaulted. These tests must keep passing as the build stage
    // moves on (F2 §4.9), and a gate whose first condition is the stage cannot be
    // honestly tested against whatever the stage happens to be today.
    stage: 'F5',
    envFlag: true,
    ownedInboxes: [OWNED_INBOX],
    externalRecipientsEnabled: false,
    sendingAccount: SENDING_ACCOUNT,
    messageIdDomain: 'owned.example',
    suppressionSalt: SEND_TEST_SALT,
    ...over,
  }
}

export type SendWorldOpts = {
  contactEmail?: string
  domain?: string
  campaignCycle?: string
  evidenceObservedAt?: Date
  teamSize?: number
  touchSlot?: number
  /** Skip the CandidateProfile, so D6 condition 3 is the thing being tested. */
  withProfile?: boolean
}

export type SendWorld = {
  db: PrismaClient
  draftId: string
  leadId: string
  contactId: string
  companyId: string
  evidenceId: string
  campaignCycle: string
}

export async function makeSendWorld(
  db: PrismaClient,
  opts: SendWorldOpts = {},
): Promise<SendWorld> {
  const domain = opts.domain ?? 'acme.example'
  const campaignCycle = opts.campaignCycle ?? '2026-Q3'

  await seedApprovedClaims(db)
  if (opts.withProfile !== false) await seedCandidateProfile(db, { sendingAccount: SENDING_ACCOUNT })

  const claim = await db.approvedClaim.findFirstOrThrow({
    where: { isActive: true },
    select: { id: true, text: true },
  })

  // One resume per world, reused when a scenario builds a second company.
  const resume =
    (await db.resumeVersion.findFirst({ select: { id: true } })) ??
    (await db.resumeVersion.create({
      data: {
        label: 'SDE — backend / systems',
        trackKey: 'sde',
        linkUrl: 'https://aryamanj.in/resume/backend.pdf',
        filePath: '/r.pdf',
        fileSha256: 'a'.repeat(64),
      },
      select: { id: true },
    }))

  const company = await db.company.create({
    data: {
      canonicalDomain: domain,
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
      sourceUrl: `https://${domain}/careers`,
      sourceType: 'company_page',
      excerpt: 'Our platform team writes Go and runs Postgres at scale in Bengaluru.',
      contentHash: `h-${domain}`,
      observedAt: opts.evidenceObservedAt ?? new Date(),
      confidence: 0.8,
      fetchedVia: 'static_fetch',
    },
    select: { id: true },
  })
  const contact = await db.contact.create({
    data: {
      companyId: company.id,
      emailNormalized: opts.contactEmail ?? OWNED_INBOX,
      contactType: 'careers_alias',
      discoveryMethod: 'page_published',
      verified: true,
      evidenceId: evidence.id,
      capturedAt: new Date(),
    },
    select: { id: true },
  })

  const scoreVersion =
    (await db.scoreVersion.findFirst({ select: { id: true } })) ??
    (await db.scoreVersion.create({
      data: { label: 'f2-v1', weights: {}, thresholds: {}, maxRiskDeduction: 40 },
      select: { id: true },
    }))

  const lead = await db.lead.create({
    data: {
      companyId: company.id,
      contactId: contact.id,
      leadKind: 'speculative',
      primaryTrack: 'sde',
      primaryTrackReason: 'fixture',
      campaignCycle,
      status: 'qualified',
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
      touchSlot: opts.touchSlot ?? 0,
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

  // A draft with no profile cannot be approved — F5 made `senderIdentity` a stored
  // property of the approval — so the identity is supplied explicitly in that case.
  const approved = await approveDraft(db, draft.id, 'operator', {
    ...(opts.withProfile === false ? { senderIdentity: `Tester <${SENDING_ACCOUNT}>` } : {}),
  })
  if (!approved.ok) throw new Error(`approve failed: ${approved.reason} ${approved.detail}`)

  return {
    db,
    draftId: draft.id,
    leadId: lead.id,
    contactId: contact.id,
    companyId: company.id,
    evidenceId: evidence.id,
    campaignCycle,
  }
}
