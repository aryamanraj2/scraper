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

export async function recordSpend(
  db: Db,
  companyId: string | null,
  credits: number,
  billedUsd = 0,
  now = new Date(),
): Promise<void> {
  const periodMonth = currentPeriodMonth(now)
  const existing = await db.researchBudget.findFirst({ where: { companyId, periodMonth } })
  if (!existing) return
  await db.researchBudget.update({
    where: { id: existing.id },
    data: {
      creditsSpent: { increment: credits },
      billedUsdSpent: { increment: billedUsd },
    },
  })
}
