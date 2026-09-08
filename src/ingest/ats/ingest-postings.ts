import type { Db } from '../../core/audit/audit-log.js'
import { writeAudit } from '../../core/audit/audit-log.js'
import type { AtsProvider, GatedFetcher, Posting } from '../../core/interfaces/providers.js'
import { contentHashOf } from '../../core/evidence/content-hash.js'
import {
  FETCHED_VIA,
  verbatimExcerpt,
  writeCompanySignal,
  writeEvidence,
} from '../../core/evidence/write-evidence.js'
import type { ReasonCodeValue } from '../../core/reason-codes/registry.js'
import { isSourceError } from '../source-error.js'
import { AshbyProvider } from './ashby.js'
import { GreenhouseProvider } from './greenhouse.js'
import { LeverProvider } from './lever.js'
import type { AtsVendor } from './signatures.js'

export function atsProviders(fetcher: GatedFetcher): Record<AtsVendor, AtsProvider> {
  return {
    greenhouse: new GreenhouseProvider(fetcher),
    lever: new LeverProvider(fetcher),
    ashby: new AshbyProvider(fetcher),
  }
}

export type PostingIngestResult = {
  fetched: number
  created: number
  /** Existed already, and its content actually changed. */
  updated: number
  unchanged: number
  duplicates: number
  sourceFailure?: { reason: ReasonCodeValue; detail: string } | undefined
}

export type IngestPostingsOptions = { now?: () => Date }

/**
 * Reads one company's board and writes `Opportunity` rows with provenance.
 *
 * Three outcomes per posting, and the distinction between the first two is what
 * F2's freshness and hiring-delta work rests on:
 *
 *   - **new or changed** — the posting's `contentHash` differs from the stored
 *     one. A fresh `Evidence` row is written and the `Opportunity` is upserted.
 *   - **unchanged** — the hash matches. Only `lastSeenAt` moves. No `Evidence`
 *     row, no `updatedAt` churn, reason `content_unchanged`. This is what keeps a
 *     weekly refresh from rewriting the entire corpus every run and drowning real
 *     changes in noise.
 *   - **duplicate** — the same `externalId` appeared twice in one feed. The
 *     `@@unique([companyId, externalId])` index would reject it as a constraint
 *     error; catching it here makes it the recorded decision `duplicate` instead.
 *
 * The run also writes one `job_posting` `CompanySignal` carrying the open-posting
 * COUNT in `numericValue`. That is deliberately stored per refresh so F2 can
 * compute B2's week-over-week ATS job-count delta — the free substitute for the
 * excluded X API — by comparing two signals, with no refetch of anything.
 */
export async function ingestPostings(
  db: Db,
  provider: AtsProvider,
  company: { id: string; atsBoardToken: string },
  opts: IngestPostingsOptions = {},
): Promise<PostingIngestResult> {
  const now = opts.now ?? (() => new Date())
  const observedAt = now()
  const result: PostingIngestResult = { fetched: 0, created: 0, updated: 0, unchanged: 0, duplicates: 0 }

  let postings: Posting[]
  try {
    postings = await provider.listPostings(company.atsBoardToken)
  } catch (err) {
    if (!isSourceError(err)) throw err
    result.sourceFailure = { reason: err.reasonCode, detail: err.message }
    await writeAudit(db, {
      actorType: 'system',
      actorId: `ats-${provider.slug}`,
      action: 'ats.board_failed',
      subjectType: 'Company',
      subjectId: company.id,
      reasonCode: err.reasonCode,
      metadata: { boardToken: company.atsBoardToken, detail: err.message },
    })
    return result
  }

  result.fetched = postings.length
  const seenExternalIds = new Set<string>()

  for (const posting of postings) {
    if (seenExternalIds.has(posting.externalId)) {
      result.duplicates += 1
      await writeAudit(db, {
        actorType: 'system',
        actorId: `ats-${provider.slug}`,
        action: 'ats.posting_skipped',
        subjectType: 'Company',
        subjectId: company.id,
        reasonCode: 'duplicate',
        metadata: { externalId: posting.externalId, boardToken: company.atsBoardToken },
      })
      continue
    }
    seenExternalIds.add(posting.externalId)

    const outcome = await upsertPosting(db, provider.slug, company.id, posting, observedAt)
    result[outcome] += 1
  }

  await writeBoardCountSignal(db, provider, company, postings, observedAt)
  return result
}

