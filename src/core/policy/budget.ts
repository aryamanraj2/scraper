import type { Db } from '../audit/audit-log.js'

export type BudgetVerdict =
  | { allowed: true }
  | { allowed: false; scope: 'company' | 'global' | 'global_vendor' | 'billed_usd' }

/**
 * What one request costs, across the three things worth bounding separately.
 *
 * `credits` is every research unit, free or paid — the number Part G's "cap zero ->
 * all research no-ops" reads. `vendorCredits` is the subset that is money.
 * `billedUsd` is direct currency spend, which no caller has yet and which a
 * per-lookup contact provider will.
 */
export type BudgetSpend = {
  credits: number
  vendorCredits?: number
  billedUsd?: number
}

function normalizeSpend(spend: number | BudgetSpend): Required<BudgetSpend> {
  if (typeof spend === 'number') return { credits: spend, vendorCredits: 0, billedUsd: 0 }
  return {
    credits: spend.credits,
    vendorCredits: spend.vendorCredits ?? 0,
    billedUsd: spend.billedUsd ?? 0,
  }
}

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
 *
 * ## Three ceilings, not one *(F5 §4.3)*
 *
 * F2 §4.7 made one credit unit cover a free static fetch and a paid Firecrawl scrape
 * alike, so that "cap zero -> all research no-ops" would be true of the whole research
 * path rather than only its billed half. F3 §4.10 split the COUNTERS but deliberately
 * not the caps, for the same reason.
 *
 * Then it was measured. A 1,975-company ingest spent the entire 1,000-credit global
 * envelope — an envelope the operator had sized to Firecrawl's free tier — on free
 * static fetches in about an hour, and every gated fetch for the following fifty
 * minutes returned `budget_exhausted` while the run kept going. The cap did not
 * protect the thing it was named after, and it stopped the thing it was not meant to
 * stop. It is at 50,000 now purely as a workaround.
 *
 * So `creditsCap` keeps its job — every unit, free or paid, which keeps the no-op test
 * honest — and the paid subset gets its own ceiling. A vendor cap is read only from
 * the GLOBAL envelope, because a paid monthly allowance is a global resource; the
 * per-company row keeps `vendorCreditsSpent` for attribution and nothing else.
 *
 * `billedUsdCap` was decorative: the column existed on every row since F0 and nothing
 * ever read it. It is enforced here now, at both scopes, before the first
 * per-lookup billed provider arrives rather than after it has run unbounded.
 *
 * ## A zero-cost request is never refused
 *
 * A send is not research. It passes through this gate because `FetchPolicyGate` is
 * the only path to the network, not because it consumes an allowance — so it declares
 * a zero spend, and a zero spend short-circuits before any row is read. Without that,
 * an exhausted research cap could abort an approved message, and the refusal would
 * carry `budget_exhausted` — which is not an F5 reason code, is not something the send
 * gate's nine conditions contemplate, and would be a research accounting decision
 * silently overriding a human approval.
 */
export async function checkBudget(
  db: Db,
  companyId: string | null,
  spend: number | BudgetSpend = 1,
  now = new Date(),
): Promise<BudgetVerdict> {
  const { credits, vendorCredits, billedUsd } = normalizeSpend(spend)
  if (credits === 0 && vendorCredits === 0 && billedUsd === 0) return { allowed: true }

  const periodMonth = currentPeriodMonth(now)

  const global = await db.researchBudget.findFirst({
    where: { companyId: null, periodMonth },
  })
  if (global) {
    if (global.creditsSpent + credits > global.creditsCap) {
      return { allowed: false, scope: 'global' }
    }
    if (vendorCredits > 0 && global.vendorCreditsSpent + vendorCredits > global.vendorCreditsCap) {
      return { allowed: false, scope: 'global_vendor' }
    }
    if (billedUsd > 0 && Number(global.billedUsdSpent) + billedUsd > Number(global.billedUsdCap)) {
      return { allowed: false, scope: 'billed_usd' }
    }
  }

  if (companyId) {
    const perCompany = await db.researchBudget.findFirst({ where: { companyId, periodMonth } })
    if (perCompany) {
      if (perCompany.creditsSpent + credits > perCompany.creditsCap) {
        return { allowed: false, scope: 'company' }
      }
      // Decimal compared as a double: the caps are six-decimal USD figures well
      // inside exact double range, and this is a ceiling test rather than ledger
      // arithmetic. The stored counter itself stays Decimal.
      if (billedUsd > 0 && Number(perCompany.billedUsdSpent) + billedUsd > Number(perCompany.billedUsdCap)) {
        return { allowed: false, scope: 'billed_usd' }
      }
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
  spend: number | BudgetSpend,
  now = new Date(),
): Promise<void> {
  const { credits, vendorCredits, billedUsd } = normalizeSpend(spend)
  // Symmetry with `checkBudget`: a request that was never bounded is not charged
  // either, so a send does not leave a 0-credit row-touch behind on every envelope.
  if (credits === 0 && vendorCredits === 0 && billedUsd === 0) return

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
