import { z } from 'zod'
import type { AtsProvider, GatedFetcher, Posting } from '../../core/interfaces/providers.js'
import { fetchJson } from '../fetch-json.js'
import { SourceError } from '../source-error.js'
import { ATS_FEED_MAX_BYTES, parseDate } from './common.js'
import { detectAtsInUrl } from './signatures.js'

/**
 * Greenhouse public job board API (B6, verified live):
 *   GET boards-api.greenhouse.io/v1/boards/{token}/jobs
 * No auth. `?content=true` inlines the full description, which is the only way to
 * get it without one request per posting.
 */
export const GREENHOUSE_API = 'https://boards-api.greenhouse.io/v1/boards'

const GreenhouseJob = z
  .object({
    id: z.union([z.number(), z.string()]),
    title: z.string(),
    absolute_url: z.string(),
    location: z.object({ name: z.string().nullish() }).loose().nullish(),
    updated_at: z.string().nullish(),
    first_published: z.string().nullish(),
    content: z.string().nullish(),
  })
  .loose()

const GreenhouseResponse = z
  .object({ jobs: z.array(z.unknown()), meta: z.object({ total: z.number() }).loose().nullish() })
  .loose()

export class GreenhouseProvider implements AtsProvider {
  readonly slug = 'greenhouse'

  constructor(private readonly fetcher: GatedFetcher) {}

  /**
   * Greenhouse tokens are readable straight out of a hosted-board or embed URL, so
   * detection from a URL needs no request. `detect` is async only because the D5
   * seam is: Lever has no discovery endpoint, so its detection genuinely has to
   * read a page, and the interface is shaped for the hardest case.
   */
  async detect(careersUrl: string): Promise<{ boardToken: string } | null> {
    const found = detectAtsInUrl(careersUrl)
    return found?.vendor === 'greenhouse' ? { boardToken: found.boardToken } : null
  }

  boardUrl(boardToken: string): string {
    return `${GREENHOUSE_API}/${encodeURIComponent(boardToken)}/jobs?content=true`
  }

  async listPostings(boardToken: string): Promise<Posting[]> {
    const url = this.boardUrl(boardToken)
    const fetched = await fetchJson(this.fetcher, url, { maxBytes: ATS_FEED_MAX_BYTES })

    const envelope = GreenhouseResponse.safeParse(fetched.value)
    if (!envelope.success) {
      throw SourceError.unusable(url, 'response had no `jobs` array')
    }

    const postings: Posting[] = []
    for (const raw of envelope.data.jobs) {
      const job = GreenhouseJob.safeParse(raw)
      // One malformed posting must not cost the rest of the board.
      if (!job.success) continue
      postings.push({
        externalId: String(job.data.id),
        title: job.data.title,
        url: job.data.absolute_url,
        location: job.data.location?.name ?? null,
        // `first_published` is when the req opened; `updated_at` moves on any edit.
        // A8's freshness question is "is this role still open", which the posting's
        // presence in the feed answers — so the stable original date is the useful
        // one here.
        postedAt: parseDate(job.data.first_published ?? job.data.updated_at),
        content: job.data.content ?? '',
      })
    }
    return postings
  }
}
