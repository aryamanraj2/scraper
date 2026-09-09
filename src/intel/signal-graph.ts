import type { Db } from '../core/audit/audit-log.js'
import { checkBudget } from '../core/policy/budget.js'
import { RESEARCH_ACTIONS } from './research/actions.js'

/**
 * `SignalGraphService` — what to do next for one company, and nothing more.
 *
 * ## The ordering is a hard floor, not a heuristic
 *
 * D4 lists five source tiers and says the ordering is a floor: *"a browser task can
 * never be chosen while an unread ATS feed exists. Cost and expected value are
 * inputs to the choice WITHIN a tier, never a way around the ordering."*
 *
 * This module implements that literally. Tiers are evaluated in order and the
 * first tier with an available action wins, whatever a cost model would have said.
 * Expected value only ever orders candidates inside one tier — which is why the
 * candidate list is built per tier and sorted there, rather than pooled and ranked
 * globally. A single global ranking with a cost term is exactly how a cheap
 * structured feed loses to an expensive page fetch that happens to look promising.
 *
 * ## The tiers (D4)
 *
 *   1. Official/public structured feed — the YC seed index and the three ATS
 *      adapters. Free, replayable, employer-published.
 *   2. Static fetch + Readability on a permitted employer page, behind the D4
 *      preflight.
 *   3. Firecrawl, only for pages that failed tier 2, inside B6a's credit budget.
 *   4. Browser research task — **deferred to F7**. This module never returns one;
 *      the case exists so the seam is visible and so a future milestone changes one
 *      function rather than the shape of every caller.
 *   5. User-supplied `LeadHint` — a hint, never a fetch (handover.md §7).
 *
 * ## Budget is a precondition, not a tier
 *
 * A company with no research headroom gets `budget_exhausted` before any tier is
 * considered. Part G's proving test is "cap zero → all research no-ops with
 * `budget_exhausted`", and a no-op that still picks an action and refuses later
 * would burn a preflight per company to reach the same answer.
 */

export type SourceTier = 1 | 2 | 3 | 4 | 5

export type NextAction =
  | { kind: 'read_ats_board'; tier: 1; boardToken: string; vendor: string; reason: string }
  | { kind: 'detect_ats'; tier: 1; url: string; reason: string }
  | { kind: 'static_fetch'; tier: 2; url: string; reason: string }
  | { kind: 'firecrawl_escalate'; tier: 3; url: string; reason: string }
  | { kind: 'browser_task'; tier: 4; url: string; reason: string }
  | { kind: 'none'; tier: null; reason: string; reasonCode?: 'budget_exhausted' }

export type SignalGraphOptions = {
  now?: Date
  /** A board read older than this is "unread" again. Weekly, per Part F's cadence. */
  boardRefreshDays?: number
  /** A page fetched more recently than this is not re-fetched. */
  pageRefreshDays?: number
  /**
   * How long a failed ATS detection stands before it is worth another attempt.
   * Longer than the page window on purpose: a company that publishes no board link
   * today is unlikely to publish one next week, and detection is the expensive half
   * of ingestion (one host per company at the per-host rate delay).
   */
  detectionRetryDays?: number
  /** Off by default: Firecrawl needs a key and the B6a credits (see firecrawl.ts). */
  firecrawlEnabled?: boolean
}

export type CompanyForSignalGraph = {
  id: string
  canonicalDomain: string
  careersUrl: string | null
  atsSlug: string | null
  atsBoardToken: string | null
}

const DAY_MS = 86_400_000

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS)
}

export class SignalGraphService {
  constructor(
    private readonly db: Db,
    private readonly opts: SignalGraphOptions = {},
  ) {}