/**
 * The identity of a posting's CONTENT, excluding anything that moves without the
 * facts moving. Deliberately does not include `postedAt`: Greenhouse's
 * `updated_at` changes on any edit, and a hash that tracks it would report every
 * cosmetic touch as a changed role.
 */
export function postingContentHash(posting: Posting): string {
  return contentHashOf({
    externalId: posting.externalId,
    title: posting.title,
    url: posting.url,
    location: posting.location,
    content: posting.content,
  })
}

async function upsertPosting(
  db: Db,
  vendor: string,
  companyId: string,
  posting: Posting,
  observedAt: Date,
): Promise<'created' | 'updated' | 'unchanged'> {
  const hash = postingContentHash(posting)

  const existing = await db.opportunity.findUnique({
    where: { companyId_externalId: { companyId, externalId: posting.externalId } },
    select: { id: true },
  })

  if (existing) {
    const priorEvidence = await db.evidence.findFirst({
      where: { companyId, contentHash: hash, sourceType: 'ats' },
      select: { id: true },
    })
    if (priorEvidence) {
      // Unchanged: touch `lastSeenAt` only. A8's freshness question is "was this
      // still listed", and that is exactly what lastSeenAt answers.
      await db.opportunity.update({
        where: { id: existing.id },
        data: { lastSeenAt: observedAt, closedAt: null },
      })
      await writeAudit(db, {
        actorType: 'system',
        actorId: `ats-${vendor}`,
        action: 'ats.posting_unchanged',
        subjectType: 'Opportunity',
        subjectId: existing.id,
        reasonCode: 'content_unchanged',
        metadata: { externalId: posting.externalId, contentHash: hash },
      })
      return 'unchanged'
    }
  }

  await writeEvidence(db, {
    companyId,
    sourceUrl: posting.url,
    sourceType: 'ats',
    excerpt: verbatimExcerpt(
      JSON.stringify({
        title: posting.title,
        location: posting.location,
        url: posting.url,
      }),
    ),
    contentHash: hash,
    observedAt,
    // A public ATS feed published by the employer is the most reliable source in
    // D4's precedence order. It still is not a licence to quote it uncited — it is
    // why the Evidence row exists.
    confidence: 0.95,
    fetchedVia: FETCHED_VIA.structuredFeed,
  })

  const data = {
    kind: 'published_role' as const,
    status: 'open' as const,
    title: posting.title,
    roleUrl: posting.url,
    location: posting.location,
    postedAt: posting.postedAt,
    lastSeenAt: observedAt,
    closedAt: null,
  }

  if (existing) {
    await db.opportunity.update({ where: { id: existing.id }, data })
    return 'updated'
  }
  await db.opportunity.create({
    data: { companyId, externalId: posting.externalId, ...data },
  })
  return 'created'
}

/**
 * B2's substitute hiring signal, prepared in F1 so F2 does not have to refetch.
 *
 * X is excluded from v1, and the plan's replacement — "week-over-week deltas in a
 * company's ATS job count" — needs a count recorded at each refresh. Storing it as
 * a `job_posting` signal with the count in `numericValue` means F2 computes the
 * delta from two rows it already has. `ats_job_count_delta` stays reserved for the
 * computed delta itself, which is F2's to write.
 */
async function writeBoardCountSignal(
  db: Db,
  provider: AtsProvider,
  company: { id: string; atsBoardToken: string },
  postings: Posting[],
  observedAt: Date,
): Promise<void> {
  const summary = {
    ats: provider.slug,
    boardToken: company.atsBoardToken,
    openPostings: postings.length,
    observedAt: observedAt.toISOString(),
  }
  const evidence = await writeEvidence(db, {
    companyId: company.id,
    // The board feed, not a posting: this row is evidence about the BOARD, and an
    // empty board is a real observation that still needs a source.
    sourceUrl: provider.boardUrl(company.atsBoardToken),
    sourceType: 'ats',
    excerpt: verbatimExcerpt(JSON.stringify(summary)),
    // Includes the timestamp on purpose: every refresh is a distinct observation,
    // and two refreshes returning the same count are two data points, not one.
    contentHash: contentHashOf(summary),
    observedAt,
    confidence: 0.95,
    fetchedVia: FETCHED_VIA.structuredFeed,
  })

  await writeCompanySignal(db, {
    companyId: company.id,
    evidenceId: evidence.id,
    signalType: 'job_posting',
    observedAt,
    confidence: 0.95,
    numericValue: postings.length,
  })
}
