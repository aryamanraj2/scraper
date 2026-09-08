import { z } from 'zod'
import type { AtsProvider, GatedFetcher, Posting } from '../../core/interfaces/providers.js'
import { fetchJson } from '../fetch-json.js'
import { SourceError } from '../source-error.js'
import { ATS_FEED_MAX_BYTES, parseEpochMs } from './common.js'
import { detectAtsInUrl } from './signatures.js'

/**
 * Lever postings API (B6, verified live):
 *   GET api.lever.co/v0/postings/{slug}?mode=json
 * No auth, and — the fact that shapes this whole module — **no discovery
 * endpoint**. There is no way to ask Lever "which board belongs to this company",
 * so the slug has to be read off the company's own pages. That is why slug
 * resolution is part of detection rather than an afterthought (Part F, F1).
 */
export const LEVER_API = 'https://api.lever.co/v0/postings'

const LeverPosting = z
  .object({
    id: z.string(),
    text: z.string(),
    hostedUrl: z.string().nullish(),
    applyUrl: z.string().nullish(),
    createdAt: z.number().nullish(),
    categories: z
      .object({
        location: z.string().nullish(),
        team: z.string().nullish(),
        allLocations: z.array(z.string()).nullish(),
      })
      .loose()
      .nullish(),
    descriptionPlain: z.string().nullish(),
    description: z.string().nullish(),
  })
  .loose()

export class LeverProvider implements AtsProvider {
  readonly slug = 'lever'

  constructor(private readonly fetcher: GatedFetcher) {}

  async detect(careersUrl: string): Promise<{ boardToken: string } | null> {
    const found = detectAtsInUrl(careersUrl)
    return found?.vendor === 'lever' ? { boardToken: found.boardToken } : null
  }

  boardUrl(boardToken: string): string {
    return `${LEVER_API}/${encodeURIComponent(boardToken)}?mode=json`
  }

  async listPostings(boardToken: string): Promise<Posting[]> {
    const url = this.boardUrl(boardToken)
    const fetched = await fetchJson(this.fetcher, url, { maxBytes: ATS_FEED_MAX_BYTES })

    if (!Array.isArray(fetched.value)) {
      throw SourceError.unusable(url, 'response was not a JSON array of postings')
    }

    const postings: Posting[] = []
    for (const raw of fetched.value) {
      const parsed = LeverPosting.safeParse(raw)
      if (!parsed.success) continue
      const job = parsed.data
      const hosted = job.hostedUrl ?? `https://jobs.lever.co/${boardToken}/${job.id}`
      postings.push({
        externalId: job.id,
        // Lever calls the job title `text`. Renaming it in our model is the point
        // of the adapter layer; the raw key stays visible in the Evidence excerpt.
        title: job.text,
        url: hosted,
        location: job.categories?.location ?? job.categories?.allLocations?.[0] ?? null,
        // Epoch milliseconds, unlike the other two vendors' ISO strings.
        postedAt: typeof job.createdAt === 'number' ? parseEpochMs(job.createdAt) : null,
        content: job.descriptionPlain ?? job.description ?? '',
      })
    }
    return postings
  }
}
