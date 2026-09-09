import { z } from 'zod'
import type { Db } from '../../core/audit/audit-log.js'
import { writeAudit } from '../../core/audit/audit-log.js'
import { contentHashOf } from '../../core/evidence/content-hash.js'
import { FETCHED_VIA, writeCompanySignal, writeEvidence } from '../../core/evidence/write-evidence.js'
import type { FetchPolicyGate } from '../../core/policy/fetch-policy-gate.js'
import type { ReasonCodeValue } from '../../core/reason-codes/registry.js'
import { RESEARCH_ACTIONS } from './actions.js'
import { scanForInjection } from './injection.js'
import { MIN_READABLE_CHARS } from './readability.js'
import { pageExcerpts } from './page-excerpts.js'
import type { ResearchTarget } from './page-research.js'

/**
 * D4 tier 3: Firecrawl, for pages the static fetch could not read.
 *
 * ## Verified at implementation time, not remembered
 *
 * `POST https://api.firecrawl.dev/v2/scrape`, `Authorization: Bearer <key>`, body
 * `{ url, formats, onlyMainContent }`, response
 * `{ success, data: { markdown, metadata: { title, url, statusCode } } }`.
 * Checked against the vendor's API reference while writing this, per the plan's
 * instruction not to trust a remembered API shape.
 *
 * ## Why this is not the vendor SDK
 *
 * `@mendable/firecrawl-js` owns its own HTTP transport. Installing it would put a
 * second network-capable client into the dependency tree, reachable from research
 * code, which is exactly what the three-layer ban on raw HTTP exists to prevent.
 * The client here is a hand-rolled request through `FetchPolicyGate.postJson`, so
 * host policy, terms, rate policy and both budget envelopes are enforced by us
 * before the vendor sees anything. D4 says this plainly: Firecrawl enforcing
 * robots.txt itself is defence in depth, not our check.
 *
 * ## Cost, in the same unit as everything else
 *
 * B6a: a plain scrape is 1 credit, JSON-extraction mode roughly 5. The free tier is
 * 1,000 credits/month (~230 companies at weekly cadence); the student grant is
 * 10,000. This module charges the research budget the same way a static fetch does,
 * so one `creditsCap` bounds both tiers and a cap of zero no-ops the whole research
 * path (Part G).
 *
 * JSON-extraction mode is not implemented. B6a reserves it for pages that
 * genuinely need it, and nothing in F2 does: the escalation exists to turn a
 * JS-rendered page into text, and markdown is text. Adding a 5-credit mode with no
 * caller would be an unbudgeted path waiting to be used by accident.
 *
 * ## Off by default
 *
 * `FIRECRAWL_API_KEY` is absent as of F2, and the student credits were unclaimed.
 * `enabled` is false without a key, `scrape` refuses with `source_unavailable`
 * rather than throwing, and the signal graph never returns a tier-3 action unless
 * the flag is on. H9's rule for optional adapters applies: the pipeline must be
 * correct with it absent.
 */

export const FIRECRAWL_SCRAPE_URL = 'https://api.firecrawl.dev/v2/scrape'
export const FIRECRAWL_API_HOST = 'api.firecrawl.dev'

/** B6a. A plain scrape is one credit; the JSON-extraction mode adds roughly four. */
export const FIRECRAWL_PLAIN_SCRAPE_CREDITS = 1

