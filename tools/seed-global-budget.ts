#!/usr/bin/env tsx
/**
 * Opens the global monthly research envelope — the `ResearchBudget` row with a null
 * `companyId` (F0 deviation §4.3).
 *
 * A12 asks for a monthly cap that makes spend "visible and bounded rather than
 * discovered on an invoice". Without this row `checkBudget` has nothing to refuse
 * against globally: per-company caps bound each company, but nothing bounds their
 * sum.
 *
 *   npm run seed:budget                          # open the month's envelope
 *   npm run seed:budget -- --credits 100000
 *   npm run seed:budget -- --vendor-credits 1000 # raise the PAID ceiling only
 *
 * ## Two ceilings as of F5 (§4.3)
 *
 * `--credits` bounds **every** research unit, free or paid. It is what makes Part G's
 * "cap zero -> all research no-ops" true of the whole path, and it is sized to
 * "how much work should this system do in a month", not to anybody's invoice. The
 * default is deliberately large: a 1,975-company ingest costs ~2,000 free static
 * fetches, and the old 1,000 default — which was sized to Firecrawl's free tier —
 * stopped such a run dead after an hour.
 *
 * `--vendor-credits` bounds only the subset that is money (Firecrawl today). It
 * defaults to **0**, meaning no paid vendor spend is authorised, which is the truthful
 * state until an allowance is actually bought. Raising it is the deliberate act of
 * saying "I have paid for this many credits this month".
 *
 * An existing row for the month is never silently overwritten: `creditsSpent` lives on
 * it, and resetting a cap mid-month hands back budget that was already consumed. A cap
 * can still be RAISED in place with `--raise`, which is the operation an operator
 * actually needs mid-month and which cannot hand back anything.
 */
import 'dotenv/config'
import { prisma, disconnectPrisma } from '../src/core/db/client.js'
import { currentPeriodMonth } from '../src/core/policy/budget.js'

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}
const has = (name: string) => process.argv.includes(`--${name}`)

const credits = Number(flag('credits') ?? 100_000)
const vendorCredits = Number(flag('vendor-credits') ?? 0)
const periodMonth = flag('month') ?? currentPeriodMonth()
const db = prisma()

const existing = await db.researchBudget.findFirst({ where: { companyId: null, periodMonth } })
if (existing && !has('raise')) {
  console.log(
    `Global envelope for ${periodMonth} already exists: ` +
      `${existing.creditsSpent}/${existing.creditsCap} credits, ` +
      `${existing.vendorCreditsSpent}/${existing.vendorCreditsCap} of them paid. Left alone.`,
  )
  console.log('Use --raise to lift a cap in place (a raise cannot hand back spent budget).')
} else if (existing) {
  // A raise only ever moves a ceiling upward. Lowering it would not return spend
  // either, but it would silently refuse work an operator had already authorised.
  const nextCredits = Math.max(existing.creditsCap, credits)
  const nextVendor = Math.max(existing.vendorCreditsCap, vendorCredits)
  await db.researchBudget.update({
    where: { id: existing.id },
    data: { creditsCap: nextCredits, vendorCreditsCap: nextVendor },
  })
  console.log(
    `Global envelope for ${periodMonth} raised to ${nextCredits} credits ` +
      `(${nextVendor} of them paid). Spent: ${existing.creditsSpent}/${existing.vendorCreditsSpent}.`,
  )
} else {
  await db.researchBudget.create({
    data: {
      companyId: null,
      periodMonth,
      creditsCap: credits,
      vendorCreditsCap: vendorCredits,
      billedUsdCap: 0,
    },
  })
  console.log(
    `Global envelope for ${periodMonth} opened at ${credits} credits, ` +
      `${vendorCredits} of them paid.`,
  )
}

await disconnectPrisma()
