import type { Db } from '../../core/audit/audit-log.js'
import { writeAudit } from '../../core/audit/audit-log.js'
import { contentHashOf } from '../../core/evidence/content-hash.js'
import { FETCHED_VIA, writeCompanySignal, writeEvidence } from '../../core/evidence/write-evidence.js'
import type { GatedFetcher } from '../../core/interfaces/providers.js'
import type { ReasonCodeValue } from '../../core/reason-codes/registry.js'
import { fetchPage } from '../../ingest/fetch-page.js'
import { ensureCompanyResearchBudget } from '../../ingest/budget/company-budget.js'
import { RESEARCH_ACTIONS } from './actions.js'
import { scanForInjection } from './injection.js'
import { MIN_READABLE_CHARS, extractReadable, type ExtractedPage } from './readability.js'
import { pageExcerpts } from './page-excerpts.js'

/**
 * D4 tier 2, end to end: static fetch through the preflight, Readability, and an
 * `Evidence` row if — and only if — what came back is usable and is not addressing
 * an agent.
 *
 * ## Everything here is an outcome, not an exception
 *
 * Five things can happen and all five are recorded:
 *
 *   - **refused** — the preflight said no. The reason code is the gate's own, the
 *     audit row is counted by Part G's refusal counters, and there is no retry
 *     path. D4: refusals are "recorded, never retried around".
 *   - **unusable** — the request happened and produced no readable text. This is
 *     the Firecrawl escalation trigger (D4 step 3), which is why it is a distinct
 *     outcome from a refusal rather than folded into one "failed" case.
 *   - **injection** — the page is shaped like instructions to an agent. Blocked,
 *     with zero `Evidence` written (Part G).
 *   - **unchanged** — the extracted text hashes to an `Evidence` row we already
 *     hold. F1 §4.10 established that a matching `contentHash` is authority to skip
 *     work, not a hint, so nothing is rewritten.
 *   - **stored** — a fresh `Evidence` row plus a `careers_page` signal.
 *
 * ## Budget
 *
 * `ensureCompanyResearchBudget` opens the current month's envelope before the
 * fetch, per F1 §4.2: `checkBudget` only refuses when a row EXISTS, so a company
 * with no row for this month has no ceiling at all. The gate then charges the
 * fetch against it — one credit per page request, matching a Firecrawl plain
 * scrape, so the two tiers are denominated in the same unit and a cap of zero
 * no-ops both.
 */

export type PageResearchOutcome =
  | { kind: 'stored'; evidenceId: string; url: string; page: ExtractedPage; fetches: number }
  | { kind: 'unchanged'; evidenceId: string; url: string; fetches: number }
  | { kind: 'refused'; reason: ReasonCodeValue; detail: string; fetches: number }
  | { kind: 'unusable'; detail: string; fetches: number }
  | { kind: 'injection'; patterns: string[]; fetches: number }

export type PageResearchOptions = {
  now?: Date
  /** Redirect hops. Most employer homepages answer 30x (F1 §4.8). */
  maxHops?: number
  sameHostDelayMs?: number
  /** Credits charged for the fetch. One page = one credit, as for Firecrawl. */
  cost?: number
}

export type ResearchTarget = {
  id: string
  canonicalDomain: string
  countries: string[]
}