  /**
   * The cheapest sufficient next source for this company.
   *
   * "Sufficient" means the tier can still produce a signal we do not already hold:
   * a board read inside the refresh window is not a candidate, because re-reading
   * it produces `content_unchanged` and nothing else.
   */
  async nextAction(company: CompanyForSignalGraph): Promise<NextAction> {
    const now = this.opts.now ?? new Date()
    const boardRefreshDays = this.opts.boardRefreshDays ?? 7
    const pageRefreshDays = this.opts.pageRefreshDays ?? 7
    const detectionRetryDays = this.opts.detectionRetryDays ?? 30

    // Precondition: both envelopes must have headroom before any tier is picked.
    const budget = await checkBudget(this.db, company.id, 1, now)
    if (!budget.allowed) {
      return {
        kind: 'none',
        tier: null,
        reason: `research budget exhausted at ${budget.scope} scope`,
        reasonCode: 'budget_exhausted',
      }
    }

    // --- tier 1: official structured feeds ---------------------------------
    if (company.atsBoardToken !== null && company.atsSlug !== null) {
      const lastRead = await this.db.companySignal.findFirst({
        where: { companyId: company.id, signalType: 'job_posting' },
        orderBy: { observedAt: 'desc' },
        select: { observedAt: true },
      })
      if (!lastRead || lastRead.observedAt < daysAgo(now, boardRefreshDays)) {
        return {
          kind: 'read_ats_board',
          tier: 1,
          boardToken: company.atsBoardToken,
          vendor: company.atsSlug,
          reason: lastRead
            ? `board last read ${Math.floor((now.getTime() - lastRead.observedAt.getTime()) / DAY_MS)} day(s) ago`
            : 'board detected but never read',
        }
      }
    } else {
      // No board token yet. Detection is still tier 1: it is how a structured feed
      // is acquired, and it must precede any page research on the same company —
      // a careers page fetched first would send us scraping what a feed publishes.
      //
      // But "unread" and "absent" are different things. A company whose detection
      // was attempted and found nothing has no feed to read, and returning
      // `detect_ats` forever would pin it at tier 1 and starve it of the page
      // research that is the only source it has left. D4's floor says a browser
      // task cannot outrank an UNREAD feed; it does not say an absent feed blocks
      // everything below it. So a recent failed attempt exhausts the tier.
      const recentDetectionFailure = await this.db.auditLog.findFirst({
        where: {
          subjectId: company.id,
          action: 'ats.detection_failed',
          createdAt: { gte: daysAgo(now, detectionRetryDays) },
        },
        select: { createdAt: true },
      })
      if (!recentDetectionFailure) {
        const target = company.careersUrl ?? `https://${company.canonicalDomain}`
        return {
          kind: 'detect_ats',
          tier: 1,
          url: target,
          reason: 'no ATS board token; a structured feed outranks every page fetch (D4)',
        }
      }
    }

    // --- tier 2: static fetch + Readability --------------------------------
    const pageUrl = company.careersUrl ?? `https://${company.canonicalDomain}`
    const [recentFetch, recentRefusal] = await Promise.all([
      this.db.auditLog.findFirst({
        where: {
          subjectId: company.id,
          action: { in: [RESEARCH_ACTIONS.pageFetched, RESEARCH_ACTIONS.pageUnusable] },
          createdAt: { gte: daysAgo(now, pageRefreshDays) },
        },
        orderBy: { createdAt: 'desc' },
        select: { action: true },
      }),
      // A preflight refusal is about the HOST, so re-attempting inside the window
      // would be retrying around a policy decision — which D4 forbids outright.
      this.db.auditLog.findFirst({
        where: {
          subjectId: company.id,
          action: RESEARCH_ACTIONS.pageRefused,
          createdAt: { gte: daysAgo(now, pageRefreshDays) },
        },
        select: { reasonCode: true },
      }),
    ])

    if (recentRefusal) {
      return {
        kind: 'none',
        tier: null,
        reason: `page research refused as ${recentRefusal.reasonCode ?? 'unknown'} within the refresh window; refusals are recorded, not retried around (D4)`,
      }
    }

    if (!recentFetch) {
      return {
        kind: 'static_fetch',
        tier: 2,
        url: pageUrl,
        reason: 'no page research inside the refresh window',
      }
    }

    // --- tier 3: Firecrawl, only for a page tier 2 could not read ----------
    if (recentFetch.action === RESEARCH_ACTIONS.pageUnusable) {
      if (!this.opts.firecrawlEnabled) {
        return {
          kind: 'none',
          tier: null,
          reason: 'static fetch produced no usable text and Firecrawl escalation is disabled',
        }
      }
      const escalated = await this.db.auditLog.findFirst({
        where: {
          subjectId: company.id,
          action: RESEARCH_ACTIONS.escalated,
          createdAt: { gte: daysAgo(now, pageRefreshDays) },
        },
        select: { id: true },
      })
      if (!escalated) {
        return {
          kind: 'firecrawl_escalate',
          tier: 3,
          url: pageUrl,
          reason: 'static fetch produced no usable text (D4 step 3 is for exactly this)',
        }
      }
    }

    // Tier 4 is deliberately unreachable: D4 defers the browser layer to F7, to be
    // built only if F2/F3 measurement proves qualified-lead loss from unrenderable
    // pages. Returning one here would make the deferral a comment rather than a
    // property of the code.
    return { kind: 'none', tier: null, reason: 'every permitted source is current' }
  }
}