const ScrapeResponse = z.object({
  success: z.boolean().optional(),
  data: z
    .object({
      markdown: z.string().optional(),
      metadata: z
        .object({
          title: z.string().optional(),
          url: z.string().optional(),
          sourceURL: z.string().optional(),
          statusCode: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
  error: z.string().optional(),
})

export type FirecrawlOptions = {
  apiKey?: string | undefined
  now?: () => Date
  /** Escalation is a research page, not a feed: the default 2 MB ceiling applies. */
  maxBytes?: number
}

export type EscalationOutcome =
  | { kind: 'stored'; evidenceId: string; url: string; chars: number; credits: number }
  | { kind: 'unchanged'; evidenceId: string; url: string; credits: number }
  | { kind: 'refused'; reason: ReasonCodeValue; detail: string; credits: number }
  | { kind: 'unusable'; detail: string; credits: number }
  | { kind: 'injection'; patterns: string[]; credits: number }
  | { kind: 'disabled'; detail: string; credits: 0 }

export class FirecrawlResearchProvider {
  constructor(
    private readonly gate: Pick<FetchPolicyGate, 'postJson'>,
    private readonly opts: FirecrawlOptions = {},
  ) {}

  /** No key, no escalation. Checked by callers before a credit is ever committed. */
  get enabled(): boolean {
    return (this.opts.apiKey ?? '').trim() !== ''
  }

  /**
   * Scrapes one page and records it exactly as the static path does: same
   * `Evidence` shape, same injection block, same `contentHash` skip. The only
   * difference an operator should ever see is `fetchedVia: 'firecrawl'` and the
   * credits it cost — `handover.md` §16 requires browser- and API-derived facts to
   * display identically, and the same reasoning applies here.
   */
  async escalate(db: Db, company: ResearchTarget, url: string): Promise<EscalationOutcome> {
    const now = this.opts.now?.() ?? new Date()

    if (!this.enabled) {
      const detail = 'FIRECRAWL_API_KEY is not set; escalation is disabled'
      await writeAudit(db, {
        actorType: 'system',
        actorId: 'firecrawl',
        action: RESEARCH_ACTIONS.escalated,
        subjectType: 'Company',
        subjectId: company.id,
        reasonCode: 'source_unavailable',
        metadata: { url, detail },
      })
      return { kind: 'disabled', detail, credits: 0 }
    }

    const response = await this.gate.postJson(
      FIRECRAWL_SCRAPE_URL,
      { url, formats: ['markdown'], onlyMainContent: true },
      {
        companyId: company.id,
        cost: FIRECRAWL_PLAIN_SCRAPE_CREDITS,
        headers: { authorization: `Bearer ${this.opts.apiKey ?? ''}` },
        ...(this.opts.maxBytes === undefined ? {} : { maxBytes: this.opts.maxBytes }),
      },
    )

    if (!response.ok) {
      await writeAudit(db, {
        actorType: 'system',
        actorId: 'firecrawl',
        action: RESEARCH_ACTIONS.escalated,
        subjectType: 'Company',
        subjectId: company.id,
        reasonCode: response.reason,
        metadata: { url, refused: true },
      })
      return { kind: 'refused', reason: response.reason, detail: response.reason, credits: 0 }
    }

    const credits = FIRECRAWL_PLAIN_SCRAPE_CREDITS
    const raw = response.response

    if (raw.truncated) {
      return await this.unusable(db, company, url, 'response truncated at the byte ceiling', credits)
    }
    if (raw.statusCode >= 400) {
      // 402 is "out of credits" and 429 is "too fast" — both are the vendor telling
      // us to stop, and neither is retried around.
      return await this.unusable(db, company, url, `HTTP ${raw.statusCode}`, credits)
    }

    let parsed: z.infer<typeof ScrapeResponse>
    try {
      parsed = ScrapeResponse.parse(JSON.parse(raw.body))
    } catch (err) {
      return await this.unusable(db, company, url, `unparseable response: ${(err as Error).message}`, credits)
    }

    const markdown = parsed.data?.markdown?.trim() ?? ''
    if (markdown.length < MIN_READABLE_CHARS) {
      return await this.unusable(
        db,
        company,
        url,
        parsed.error ?? `only ${markdown.length} chars of markdown returned`,
        credits,
      )
    }

    const injection = scanForInjection(markdown)
    if (injection.detected) {
      await writeAudit(db, {
        actorType: 'system',
        actorId: 'firecrawl',
        action: RESEARCH_ACTIONS.injectionBlocked,
        subjectType: 'Company',
        subjectId: company.id,
        reasonCode: 'injection_detected',
        metadata: { url, patterns: injection.matches.map((m) => m.pattern) },
      })
      return { kind: 'injection', patterns: injection.matches.map((m) => m.pattern), credits }
    }

    const finalUrl = parsed.data?.metadata?.sourceURL ?? parsed.data?.metadata?.url ?? url
    const title = parsed.data?.metadata?.title ?? null

    // The same per-track windows the static path stores. handover.md §16 requires
    // facts from different acquisition tiers to display IDENTICALLY in the evidence
    // viewer; storing a different shape here would make that impossible later.
    const { excerpts } = pageExcerpts(markdown, finalUrl)
    const written: string[] = []
    let headEvidenceId: string | undefined
    let anyNew = false

    for (const excerpt of excerpts) {
      const contentHash = contentHashOf({ url: finalUrl, title, text: markdown, key: excerpt.key })
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
        sourceUrl: finalUrl,
        sourceType: 'company_page',
        excerpt: excerpt.text,
        contentHash,
        observedAt: now,
        confidence: 0.8,
        // The tier is recorded, so an audit can show which pages needed paying for.
        fetchedVia: FETCHED_VIA.firecrawl,
      })
      written.push(row.id)
      if (excerpt.key === 'head') headEvidenceId = row.id
    }

    if (!anyNew) {
      await writeAudit(db, {
        actorType: 'system',
        actorId: 'firecrawl',
        action: RESEARCH_ACTIONS.escalated,
        subjectType: 'Company',
        subjectId: company.id,
        reasonCode: 'content_unchanged',
        metadata: { url: finalUrl, credits },
      })
      return { kind: 'unchanged', evidenceId: headEvidenceId ?? '', url: finalUrl, credits }
    }

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
      actorId: 'firecrawl',
      action: RESEARCH_ACTIONS.escalated,
      subjectType: 'Company',
      subjectId: company.id,
      metadata: { url: finalUrl, chars: markdown.length, credits, evidenceIds: written },
    })

    return {
      kind: 'stored',
      evidenceId: headEvidenceId ?? written[0]!,
      url: finalUrl,
      chars: markdown.length,
      credits,
    }
  }

  private async unusable(
    db: Db,
    company: ResearchTarget,
    url: string,
    detail: string,
    credits: number,
  ): Promise<EscalationOutcome> {
    await writeAudit(db, {
      actorType: 'system',
      actorId: 'firecrawl',
      action: RESEARCH_ACTIONS.escalated,
      subjectType: 'Company',
      subjectId: company.id,
      reasonCode: 'source_unavailable',
      metadata: { url, detail, credits },
    })
    return { kind: 'unusable', detail, credits }
  }
}