export async function researchCompanyPage(
  db: Db,
  fetcher: GatedFetcher,
  company: ResearchTarget,
  url: string,
  opts: PageResearchOptions = {},
): Promise<PageResearchOutcome> {
  const now = opts.now ?? new Date()

  // F1 §4.2: idempotent, keyed by period month. Called at the start of each refresh
  // so the cap exists before anything can be spent against it.
  await ensureCompanyResearchBudget(db, company.id, company.countries, now)

  const result = await fetchPage(fetcher, url, {
    companyId: company.id,
    cost: opts.cost ?? 1,
    ...(opts.maxHops === undefined ? {} : { maxHops: opts.maxHops }),
    ...(opts.sameHostDelayMs === undefined ? {} : { sameHostDelayMs: opts.sameHostDelayMs }),
  })

  if (!result.ok) {
    if (result.reason === 'source_unavailable') {
      await writeAudit(db, {
        actorType: 'system',
        actorId: 'researcher',
        action: RESEARCH_ACTIONS.pageUnusable,
        subjectType: 'Company',
        subjectId: company.id,
        reasonCode: 'source_unavailable',
        metadata: { url, detail: result.detail },
      })
      return { kind: 'unusable', detail: result.detail, fetches: result.fetches }
    }
    await writeAudit(db, {
      actorType: 'system',
      actorId: 'researcher',
      action: RESEARCH_ACTIONS.pageRefused,
      subjectType: 'Company',
      subjectId: company.id,
      reasonCode: result.reason,
      metadata: { url, detail: result.detail },
    })
    return { kind: 'refused', reason: result.reason, detail: result.detail, fetches: result.fetches }
  }

  const page = extractReadable(result.body)
  if (!page || page.length < MIN_READABLE_CHARS) {
    const detail = page
      ? `only ${page.length} readable chars (floor ${MIN_READABLE_CHARS})`
      : 'no readable content extracted'
    await writeAudit(db, {
      actorType: 'system',
      actorId: 'researcher',
      action: RESEARCH_ACTIONS.pageUnusable,
      subjectType: 'Company',
      subjectId: company.id,
      reasonCode: 'source_unavailable',
      metadata: { url: result.url, detail },
    })
    return { kind: 'unusable', detail, fetches: result.fetches }
  }

  // Page text is data, never instruction. A page addressing an agent never becomes
  // an Evidence row, because an Evidence row is quotable by every later milestone.
  const injection = scanForInjection(page.text)
  if (injection.detected) {
    await writeAudit(db, {
      actorType: 'system',
      actorId: 'researcher',
      action: RESEARCH_ACTIONS.injectionBlocked,
      subjectType: 'Company',
      subjectId: company.id,
      reasonCode: 'injection_detected',
      metadata: {
        url: result.url,
        patterns: injection.matches.map((m) => m.pattern),
        // The matched text is recorded so an operator can see what tripped it. It
        // is metadata on an audit row, which nothing quotes and no prompt reads.
        matches: injection.matches.map((m) => m.snippet),
      },
    })
    return { kind: 'injection', patterns: injection.matches.map((m) => m.pattern), fetches: result.fetches }
  }

  // One row per matched track plus a head row, following F1 §4.4's precedent: a
  // single 500-char excerpt cannot honestly justify a page, and the prefix of a
  // careers page is a hero headline rather than the sentence naming a stack.
  const { excerpts, match } = pageExcerpts(page.text, result.url)
  const written: string[] = []
  let headEvidenceId: string | undefined
  let anyNew = false

  for (const excerpt of excerpts) {
    // The hash is per (page content, key), so a track window and the head row are
    // distinct facts about the same fetch and neither masks the other.
    const contentHash = contentHashOf({ url: result.url, title: page.title, text: page.text, key: excerpt.key })
    const existing = await db.evidence.findFirst({
      where: { companyId: company.id, contentHash, sourceType: 'company_page' },
      select: { id: true },
    })
    if (existing) {
      if (excerpt.key === 'head') headEvidenceId = existing.id
      continue
    }
    anyNew = true
    const row = await writeEvidence(db, {
      companyId: company.id,
      // The URL that actually answered, not the one we asked for: F1 §4.8 follows
      // redirects, and citing the requested URL would cite a page we never read.
      sourceUrl: result.url,
      sourceType: 'company_page',
      excerpt: excerpt.text,
      contentHash,
      observedAt: now,
      // Below an ATS feed's 0.95: this is the employer's own prose, extracted by a
      // heuristic that can include a stray nav item.
      confidence: 0.8,
      fetchedVia: FETCHED_VIA.staticFetch,
    })
    written.push(row.id)
    if (excerpt.key === 'head') headEvidenceId = row.id
  }

  if (!anyNew) {
    await writeAudit(db, {
      actorType: 'system',
      actorId: 'researcher',
      action: RESEARCH_ACTIONS.pageFetched,
      subjectType: 'Company',
      subjectId: company.id,
      reasonCode: 'content_unchanged',
      metadata: { url: result.url },
    })
    return { kind: 'unchanged', evidenceId: headEvidenceId ?? '', url: result.url, fetches: result.fetches }
  }

  // The signal cites the head row: it is about the PAGE, not about one track's
  // paragraph, and an unmatched page still has exactly one row to point at.
  if (headEvidenceId !== undefined) {
    await writeCompanySignal(db, {
      companyId: company.id,
      evidenceId: headEvidenceId,
      signalType: 'careers_page',
      observedAt: now,
      confidence: 0.8,
    })
  }

  await writeAudit(db, {
    actorType: 'system',
    actorId: 'researcher',
    action: RESEARCH_ACTIONS.pageFetched,
    subjectType: 'Company',
    subjectId: company.id,
    metadata: {
      url: result.url,
      chars: page.length,
      hops: result.hops.length,
      evidenceIds: written,
      tracks: match.matches.map((m) => `${m.track}:${m.confidence}`),
    },
  })

  return {
    kind: 'stored',
    evidenceId: headEvidenceId ?? written[0]!,
    url: result.url,
    page,
    fetches: result.fetches,
  }
}
