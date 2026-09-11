import { request } from 'undici'

/**
 * THE ONLY FILE IN THIS PROJECT THAT MAY REACH THE NETWORK.
 *
 * Three things enforce that, because any one of them alone is escapable:
 *
 *   1. eslint.config.js bans `undici`, `axios`, `got`, `node-fetch`, `node:http`
 *      and `node:https` imports, and the bare `fetch` global, everywhere else.
 *   2. tools/check-no-raw-http.ts walks the TypeScript AST across src/, test/ and
 *      tools/ and fails `npm test` on any such reference outside this file. That
 *      catches what lint-config drift would miss.
 *   3. This module is not exported from any barrel and takes no public callers:
 *      FetchPolicyGate is the only importer, and adapters receive the gate, never
 *      a client.
 *
 * It calls undici's `request` explicitly rather than the global `fetch`. That is
 * deliberate: undici's MockAgent only intercepts the dispatcher it is installed
 * on, and Node's global fetch may be backed by a different undici instance. Going
 * through the package directly means the test suite's `disableNetConnect()` sits
 * in the real request path, so "zero requests were made to this host" is an
 * assertion about sockets rather than about adapter behaviour (Part G).
 */

export type RawResponse = {
  statusCode: number
  body: string
  headers: Record<string, string | string[] | undefined>
  url: string
  /**
   * True when the response exceeded `maxBytes` and `body` is a prefix.
   *
   * This flag is load-bearing. Without it a truncated body is indistinguishable
   * from a complete one, so a 6 MB JSON feed silently arrives as 2 MB of valid
   * bytes ending mid-string, and the only symptom is a parse error somewhere far
   * from the cause. Callers must treat `truncated` as `source_unavailable`, never
   * as data.
   */
  truncated: boolean
}

export type RawRequestOptions = {
  userAgent: string
  timeoutMs?: number
  maxBytes?: number
  headers?: Record<string, string>
}

export type RawPostOptions = RawRequestOptions & {
  /** Serialized as JSON. One of exactly two body shapes this client will send. */
  json: unknown
}

export type RawFormPostOptions = RawRequestOptions & {
  /** Serialized as `application/x-www-form-urlencoded` — an OAuth token request. */
  form: Record<string, string>
}

const DEFAULT_TIMEOUT_MS = 15_000
/** Research pages are text. Anything larger is not something we want to parse. */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024

export async function rawGet(url: string, opts: RawRequestOptions): Promise<RawResponse> {
  const res = await request(url, {
    method: 'GET',
    headers: { 'user-agent': opts.userAgent, accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5', ...opts.headers },
    headersTimeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    bodyTimeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    // undici 7 does not follow redirects unless a redirect interceptor is
    // installed, and we deliberately do not install one: a cross-origin redirect
    // would escape the host the preflight just approved. A 3xx comes back to the
    // caller as a 3xx, and the gate re-runs its checks on the target.
  })
  return await collect(res, url, opts.maxBytes)
}

/**
 * A JSON POST, for a vendor API that has no GET form.
 *
 * Added in F2 for Firecrawl, whose v2 scrape endpoint is
 * `POST https://api.firecrawl.dev/v2/scrape` (verified against the vendor's API
 * reference at implementation time). Every F0/F1 source was a plain GET, so this
 * path did not exist.
 *
 * It is deliberately narrow. There is no general request builder here: one method,
 * a JSON body, and the same size ceiling and timeouts as `rawGet`. A POST reaches
 * the network exactly as a GET does — through `FetchPolicyGate`, after the same
 * five-step preflight — because the thing the preflight protects is the HOST, and
 * a host does not become fetchable by changing the verb. Redirects are not followed
 * for a POST at all: a 3xx is returned to the caller, which treats it as unusable
 * rather than replaying a request body against a host the preflight has not seen.
 */
export async function rawPostJson(url: string, opts: RawPostOptions): Promise<RawResponse> {
  const res = await request(url, {
    method: 'POST',
    headers: {
      'user-agent': opts.userAgent,
      accept: 'application/json',
      'content-type': 'application/json',
      ...opts.headers,
    },
    body: JSON.stringify(opts.json),
    headersTimeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    bodyTimeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  })
  return await collect(res, url, opts.maxBytes)
}

/**
 * A form-encoded POST, for an OAuth 2.0 token endpoint.
 *
 * Added in F5. RFC 6749 §4.1.3 and §6 both require the token request body to be
 * `application/x-www-form-urlencoded`; Google's token endpoint accepts nothing else.
 * `rawPostJson` cannot be reused by changing a header, because the body itself is a
 * different encoding — so this is a third narrow method rather than a general
 * request builder, which is the shape §4.5 of the F3 handover argued for when the
 * JSON POST was added.
 *
 * Everything else is identical to `rawPostJson`: same preflight upstream, same size
 * ceiling, same timeouts, and **no redirect following**, because replaying a body
 * carrying a client secret against a host the preflight has not seen is not something
 * this system should be able to do.
 *
 * The caller's parameters — which include `client_secret` and `refresh_token` — are
 * serialized here and never returned, and `FetchPolicyGate.postForm` writes no body
 * into its audit row at all.
 */
export async function rawPostForm(url: string, opts: RawFormPostOptions): Promise<RawResponse> {
  const body = new URLSearchParams(opts.form).toString()
  const res = await request(url, {
    method: 'POST',
    headers: {
      'user-agent': opts.userAgent,
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      ...opts.headers,
    },
    body,
    headersTimeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    bodyTimeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  })
  return await collect(res, url, opts.maxBytes)
}

type UndiciResponse = Awaited<ReturnType<typeof request>>

async function collect(res: UndiciResponse, url: string, maxBytes?: number): Promise<RawResponse> {
  const limit = maxBytes ?? DEFAULT_MAX_BYTES
  let size = 0
  let truncated = false
  const chunks: Buffer[] = []
  for await (const chunk of res.body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.byteLength
    if (size > limit) {
      truncated = true
      break
    }
    chunks.push(buf)
  }
  // Draining matters: abandoning the body mid-stream leaves the connection in a
  // state undici cannot reuse, and at a 5s per-host spacing we hold connections
  // for a long time.
  if (truncated) res.body.destroy()

  return {
    statusCode: res.statusCode,
    body: Buffer.concat(chunks).toString('utf8'),
    headers: res.headers as Record<string, string | string[] | undefined>,
    url,
    truncated,
  }
}
