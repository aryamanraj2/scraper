import type { Db } from '../../core/audit/audit-log.js'
import { writeAudit } from '../../core/audit/audit-log.js'
import { SEED_DENY_HOSTS, hostMatches, normalizeHost } from '../../core/policy/host-lists.js'

export type DerivedHostInput = {
  companyId: string
  /** The company's canonical domain. */
  host: string
  /** Where the domain came from — the yc-oss feed URL, or the page that named it. */
  sourceUrl: string
}

export type DerivedHostResult =
  | { created: true; host: string }
  | { created: false; reason: 'already_present' | 'denied' }

/**
 * F1 handover §8.4, and the direct consequence of deviation §4.1: an unknown host
 * is refused with `host_denied`, so an employer's own domain is UNFETCHABLE until
 * a `derived_company` allow row exists for it. Creating that row is F1's job,
 * because F1 is where the domain is first learned and where its provenance is
 * still at hand.
 *
 * The row grants very little on its own. It moves the host from "unknown" to
 * "explicitly allowed", and robots.txt, the terms flag, the per-host rate policy
 * and both budget envelopes all still run afterwards. What it changes is that a
 * refusal now means something specific — this host's robots said no — instead of
 * the blanket "we have never heard of this host".
 *
 * Denylisted hosts are refused here even though `resolveHostPolicy` already
 * refuses them at request time. Writing the row anyway would leave a permanent
 * `allow` entry for `linkedin.com` sitting in the table, contradicted only by code
 * — misleading to anyone reading the policy table, and one refactor away from
 * being believed.
 */
export async function ensureDerivedCompanyHost(
  db: Db,
  input: DerivedHostInput,
): Promise<DerivedHostResult> {
  const host = normalizeHost(input.host)

  for (const entry of SEED_DENY_HOSTS) {
    if (hostMatches(host, entry.host, entry.includeSubdomains)) {
      await writeAudit(db, {
        actorType: 'system',
        actorId: 'derived-company-host',
        action: 'host_policy.allow_refused',
        subjectType: 'Company',
        subjectId: input.companyId,
        reasonCode: 'host_denied',
        metadata: { host, matched: entry.host },
      })
      return { created: false, reason: 'denied' }
    }
  }

  const existing = await db.hostPolicy.findUnique({ where: { host }, select: { id: true } })
  if (existing) return { created: false, reason: 'already_present' }

  await db.hostPolicy.create({
    data: {
      host,
      mode: 'allow',
      origin: 'derived_company',
      // Subdomains included: careers pages live on `careers.`, `jobs.` and `www.`
      // at least as often as on the apex, and they are the same employer under the
      // same robots and terms.
      includeSubdomains: true,
      sourceUrl: input.sourceUrl,
      note: `canonical domain of Company ${input.companyId}`,
    },
  })

  await writeAudit(db, {
    actorType: 'system',
    actorId: 'derived-company-host',
    action: 'host_policy.allow_created',
    subjectType: 'Company',
    subjectId: input.companyId,
    metadata: { host, origin: 'derived_company', sourceUrl: input.sourceUrl },
  })

  return { created: true, host }
}
