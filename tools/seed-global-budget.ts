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
 *   npm run seed:budget                 # 1,000 credits for the current month
 *   npm run seed:budget -- --credits 10000
 *
 * The default matches Firecrawl's free tier (B6a). Raise it to 10,000 when the
 * student credits land. An existing row for the month is never overwritten:
 * `creditsSpent` lives on it, and resetting a cap mid-month hands back budget that
 * was already consumed.
 */
import 'dotenv/config'
import { prisma, disconnectPrisma } from '../src/core/db/client.js'
import { currentPeriodMonth } from '../src/core/policy/budget.js'

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const credits = Number(flag('credits') ?? 1000)
const periodMonth = flag('month') ?? currentPeriodMonth()
const db = prisma()

const existing = await db.researchBudget.findFirst({ where: { companyId: null, periodMonth } })
if (existing) {
  console.log(
    `Global envelope for ${periodMonth} already exists: ${existing.creditsSpent}/${existing.creditsCap} credits spent. Left alone.`,
  )
} else {
  await db.researchBudget.create({
    data: { companyId: null, periodMonth, creditsCap: credits, billedUsdCap: 0 },
  })
  console.log(`Global envelope for ${periodMonth} opened at ${credits} credits.`)
}

await disconnectPrisma()
