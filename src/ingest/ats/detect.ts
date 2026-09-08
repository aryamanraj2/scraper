import type { Db } from '../../core/audit/audit-log.js'
import { writeAudit } from '../../core/audit/audit-log.js'
import type { GatedFetcher } from '../../core/interfaces/providers.js'
import { contentHashOf } from '../../core/evidence/content-hash.js'
import { FETCHED_VIA, verbatimExcerpt, writeEvidence } from '../../core/evidence/write-evidence.js'
import { fetchPage } from '../fetch-page.js'
import { detectAtsInText, detectAtsInUrl, type AtsDetection } from './signatures.js'

export type DetectTarget = { id: string; canonicalDomain: string; careersUrl: string | null; website: string | null }

export type DetectOutcome =
  | { found: true; detection: AtsDetection; sourceUrl: string; fetches: number }
  | { found: false; reason: 'source_unavailable'; detail: string; fetches: number }

export type DetectOptions = {
  /**
   * Candidate PATHS tried per company. Not a request count: a path that redirects
   * costs one request per hop, bounded separately by `maxRedirectHops`.
   * Detection is cheap or it is not done.
   */
  maxPages?: number
  /**
   * Wait between two requests to the SAME host, redirect hops included.
   *
   * Every page tried here is on one employer domain, so the per-host spacing in
   * D4 step 4 applies between them. The gate REFUSES a too-early request rather
   * than queueing it, so without this every company's second candidate page comes
   * back `rate_limited` and detection effectively gets one attempt. Waiting is the
   * only correct response: retrying immediately, or reaching past the limiter,
   * would be evading a rate limit (handover.md §1.5).
   */
  interPageDelayMs?: number
  /**
   * Redirect hops per candidate page. Apex-to-`www`, HTTP-to-HTTPS and locale
   * prefixes mean most company homepages answer with a 30x; not following leaves
   * detection with almost nothing to read. Each hop is re-checked by the gate —
   * see fetch-page.ts.
   */
  maxRedirectHops?: number
  now?: () => Date
}

const sleep = (ms: number) =>
  ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve()

/**
 * The paths a careers page actually lives at, in the order worth trying.
 *
 * This list is short on purpose. Detection exists to find a board token, and a
 * company that hides it behind four redirects and a JS router is a company F2's
 * Firecrawl escalation handles — not one to spend ten requests and ten seconds of
 * per-host rate delay on here.
 */
export const CAREERS_PATHS = ['/careers', '/jobs', '/careers/', '/about/careers'] as const

/**
 * ATS detection with slug resolution (Part F, F1).
 *
 * Two stages, cheapest first, which is D4's source precedence applied at the level
 * of a single company:
 *
 *   1. **No request at all.** If a stored careers URL or website already points at
 *      a hosted board, the token is right there in the string. Greenhouse and Ashby
 *      companies are usually resolved here.
 *   2. **Read the company's own pages.** Lever publishes no discovery endpoint
 *      (B6), so for a Lever company the slug exists nowhere except on pages the
 *      company controls. The homepage is tried first, then a short list of
 *      conventional careers paths.
 *
 * Every request goes through the gate, so the company's `derived_company` allow
 * row, its robots.txt, its rate policy and both budget envelopes all apply. A
 * refusal is returned as an outcome, never thrown: F1 handover §8.2.3 — "detection
 * failure is `source_unavailable`, not an exception".
 */
export async function detectAtsForCompany(
  db: Db,
  fetcher: GatedFetcher,
  company: DetectTarget,
  opts: DetectOptions = {},
): Promise<DetectOutcome> {
  const now = opts.now ?? (() => new Date())
  const maxPages = opts.maxPages ?? 3

  for (const candidate of [company.careersUrl, company.website]) {
    if (!candidate) continue
    const hit = detectAtsInUrl(candidate)
    if (hit) {
      await recordDetectionEvidence(db, company.id, candidate, hit, now())
      return { found: true, detection: hit, sourceUrl: candidate, fetches: 0 }
    }
  }

  const origin = `https://${company.canonicalDomain}`
  const pages = [origin, ...CAREERS_PATHS.map((path) => `${origin}${path}`)].slice(0, maxPages)

  let fetches = 0
  const failures: string[] = []

  for (const url of pages) {
    if (fetches > 0) await sleep(opts.interPageDelayMs ?? 0)

    const page = await fetchPage(fetcher, url, {
      companyId: company.id,
      cost: 1,
      maxHops: opts.maxRedirectHops ?? 3,
      sameHostDelayMs: opts.interPageDelayMs ?? 0,
    })
    fetches += page.fetches

    if (!page.ok) {
      failures.push(page.detail)
      // A preflight refusal is about the HOST, not the path: robots, terms, rate
      // and budget apply identically to every other page on it, so trying more
      // paths would only produce the same refusal more times. An ordinary HTTP
      // failure says nothing about the next path, so that one keeps going.
      if (page.reason !== 'source_unavailable') break
      continue
    }

    const hit = detectAtsInText(page.body)
    if (hit) {
      // Cite the URL that actually served the markup, not the one we asked for.
      await recordDetectionEvidence(db, company.id, page.url, hit, now())
      return { found: true, detection: hit, sourceUrl: page.url, fetches }
    }
    failures.push(`${page.url}: no board signature`)
  }

  await writeAudit(db, {
    actorType: 'system',
    actorId: 'ats-detect',
    action: 'ats.detection_failed',
    subjectType: 'Company',
    subjectId: company.id,
    reasonCode: 'source_unavailable',
    metadata: { domain: company.canonicalDomain, attempts: failures },
  })

  return {
    found: false,
    reason: 'source_unavailable',
    detail: failures.join('; ') || 'no candidate URL to inspect',
    fetches,
  }
}

/**
 * Records WHERE the board token was read from, quoting the matched text verbatim.
 *
 * `Company.atsBoardToken` is a stored fact like any other, so it needs the same
 * provenance as a location or a team size: without this row, the criterion "every
 * field traceable to an `Evidence` row" is false for the two fields that decide
 * which postings the company ever gets.
 */
async function recordDetectionEvidence(
  db: Db,
  companyId: string,
  sourceUrl: string,
  detection: AtsDetection,
  observedAt: Date,
): Promise<void> {
  await writeEvidence(db, {
    companyId,
    sourceUrl,
    // The token was read off the employer's own page or link, not out of an ATS
    // feed — `company_page` is what that is.
    sourceType: 'company_page',
    excerpt: verbatimExcerpt(detection.matchedText),
    contentHash: contentHashOf({ vendor: detection.vendor, boardToken: detection.boardToken }),
    observedAt,
    confidence: 0.9,
    fetchedVia: FETCHED_VIA.structuredFeed,
  })
}

/** Persists a detection onto the Company. `atsSlug` is the vendor; `atsBoardToken` the board. */
export async function saveDetection(
  db: Db,
  companyId: string,
  detection: AtsDetection,
  careersUrl: string,
): Promise<void> {
  await db.company.update({
    where: { id: companyId },
    data: {
      atsSlug: detection.vendor,
      atsBoardToken: detection.boardToken,
      careersUrl,
    },
  })
}
