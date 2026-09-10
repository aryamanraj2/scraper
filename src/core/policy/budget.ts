import type { Db } from '../audit/audit-log.js'

export type BudgetVerdict = { allowed: true } | { allowed: false; scope: 'company' | 'global' }

export function currentPeriodMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * D4 preflight step 5 and A12.
 *
 * Both envelopes must have headroom: the company's own research budget and the
 * global monthly cap. H5 gives India a higher per-company allowance than US/EU,
 * because no India-native ATS exposes a public feed (B7) and those leads genuinely
 * cost more research per company — that allowance is a per-company `creditsCap`
 * value, not a special case in this code.
 *
 * The global envelope is the row with a null companyId.
 */
export async function checkBudget(
  db: Db,
  companyId: string | null,
  cost = 1,
  now = new Date(),
): Promise<BudgetVerdict> {
  const periodMonth = currentPeriodMonth(now)

  const global = await db.researchBudget.findFirst({
    where: { companyId: null, periodMonth },
  })
  if (global && global.creditsSpent + cost > global.creditsCap) {
    return { allowed: false, scope: 'global' }
  }

  if (companyId) {
    const perCompany = await db.researchBudget.findFirst({ where: { companyId, periodMonth } })
    if (perCompany && perCompany.creditsSpent + cost > perCompany.creditsCap) {
      return { allowed: false, scope: 'company' }
    }
  }
  return { allowed: true }
}

/**
 * Charges a research unit against every envelope that governs it.
 *
 * ## The bug this replaces *(latent F2 defect, F3 was the first to look)*
 *
 * The previous implementation charged only the row matching the caller's
 * `companyId`. `checkBudget` reads the global envelope (the `companyId = null` row)
 * on every call, so the two disagreed: after F2's live backfill the 150 per-company
 * rows summed to **1,015 credits spent** while the global row still read **0 of
 * 1,000**. The global ceiling was enforced against a counter nothing incremented —
 * a cap that could never be reached is not a cap, and A12's whole reason for the
 * table is that spend is "visible and bounded rather than discovered on an invoice".
 *
 * A company-scoped spend is therefore charged to **both** the company row and the
 * global row. A spend with no company (`companyId === null`) is charged once, to the
 * global row, rather than twice.
 *
 * ## Why `vendorCredits` is separate
 *
 * F2 §4.7: one credit unit covers a free static fetch and a paid Firecrawl scrape
 * alike, which is what makes Part G's "cap zero -> all research no-ops" true of the
 * whole research path. The cost of that is a counter that cannot answer "how much of
 * the paid allowance is left". `vendorCredits` is the paid subset, counted alongside
 * rather than instead — there is still exactly one ceiling.
 *
 * A missing row is still not created here. F1 §4.2 seeds per-company envelopes at
 * ingestion and `seed:budget` opens the global one; creating a row on first spend
 * would mean the first spend was never bounded, which is the failure that reasoning
 * exists to prevent.
 */
export async function recordSpend(
  db: Db,
  companyId: string | null,
  credits: number,
  billedUsd = 0,
  now = new Date(),
  vendorCredits = 0,
): Promise<void> {
  const periodMonth = currentPeriodMonth(now)
  const data = {
    creditsSpent: { increment: credits },
    vendorCreditsSpent: { increment: vendorCredits },
    billedUsdSpent: { increment: billedUsd },
  }

  // An OR rather than `in: [companyId, null]`: SQL `IN (NULL)` never matches, so the
  // shorter spelling would silently skip the global row and reintroduce the bug.
  // Deduplicated by id, so a caller cannot be charged twice for one unit.
  const rows = await db.researchBudget.findMany({
    where: {
      periodMonth,
      OR: companyId === null ? [{ companyId: null }] : [{ companyId }, { companyId: null }],
    },
    select: { id: true },
  })
  for (const row of rows) {
    await db.researchBudget.update({ where: { id: row.id }, data })
  }
}
