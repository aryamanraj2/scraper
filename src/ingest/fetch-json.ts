import type { GatedFetcher } from '../core/interfaces/providers.js'
import { contentHashOf } from '../core/evidence/content-hash.js'
import { SourceError } from './source-error.js'

export type FetchedJson = {
  url: string
  value: unknown
  /** Stable hash of the parsed value — see core/evidence/content-hash.ts. */
  contentHash: string
  observedAt: Date
}

export type FetchJsonOptions = {
  companyId?: string | null
  cost?: number
  maxBytes?: number
  now?: () => Date
}

/**
 * The one way an ingestion adapter obtains JSON.
 *
 * Every failure mode collapses to a `SourceError` carrying a reason code, because
 * every one of them means the same thing to the pipeline: this source produced no
 * data this run. They stay distinguishable in the error's `failure` so the audit
 * row records which.
 *
 * `truncated` is checked explicitly. It is the failure that does not announce
 * itself: a body cut at the byte ceiling is still valid UTF-8 and still parses as
 * far as it goes, so without this check a 6 MB feed silently becomes a
 * `SyntaxError` thousands of lines from the actual cause.
 */
export async function fetchJson(
  fetcher: GatedFetcher,
  url: string,
  opts: FetchJsonOptions = {},
): Promise<FetchedJson> {
  let result: Awaited<ReturnType<GatedFetcher['fetchText']>>
  try {
    result = await fetcher.fetchText(url, {
      companyId: opts.companyId ?? null,
      cost: opts.cost ?? 1,
      ...(opts.maxBytes === undefined ? {} : { maxBytes: opts.maxBytes }),
    })
  } catch (err) {
    throw SourceError.unusable(url, (err as Error).message)
  }
  if (!result.ok) throw SourceError.refused(url, result.reason)

  const { statusCode, body, truncated } = result.response
  if (truncated) {
    throw SourceError.unusable(url, `response exceeded the byte ceiling and was truncated`)
  }
  if (statusCode < 200 || statusCode >= 300) {
    throw SourceError.unusable(url, `HTTP ${statusCode}`)
  }

  let value: unknown
  try {
    value = JSON.parse(body)
  } catch (err) {
    throw SourceError.unusable(url, `unparseable JSON: ${(err as Error).message}`)
  }

  return {
    url,
    value,
    contentHash: contentHashOf(value),
    observedAt: (opts.now ?? (() => new Date()))(),
  }
}
