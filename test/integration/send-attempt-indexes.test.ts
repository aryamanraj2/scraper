import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeTestDb, testDb, truncateAll } from '../helpers/db.js'

beforeEach(async () => truncateAll())
afterAll(async () => closeTestDb())

async function fixture(opts: { contacts: number }) {
  const db = testDb()
  const company = await db.company.create({
    data: { canonicalDomain: 'example.com', displayName: 'Example' },
  })
  const evidence = await db.evidence.create({
    data: {
      companyId: company.id,
      sourceUrl: 'https://example.com/careers',
      sourceType: 'company_page',
      excerpt: 'Careers page.',
      contentHash: 'h',
      observedAt: new Date(),
      confidence: 1,
      fetchedVia: 'static_fetch',
    },
  })
  const contacts = []
  for (let i = 0; i < opts.contacts; i++) {
    contacts.push(
      await db.contact.create({
        data: {
          companyId: company.id,
          emailNormalized: `careers+${i}@example.com`,
          contactType: 'careers_alias',
          evidenceId: evidence.id,
          capturedAt: new Date(),
        },
      }),
    )
  }
  const scoreVersion = await db.scoreVersion.create({
    data: { label: 'v1', weights: {}, thresholds: {}, maxRiskDeduction: 40 },
  })
  const drafts = []
  for (const track of ['ios_android', 'ai_engineer', 'sde', 'swe'] as const) {
    const lead = await db.lead.create({
      data: {
        companyId: company.id,
        leadKind: 'speculative',
        primaryTrack: track,
        primaryTrackReason: 'test fixture',
        campaignCycle: '2026-Q1',
        scoreVersionId: scoreVersion.id,
      },
    })
    drafts.push(await db.draft.create({ data: { leadId: lead.id } }))
  }
  return { company, contacts, drafts }
}

/**
 * A2 / D3. The handover keyed first-touch uniqueness on
 * (company_id, role_track, campaign_cycle), which with four role tracks lets one
 * careers@ alias legitimately receive four first-touch emails per cycle — exactly
 * what the document exists to prevent, enforced by a constraint that makes it look
 * deliberate.
 *
 * These are PARTIAL unique indexes and cannot be expressed in schema.prisma, so
 * this test is the only thing standing between the hand-written migration and a
 * silent regression.
 */
