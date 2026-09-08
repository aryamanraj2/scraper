import { SEED_DENY_HOSTS, hostMatches, normalizeHost } from '../../core/policy/host-lists.js'
import { registrableDomain } from '../../core/policy/registrable-domain.js'

/**
 * `Company.canonicalDomain` is the join key across every source, so getting it
 * wrong merges two companies or splits one — and both failures are silent.
 *
 * ## Why this takes a public-suffix-list dependency (F1 handover §10 question 2)
 *
 * Resolving a registrable domain by "keep the last two labels" is wrong for
 * exactly the markets this system prioritises. India is priority #1 and Indian
 * companies sit on `.co.in`, `.net.in`, `.org.in`; the UK track sits on `.co.uk`.
 * A two-label rule turns every one of them into the public suffix itself, so
 * `razorpay.co.in` and `zomato.co.in` both canonicalize to `co.in` and merge into
 * one Company row. That is a data-corruption bug in the highest-priority segment,
 * discovered late, and no amount of special-casing gets it right in general —
 * the list of multi-part suffixes is data, not a rule.
 *
 * `tldts` is pinned, has one transitive dependency (its own core), bundles the
 * Public Suffix List as compiled data, and performs no I/O — nothing in it can
 * reach the network, which is what makes it safe to sit inside a system whose
 * central invariant is that `FetchPolicyGate` is the only network path.
 *
 * The PSL lookup itself lives in `core/policy/registrable-domain.ts`, because the
 * robots.txt same-site check needs the identical answer and the two must never
 * disagree about what one site is.
 */

export type CanonicalizeFailure =
  | 'empty'
  | 'unparseable'
  | 'ip_literal'
  | 'localhost'
  | 'no_registrable_domain'
  | 'denied_host'

export type CanonicalizeResult =
  | { ok: true; domain: string }
  | { ok: false; reason: CanonicalizeFailure }

/**
 * Accepts a bare hostname, a hostname with a path, or a full URL, and returns the
 * lowercased registrable domain with scheme, `www.`, userinfo, port, path, query,
 * fragment and any trailing dot removed.
 *
 * Pure. No network, no database, no clock — `handover.md` §11 unit-tests this.
 */
export function canonicalizeDomain(input: string | null | undefined): CanonicalizeResult {
  const raw = (input ?? '').trim()
  if (raw === '') return { ok: false, reason: 'empty' }

  const host = extractHost(raw)
  if (host === null) return { ok: false, reason: 'unparseable' }

  if (host === 'localhost' || host.endsWith('.localhost')) {
    return { ok: false, reason: 'localhost' }
  }

  // An IP literal has no registrable domain, so the two cases are separated here
  // to keep the failure reasons distinct in the audit log.
  if (isIpLiteral(host)) return { ok: false, reason: 'ip_literal' }
  const registrable = registrableDomain(host)
  if (!registrable) return { ok: false, reason: 'no_registrable_domain' }

  const domain = normalizeHost(registrable)

  // A gated platform must never become a Company's canonical domain: that row
  // would later earn a `derived_company` allow entry (F1 handover §8.4) and hand
  // the crawler a host the denylist exists to keep unreachable. The gate refuses
  // it anyway; refusing here means the row is never written in the first place.
  for (const entry of SEED_DENY_HOSTS) {
    if (hostMatches(domain, entry.host, entry.includeSubdomains)) {
      return { ok: false, reason: 'denied_host' }
    }
  }

  return { ok: true, domain }
}

/**
 * Pulls the host out of whatever shape the source gave us. yc-oss websites are
 * mostly full URLs but not reliably: bare domains, missing schemes, trailing
 * paths and stray whitespace all appear.
 */
function extractHost(raw: string): string | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null

  const host = normalizeHost(url.hostname)
  if (host === '') return null
  return host.startsWith('www.') ? host.slice(4) : host
}

/**
 * IPv4 and IPv6 literals. `new URL()` wraps IPv6 in brackets, which is the shape
 * that reaches us.
 */
function isIpLiteral(host: string): boolean {
  if (host.startsWith('[') && host.endsWith(']')) return true
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
}

/** True when two inputs resolve to the same Company. */
export function sameCompanyDomain(a: string, b: string): boolean {
  const ca = canonicalizeDomain(a)
  const cb = canonicalizeDomain(b)
  return ca.ok && cb.ok && ca.domain === cb.domain
}
