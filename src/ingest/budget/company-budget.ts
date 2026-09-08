import type { Db } from '../../core/audit/audit-log.js'
import { currentPeriodMonth } from '../../core/policy/budget.js'

/**
 * Per-company research allowance (A12, H5).
 *
 * ## Where budget seeding lives, and why here (F1 handover §10 question 3)
 *
 * `checkBudget` only refuses when a row EXISTS and is over cap — no row means no
 * ceiling. So a budget that is created lazily "on first research" (F2) does not
 * bound the first research; it bounds the second. Creating it at ingestion means
 * the cap is in place before anything is ever spent against the company.
 *
 * Ingestion is also the only moment that knows the answer H5 needs. H5 gives India
 * a higher per-company allowance because no India-native ATS exposes a public feed
 * (B7), so those companies need more per-company page research to reach the same
 * evidence. Country comes from the seed record; asking F2 to re-derive it later is
 * strictly more work for a worse answer.
 *
 * Budgets are per `periodMonth`, so this helper is idempotent and re-callable: F2
 * calls it at the start of each refresh to open the current month's envelope,
 * which is the same operation, not a different one.
 */

/**
 * Credits are Firecrawl-equivalent units: one plain page fetch is 1, and B6a's
 * JSON-extraction mode is roughly 5. The numbers are a starting envelope, not a
 * measurement — their job is to make spend bounded and visible so F2 can replace
 * them with observed figures.
 */
export const DEFAULT_COMPANY_CREDITS_CAP = 20

/** H5: India costs more research per company because no India-native ATS has a feed (B7). */
export const INDIA_COMPANY_CREDITS_CAP = 45

/**
 * Matched against the country strings yc-oss actually writes, which are the last
 * comma-separated segment of a location — "India", and the spellings that appear
 * alongside it. Deliberately not a general country normalizer: F2 owns that, and
 * a wrong match here only mis-sizes an envelope, never mis-routes a message.
 */
const INDIA_COUNTRY_NAMES = new Set(['india', 'republic of india'])

export function isIndiaCompany(countries: readonly string[]): boolean {
  return countries.some((c) => INDIA_COUNTRY_NAMES.has(c.trim().toLowerCase()))
}

export function creditsCapFor(countries: readonly string[]): number {
  return isIndiaCompany(countries) ? INDIA_COMPANY_CREDITS_CAP : DEFAULT_COMPANY_CREDITS_CAP
}

/**
 * Opens (or leaves alone) the company's envelope for the current month.
 *
 * An existing row is never overwritten: `creditsSpent` lives on it, and resetting
 * a cap mid-month would silently hand back budget that was already consumed.
 */
export async function ensureCompanyResearchBudget(
  db: Db,
  companyId: string,
  countries: readonly string[],
  now = new Date(),
): Promise<{ created: boolean; creditsCap: number }> {
  const periodMonth = currentPeriodMonth(now)
  const existing = await db.researchBudget.findFirst({ where: { companyId, periodMonth } })
  if (existing) return { created: false, creditsCap: existing.creditsCap }

  const creditsCap = creditsCapFor(countries)
  await db.researchBudget.create({
    data: {
      companyId,
      periodMonth,
      creditsCap,
      // The billed envelope is the Claude API line (Part E). F1 spends nothing
      // against it — F0's deviation §4.9 made the LLM the operator's own session —
      // so it opens at zero and F2 raises it deliberately when it has a number.
      billedUsdCap: 0,
    },
  })
  return { created: true, creditsCap }
}