describe('first-touch uniqueness (A2, D3)', () => {
  it('four qualified leads on one alias yield ONE send, three duplicates', async () => {
    const db = testDb()
    const { company, contacts, drafts } = await fixture({ contacts: 1 })
    const contact = contacts[0]!

    const results: Array<'sent' | 'duplicate_contact'> = []
    for (const [i, draft] of drafts.entries()) {
      try {
        await db.sendAttempt.create({
          data: {
            draftId: draft.id,
            contactId: contact.id,
            companyId: company.id,
            campaignCycle: '2026-Q1',
            touchNumber: 1,
            idempotencyKey: `key-${i}`,
            rfc822MessageId: `<msg-${i}@owned.example>`,
            status: 'in_flight',
          },
        })
        results.push('sent')
      } catch {
        results.push('duplicate_contact')
      }
    }

    expect(results.filter((r) => r === 'sent')).toHaveLength(1)
    expect(results.filter((r) => r === 'duplicate_contact')).toHaveLength(3)
    expect(await db.sendAttempt.count()).toBe(1)
  })

  it('two published aliases at one company still yield one touch (company cooldown)', async () => {
    const db = testDb()
    const { company, contacts, drafts } = await fixture({ contacts: 2 })

    await db.sendAttempt.create({
      data: {
        draftId: drafts[0]!.id,
        contactId: contacts[0]!.id,
        companyId: company.id,
        campaignCycle: '2026-Q1',
        touchNumber: 1,
        idempotencyKey: 'k1',
        rfc822MessageId: '<m1@owned.example>',
        status: 'in_flight',
      },
    })

    await expect(
      db.sendAttempt.create({
        data: {
          draftId: drafts[1]!.id,
          contactId: contacts[1]!.id,
          companyId: company.id,
          campaignCycle: '2026-Q1',
          touchNumber: 1,
          idempotencyKey: 'k2',
          rfc822MessageId: '<m2@owned.example>',
          status: 'in_flight',
        },
      }),
    ).rejects.toThrow()
  })

  it('permits a follow-up, because the index is scoped to touch_number = 1', async () => {
    const db = testDb()
    const { company, contacts, drafts } = await fixture({ contacts: 1 })
    const common = {
      contactId: contacts[0]!.id,
      companyId: company.id,
      campaignCycle: '2026-Q1',
      status: 'sent' as const,
    }
    await db.sendAttempt.create({
      data: { ...common, draftId: drafts[0]!.id, touchNumber: 1, idempotencyKey: 'k1', rfc822MessageId: '<m1@owned.example>' },
    })
    await db.sendAttempt.create({
      data: { ...common, draftId: drafts[0]!.id, touchNumber: 2, idempotencyKey: 'k2', rfc822MessageId: '<m2@owned.example>' },
    })
    expect(await db.sendAttempt.count()).toBe(2)
  })

  it('permits a retry after an aborted attempt, because aborted is outside the index', async () => {
    const db = testDb()
    const { company, contacts, drafts } = await fixture({ contacts: 1 })
    const common = {
      contactId: contacts[0]!.id,
      companyId: company.id,
      campaignCycle: '2026-Q1',
      touchNumber: 1,
      draftId: drafts[0]!.id,
    }
    await db.sendAttempt.create({
      data: { ...common, idempotencyKey: 'k1', rfc822MessageId: '<m1@owned.example>', status: 'aborted' },
    })
    await db.sendAttempt.create({
      data: { ...common, idempotencyKey: 'k2', rfc822MessageId: '<m2@owned.example>', status: 'in_flight' },
    })
    expect(await db.sendAttempt.count()).toBe(2)
  })

  it('permits the next campaign cycle', async () => {
    const db = testDb()
    const { company, contacts, drafts } = await fixture({ contacts: 1 })
    const common = {
      contactId: contacts[0]!.id,
      companyId: company.id,
      touchNumber: 1,
      draftId: drafts[0]!.id,
      status: 'sent' as const,
    }
    await db.sendAttempt.create({
      data: { ...common, campaignCycle: '2026-Q1', idempotencyKey: 'k1', rfc822MessageId: '<m1@owned.example>' },
    })
    await db.sendAttempt.create({
      data: { ...common, campaignCycle: '2026-Q2', idempotencyKey: 'k2', rfc822MessageId: '<m2@owned.example>' },
    })
    expect(await db.sendAttempt.count()).toBe(2)
  })

  it('keeps the deterministic Message-ID unique, which the A9 reconciliation depends on', async () => {
    const db = testDb()
    const { company, contacts, drafts } = await fixture({ contacts: 1 })
    const common = {
      contactId: contacts[0]!.id,
      companyId: company.id,
      draftId: drafts[0]!.id,
      campaignCycle: '2026-Q1',
    }
    await db.sendAttempt.create({
      data: { ...common, touchNumber: 1, idempotencyKey: 'k1', rfc822MessageId: '<dup@owned.example>', status: 'sent' },
    })
    await expect(
      db.sendAttempt.create({
        data: { ...common, touchNumber: 2, idempotencyKey: 'k2', rfc822MessageId: '<dup@owned.example>', status: 'in_flight' },
      }),
    ).rejects.toThrow()
  })

  it('has both partial indexes present in the database', async () => {
    const db = testDb()
    const rows = await db.$queryRawUnsafe<Array<{ indexname: string }>>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'send_attempt' AND indexdef ILIKE '%WHERE%'
       ORDER BY indexname`,
    )
    expect(rows.map((r) => r.indexname)).toEqual([
      'one_first_touch_per_company_per_cycle',
      'one_first_touch_per_contact_per_cycle',
    ])
  })
})
