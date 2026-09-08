import type { GatedFetcher } from '../core/interfaces/providers.js'
import type { PreflightRefusal } from '../core/policy/fetch-policy-gate.js'
import { normalizeHost } from '../core/policy/host-lists.js'

export type PageResult =
  | { ok: true; url: string; body: string; statusCode: number; hops: string[]; fetches: number }
  | { ok: false; reason: PreflightRefusal['reason'] | 'source_unavailable'; detail: string; fetches: number }

export type FetchPageOptions = {
  companyId?: string | null
  cost?: number
  /** Redirect hops to follow. Zero means treat a 3xx as a dead end. */
  maxHops?: number
  /** Wait applied before a hop that lands on the SAME host, per D4 step 4. */
  sameHostDelayMs?: number
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308])

const sleep = (ms: number) =>
  ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve()

/**
 * Fetches a page, following redirects **through the gate**, one hop at a time.
 *
 * ## Why this exists
 *
 * F0 deliberately does not install undici's redirect interceptor (deviation §4.8):
 * an automatically-followed cross-origin redirect would land on a host the
 * preflight never approved, escaping the check it just passed. Its comment states
 * the intended design — "a 3xx returns as a 3xx and the gate re-runs its checks on
 * the target" — but nothing implemented the second half, so in practice every
 * redirect was a dead end.
 *
 * That is not a small gap in F1. Measured against the first 150 yc-oss companies,
 * plain `https://<domain>` answered with a 30x for a large share of them —
 * apex-to-`www`, HTTP-to-HTTPS, locale prefixes, marketing-path rewrites. Without
 * following, ATS detection sees almost nothing and "live postings attached" fails
 * for reasons that have nothing to do with the company's ATS.
 *
 * ## What makes following safe here
 *
 * Every hop is a fresh `fetchText` through `FetchPolicyGate`, so the target's host
 * policy, robots.txt, terms flag, rate policy and both budget envelopes are all
 * evaluated again before the request is issued. A redirect to a denylisted host is
 * refused exactly as a direct request to it would be — the redirect gains an
 * attacker nothing, because there is no code path that trusts the `Location`
 * header beyond feeding it back into the same gate.
 *
 * Three further bounds:
 *   - a hop cap, so a redirect loop terminates;
 *   - a visited set, so a cycle is caught before the cap;
 *   - a same-host wait, because two hops on one host are two requests to it and
 *     the published spacing applies to both. The gate refuses a too-early request
 *     rather than queueing it, so waiting is the only way to honour the limit
 *     rather than trip over it.
 */
export async function fetchPage(
  fetcher: GatedFetcher,
  startUrl: string,
  opts: FetchPageOptions = {},
): Promise<PageResult> {
  const maxHops = opts.maxHops ?? 3
  const hops: string[] = []
  const visited = new Set<string>()
  let url = startUrl
  let fetches = 0

  for (let hop = 0; hop <= maxHops; hop += 1) {
    if (visited.has(url)) {
      return { ok: false, reason: 'source_unavailable', detail: `redirect loop at ${url}`, fetches }
    }
    visited.add(url)
    hops.push(url)

    const result = await fetcher.fetchText(url, {
      companyId: opts.companyId ?? null,
      cost: opts.cost ?? 1,
    })
    fetches += 1
    if (!result.ok) {
      return { ok: false, reason: result.reason, detail: `${url}: ${result.reason}`, fetches }
    }

    const { statusCode, headers, body } = result.response
    if (!REDIRECT_CODES.has(statusCode)) {
      if (statusCode < 200 || statusCode >= 300) {
        return { ok: false, reason: 'source_unavailable', detail: `${url}: HTTP ${statusCode}`, fetches }
      }
      return { ok: true, url, body, statusCode, hops, fetches }
    }

    const location = headerValue(headers['location'])
    if (!location) {
      return { ok: false, reason: 'source_unavailable', detail: `${url}: HTTP ${statusCode} with no Location`, fetches }
    }

    let next: URL
    try {
      // Relative Locations are common and legal; resolving against the current
      // URL is what turns "/en/careers" into something the gate can check.
      next = new URL(location, url)
    } catch {
      return { ok: false, reason: 'source_unavailable', detail: `${url}: unparseable Location "${location}"`, fetches }
    }
    if (next.protocol !== 'https:' && next.protocol !== 'http:') {
      return { ok: false, reason: 'source_unavailable', detail: `${url}: Location is not http(s)`, fetches }
    }

    if (normalizeHost(next.host) === normalizeHost(new URL(url).host)) {
      await sleep(opts.sameHostDelayMs ?? 0)
    }
    url = next.toString()
  }

  return { ok: false, reason: 'source_unavailable', detail: `exceeded ${maxHops} redirect hops`, fetches }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}
