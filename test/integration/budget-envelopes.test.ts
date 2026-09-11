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

async function envelopes(cap: {
  global: number
  company: number
  globalVendor?: number
  billedUsd?: number
}) {
  const db = testDb()
  const company = await db.company.create({
    data: { canonicalDomain: 'spend.example', displayName: 'Spend Co', countries: [], locations: [], tags: [] },
    select: { id: true },
  })
  await db.researchBudget.create({
    data: {
      companyId: null,
      periodMonth: PERIOD,
      creditsCap: cap.global,
      vendorCreditsCap: cap.globalVendor ?? 0,
      billedUsdCap: cap.billedUsd ?? 0,
    },
  })
  await db.researchBudget.create({
    data: {
      companyId: company.id,
      periodMonth: PERIOD,
      creditsCap: cap.company,
      billedUsdCap: cap.billedUsd ?? 0,
    },
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
    await recordSpend(db, companyId, { credits: 1, vendorCredits: 0 })
    // A Firecrawl scrape: one research unit, and one unit of a paid allowance.
    await recordSpend(db, companyId, { credits: 1, vendorCredits: 1 })

    const global = await globalRow(db)
    expect(global.creditsSpent).toBe(2)
    expect(global.vendorCreditsSpent).toBe(1)

    const company = await db.researchBudget.findFirstOrThrow({ where: { companyId, periodMonth: PERIOD } })
    expect(company.creditsSpent).toBe(2)
    expect(company.vendorCreditsSpent).toBe(1)
  })

  it('keeps creditsCap over everything, so a zero cap still no-ops the free tier too', async () => {
    // Part G's proving test is "cap zero -> all research no-ops with
    // budget_exhausted". F5 added a second ceiling for the PAID subset, and this is
    // the property that had to survive it: `creditsCap` still counts every unit, free
    // or paid, so a zero cap still stops the whole research path.
    const { db, companyId } = await envelopes({ global: 0, company: 0 })
    const verdict = await checkBudget(db, companyId, 1)
    expect(verdict.allowed).toBe(false)
  })
})

/**
 * F5 §4.3 — the split the F2 handover asked for, F3 half-did, and a live run proved
 * necessary.
 *
 * A 1,975-company ingest spent the whole 1,000-credit global envelope — sized to
 * Firecrawl's free tier — on free static fetches in about an hour, then returned
 * `budget_exhausted` for fifty minutes. One number bounding two unlike things bounded
 * neither honestly.
 */
describe('the paid subset has its own ceiling (F5 §4.3)', () => {
  it('refuses a vendor spend that exceeds the vendor cap, while free fetches continue', async () => {
    const { db, companyId } = await envelopes({ global: 10_000, company: 10_000, globalVendor: 1 })

    // One paid credit fits.
    expect((await checkBudget(db, companyId, { credits: 1, vendorCredits: 1 })).allowed).toBe(true)
    await recordSpend(db, companyId, { credits: 1, vendorCredits: 1 })

    // A second does not — the paid allowance is spent.
    const paid = await checkBudget(db, companyId, { credits: 1, vendorCredits: 1 })
    expect(paid.allowed).toBe(false)
    if (paid.allowed) throw new Error('unreachable')
    expect(paid.scope).toBe('global_vendor')

    // ...and this is the whole point: the free path is unaffected.
    expect((await checkBudget(db, companyId, { credits: 1 })).allowed).toBe(true)
  })

  it('reads the vendor cap from the global envelope only', async () => {
    // A paid monthly allowance is a global resource. The per-company row keeps
    // vendorCreditsSpent for attribution and is never a second paid ceiling.
    const { db, companyId } = await envelopes({ global: 10_000, company: 10_000, globalVendor: 5 })
    expect((await checkBudget(db, companyId, { credits: 1, vendorCredits: 3 })).allowed).toBe(true)
  })

  it('enforces billedUsdCap, which was decorative before F5', async () => {
    const { db, companyId } = await envelopes({ global: 10_000, company: 10_000, billedUsd: 0.5 })
    expect((await checkBudget(db, companyId, { credits: 0, billedUsd: 0.25 })).allowed).toBe(true)
    const over = await checkBudget(db, companyId, { credits: 0, billedUsd: 0.75 })
    expect(over.allowed).toBe(false)
    if (over.allowed) throw new Error('unreachable')
    expect(over.scope).toBe('billed_usd')
  })

  it('a zero cap on every axis still refuses a one-credit fetch', async () => {
    const { db, companyId } = await envelopes({ global: 0, company: 0, globalVendor: 0, billedUsd: 0 })
    expect((await checkBudget(db, companyId, { credits: 1 })).allowed).toBe(false)
  })
})

/**
 * The property that keeps a research cap from aborting an approved message.
 *
 * The mail transport goes through `FetchPolicyGate` because that is the only path to
 * the network, not because it consumes a research allowance. If an exhausted envelope
 * could refuse it, a human approval would be overridden by accounting — and the
 * refusal would carry `budget_exhausted`, which is not an F5 reason code and is not
 * one of D6's nine conditions.
 */
describe('a zero-cost request is outside the budget entirely', () => {
  it('is allowed even when every envelope is exhausted', async () => {
    const { db, companyId } = await envelopes({ global: 0, company: 0, globalVendor: 0, billedUsd: 0 })
    await recordSpend(db, companyId, { credits: 0 })
    expect((await checkBudget(db, companyId, { credits: 0 })).allowed).toBe(true)
    expect((await checkBudget(db, null, { credits: 0 })).allowed).toBe(true)
  })

  it('is not charged, so it leaves no trace on any counter', async () => {
    const { db, companyId } = await envelopes({ global: 100, company: 100 })
    await recordSpend(db, companyId, { credits: 0, vendorCredits: 0, billedUsd: 0 })
    const global = await globalRow(db)
    expect(global.creditsSpent).toBe(0)
    expect(global.vendorCreditsSpent).toBe(0)
  })
})
