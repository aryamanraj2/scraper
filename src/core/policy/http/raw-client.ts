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
}

export type RawRequestOptions = {
  userAgent: string
  timeoutMs?: number
  maxBytes?: number
  headers?: Record<string, string>
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

  const limit = opts.maxBytes ?? DEFAULT_MAX_BYTES
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of res.body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.byteLength
    if (size > limit) break
    chunks.push(buf)
  }

  return {
    statusCode: res.statusCode,
    body: Buffer.concat(chunks).toString('utf8'),
    headers: res.headers as Record<string, string | string[] | undefined>,
    url,
  }
}
