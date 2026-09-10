import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeTestDb, testDb, truncateAll } from '../helpers/db.js'
import { checkBudget, currentPeriodMonth, recordSpend } from '../../src/core/policy/budget.js'

/**
 * Regression cover for a **latent F2 defect F3 was the first to look at**.
 *
 * `checkBudget` reads the global envelope (the `ResearchBudget` row with a null
 * `companyId`) on every call, but `recordSpend` only ever incremented the row matching
 * the caller's `companyId`. After F2's live backfill the 150 per-company rows summed
 * to 1,015 credits spent while the global row still read 0 of 1,000: the ceiling was
 * enforced against a counter nothing incremented, so it could never be reached.
 *
 * A12 exists to make spend "visible and bounded rather than discovered on an invoice".
 * A cap that cannot be hit does neither.
 */

beforeEach(async () => truncateAll())
afterAll(async () => closeTestDb())

const PERIOD = currentPeriodMonth()

async function envelopes(cap: { global: number; company: number }) {
  const db = testDb()
  const company = await db.company.create({
    data: { canonicalDomain: 'spend.example', displayName: 'Spend Co', countries: [], locations: [], tags: [] },
    select: { id: true },
  })
  await db.researchBudget.create({
    data: { companyId: null, periodMonth: PERIOD, creditsCap: cap.global, billedUsdCap: 0 },
  })
  await db.researchBudget.create({
    data: { companyId: company.id, periodMonth: PERIOD, creditsCap: cap.company, billedUsdCap: 0 },
  })
  return { db, companyId: company.id }
}

const globalRow = async (db: ReturnType<typeof testDb>) =>
  db.researchBudget.findFirstOrThrow({ where: { companyId: null, periodMonth: PERIOD } })

describe('recordSpend charges every envelope that governs a request', () => {
  it('charges the global envelope for a company-scoped spend', async () => {
    const { db, companyId } = await envelopes({ global: 1000, company: 20 })
    await recordSpend(db, companyId, 1)

    const company = await db.researchBudget.findFirstOrThrow({ where: { companyId, periodMonth: PERIOD } })
    expect(company.creditsSpent).toBe(1)
    // The bug: this used to stay at 0 forever.
    expect((await globalRow(db)).creditsSpent).toBe(1)
  })

  it('charges the global envelope once, not twice, for a spend with no company', async () => {
    const { db } = await envelopes({ global: 1000, company: 20 })
    await recordSpend(db, null, 3)
    expect((await globalRow(db)).creditsSpent).toBe(3)
  })

  it('makes the global cap actually reachable', async () => {
    const { db, companyId } = await envelopes({ global: 3, company: 100 })
    for (let i = 0; i < 3; i += 1) await recordSpend(db, companyId, 1)

    const verdict = await checkBudget(db, companyId, 1)
    expect(verdict.allowed).toBe(false)
    if (verdict.allowed) throw new Error('unreachable')
    // The company still has 97 credits of its own headroom; the global envelope is
    // what refuses. Before the fix this returned allowed:true indefinitely.
    expect(verdict.scope).toBe('global')
  })

  it('still refuses on the company envelope when that is the binding one', async () => {
    const { db, companyId } = await envelopes({ global: 1000, company: 2 })
    await recordSpend(db, companyId, 2)
    const verdict = await checkBudget(db, companyId, 1)
    expect(verdict.allowed).toBe(false)
    if (verdict.allowed) throw new Error('unreachable')
    expect(verdict.scope).toBe('company')
  })

  it('does not create an envelope that does not exist', async () => {
    // F1 §4.2: a budget created lazily on first spend does not bound the first spend.
    // Seeding happens at ingestion; this must stay a no-op rather than quietly
    // inventing a ceiling after the fact.
    const db = testDb()
    await recordSpend(db, null, 5)
    expect(await db.researchBudget.count()).toBe(0)
  })
})

describe('the vendor-credit split (F2 §4.7)', () => {
  it('counts paid credits alongside the unified counter, not instead of it', async () => {
    const { db, companyId } = await envelopes({ global: 1000, company: 20 })
    // A free static fetch.
    await recordSpend(db, companyId, 1, 0, new Date(), 0)
    // A Firecrawl scrape: one research unit, and one unit of a paid allowance.
    await recordSpend(db, companyId, 1, 0, new Date(), 1)

    const global = await globalRow(db)
    expect(global.creditsSpent).toBe(2)
    expect(global.vendorCreditsSpent).toBe(1)

    const company = await db.researchBudget.findFirstOrThrow({ where: { companyId, periodMonth: PERIOD } })
    expect(company.creditsSpent).toBe(2)
    expect(company.vendorCreditsSpent).toBe(1)
  })

  it('keeps one ceiling, so a zero cap still no-ops the free tier too', async () => {
    // Part G's proving test is "cap zero -> all research no-ops with
    // budget_exhausted". That only holds while the free half is metered by the same
    // counter the cap reads, which is why vendorCreditsSpent is not a second cap.
    const { db, companyId } = await envelopes({ global: 0, company: 0 })
    const verdict = await checkBudget(db, companyId, 1)
    expect(verdict.allowed).toBe(false)
  })
})
