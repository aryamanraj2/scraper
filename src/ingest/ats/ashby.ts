import { z } from 'zod'
import type { AtsProvider, GatedFetcher, Posting } from '../../core/interfaces/providers.js'
import { fetchJson } from '../fetch-json.js'
import { SourceError } from '../source-error.js'
import { ATS_FEED_MAX_BYTES, parseDate } from './common.js'
import { detectAtsInUrl } from './signatures.js'

/**
 * Ashby public posting API (B6, verified live):
 *   GET api.ashbyhq.com/posting-api/job-board/{name}
 * No auth, single call, no pagination. B6 also records what does NOT exist: the
 * "public GraphQL" variant is not a real endpoint — do not go looking for it.
 */
export const ASHBY_API = 'https://api.ashbyhq.com/posting-api/job-board'

const AshbyJob = z
  .object({
    id: z.string(),
    title: z.string(),
    location: z.string().nullish(),
    jobUrl: z.string().nullish(),
    applyUrl: z.string().nullish(),
    publishedAt: z.string().nullish(),
    isListed: z.boolean().nullish(),
    isRemote: z.boolean().nullish(),
    descriptionPlain: z.string().nullish(),
    descriptionHtml: z.string().nullish(),
  })
  .loose()

const AshbyResponse = z.object({ jobs: z.array(z.unknown()) }).loose()

export class AshbyProvider implements AtsProvider {
  readonly slug = 'ashby'

  constructor(private readonly fetcher: GatedFetcher) {}

  async detect(careersUrl: string): Promise<{ boardToken: string } | null> {
    const found = detectAtsInUrl(careersUrl)
    return found?.vendor === 'ashby' ? { boardToken: found.boardToken } : null
  }

  boardUrl(boardToken: string): string {
    return `${ASHBY_API}/${encodeURIComponent(boardToken)}`
  }

  async listPostings(boardToken: string): Promise<Posting[]> {
    const url = this.boardUrl(boardToken)
    const fetched = await fetchJson(this.fetcher, url, { maxBytes: ATS_FEED_MAX_BYTES })

    const envelope = AshbyResponse.safeParse(fetched.value)
    if (!envelope.success) {
      throw SourceError.unusable(url, 'response had no `jobs` array')
    }

    const postings: Posting[] = []
    for (const raw of envelope.data.jobs) {
      const parsed = AshbyJob.safeParse(raw)
      if (!parsed.success) continue
      const job = parsed.data
      // Ashby returns unlisted postings alongside listed ones. An unlisted req is
      // not a public opportunity, and treating one as an open role is precisely
      // the "email about a closed role" failure A8 exists to prevent.
      if (job.isListed === false) continue

      postings.push({
        externalId: job.id,
        title: job.title,
        url: job.jobUrl ?? job.applyUrl ?? `https://jobs.ashbyhq.com/${boardToken}/${job.id}`,
        location: job.location ?? null,
        postedAt: parseDate(job.publishedAt),
        content: job.descriptionPlain ?? job.descriptionHtml ?? '',
      })
    }
    return postings
  }
}
