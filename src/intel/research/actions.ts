/**
 * Audit action names for the research path, in one place.
 *
 * They are shared rather than inlined because two modules must agree on them
 * exactly: the research runner writes them, and `SignalGraphService` reads them to
 * decide what has already been attempted. A typo would not fail a test — it would
 * silently make the signal graph re-attempt a page forever, which is precisely the
 * "retried around" behaviour D4 forbids.
 */
export const RESEARCH_ACTIONS = {
  /** A page was fetched and readable text extracted. */
  pageFetched: 'research.page_fetched',
  /** A page was fetched and produced nothing usable — the Firecrawl trigger. */
  pageUnusable: 'research.page_unusable',
  /** The preflight refused. Counted by reason; never retried around (D4). */
  pageRefused: 'research.page_refused',
  /** Firecrawl escalation ran (or was refused). */
  escalated: 'research.escalated',
  /** Page text contained instruction-shaped content and was not passed on. */
  injectionBlocked: 'research.injection_blocked',
} as const

export type ResearchAction = (typeof RESEARCH_ACTIONS)[keyof typeof RESEARCH_ACTIONS]
