import type { Db } from '../audit/audit-log.js'
import type { HostPolicyOrigin } from '../../../generated/prisma/enums.js'
import { SEED_ALLOW_HOSTS, SEED_DENY_HOSTS, hostMatches, normalizeHost } from './host-lists.js'

export type HostVerdict =
  | { kind: 'denied'; matchedHost: string; note: string | null }
  | { kind: 'allowed'; matchedHost: string; origin: HostPolicyOrigin; termsProhibited: boolean; rateDelayMsOverride: number | null }
  | { kind: 'unknown' }

/**
 * D4 preflight steps 1 and 3.
 *
 * Resolution order, and the reason for it:
 *
 *   1. Deny wins, always, and is checked first — including against the static seed
 *      list, so a denied host is unreachable even if the database is empty or a
 *      future milestone mistakenly writes an allow row for it.
 *   2. An explicit allow entry passes to the next preflight step.
 *   3. An unknown host is refused. The plan's step 1 requires allowlist membership;
 *      employer careers domains get a `derived_company` allow entry when the Company
 *      is normalized in F1, with provenance, rather than being fetched on sight.
 *
 * `termsProhibited` is returned rather than resolved here so the gate can record
 * `terms_prohibited` distinctly from `host_denied`: they are different failures and
 * conflating them would hide a source that changed its terms.
 */
export async function resolveHostPolicy(db: Db, hostInput: string): Promise<HostVerdict> {
  const host = normalizeHost(hostInput)

  for (const entry of SEED_DENY_HOSTS) {
    if (hostMatches(host, entry.host, entry.includeSubdomains)) {
      return { kind: 'denied', matchedHost: entry.host, note: entry.note }
    }
  }

  const rows = await db.hostPolicy.findMany()
  const denied = rows.find(
    (r) => r.mode === 'deny' && hostMatches(host, r.host, r.includeSubdomains),
  )
  if (denied) return { kind: 'denied', matchedHost: denied.host, note: denied.note }

  const allowed = rows.find(
    (r) => r.mode === 'allow' && hostMatches(host, r.host, r.includeSubdomains),
  )
  if (allowed) {
    return {
      kind: 'allowed',
      matchedHost: allowed.host,
      origin: allowed.origin,
      termsProhibited: allowed.termsProhibited,
      rateDelayMsOverride: allowed.rateDelayMsOverride,
    }
  }

  for (const entry of SEED_ALLOW_HOSTS) {
    if (hostMatches(host, entry.host, entry.includeSubdomains)) {
      return {
        kind: 'allowed',
        matchedHost: entry.host,
        origin: 'seed_static',
        termsProhibited: false,
        rateDelayMsOverride: null,
      }
    }
  }

  return { kind: 'unknown' }
}

/**
 * Writes the static seed lists into host_policy so they are visible in the
 * dashboard and auditable alongside operator entries. The in-code lists remain
 * authoritative for deny: seeding is for visibility, not for enforcement, so an
 * unseeded database is still safe.
 */
export async function seedHostPolicies(db: Db): Promise<{ allow: number; deny: number }> {
  for (const entry of SEED_DENY_HOSTS) {
    await db.hostPolicy.upsert({
      where: { host: entry.host },
      create: { host: entry.host, mode: 'deny', origin: 'seed_static', includeSubdomains: entry.includeSubdomains, note: entry.note },
      update: { mode: 'deny', origin: 'seed_static', includeSubdomains: entry.includeSubdomains, note: entry.note },
    })
  }
  for (const entry of SEED_ALLOW_HOSTS) {
    await db.hostPolicy.upsert({
      where: { host: entry.host },
      create: { host: entry.host, mode: 'allow', origin: 'seed_static', includeSubdomains: entry.includeSubdomains, note: entry.note },
      update: { mode: 'allow', origin: 'seed_static', includeSubdomains: entry.includeSubdomains, note: entry.note },
    })
  }
  return { allow: SEED_ALLOW_HOSTS.length, deny: SEED_DENY_HOSTS.length }
}
