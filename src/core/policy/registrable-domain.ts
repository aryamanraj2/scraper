import { parse as parseDomain } from 'tldts'

/**
 * The registrable domain of a host, using the Public Suffix List.
 *
 * Lives in `core/policy` rather than in the ingest layer because two different
 * callers need the same answer and must not disagree about it: domain
 * canonicalization (`Company.canonicalDomain`, the join key) and the robots.txt
 * same-site check. A hand-rolled "last two labels" rule gets both wrong on
 * `.co.in`, `.co.uk` and every other multi-part suffix — see
 * `src/ingest/domain/canonicalize.ts` for why that matters here specifically.
 *
 * `allowPrivateDomains: true` keeps `acme.vercel.app` and `other.vercel.app`
 * distinct rather than collapsing them into the hosting provider.
 *
 * `tldts` performs no I/O. That is a requirement, not a convenience: this module
 * is imported by the policy layer, which sits underneath the rule that
 * `FetchPolicyGate` is the only path to the network.
 */
export function registrableDomain(host: string): string | null {
  const parsed = parseDomain(host, { allowPrivateDomains: true })
  if (parsed.isIp) return null
  return parsed.domain ?? null
}

/**
 * True when two hosts belong to the same registrable domain — `acme.com` and
 * `www.acme.com`, but not `acme.com` and `acme.co`.
 */
export function isSameSite(a: string, b: string): boolean {
  const da = registrableDomain(a)
  const db = registrableDomain(b)
  return da !== null && da === db
}
