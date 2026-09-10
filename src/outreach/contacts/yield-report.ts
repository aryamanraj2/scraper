import type { Db } from '../../core/audit/audit-log.js'

/**
 * Tier A yield — the measurement the operator asked for, and the one nobody had.
 *
 * > *"Contacts found per company, how many companies yielded zero, and which page
 * > types produced them. That number decides whether a paid provider is worth buying,
 * > and right now nobody has it."*
 *
 * The decision it informs is concrete: if employer pages already yield a usable
 * recruiting route for most qualified companies, Tier B is a quality addition and the
 * `handover.md` §1.2 amendment can stay unexercised. If they mostly yield nothing,
 * Tier A cannot reach 1,000-2,000 contacts on its own and a paid provider is the only
 * way there — at which point the amendment has to be exercised deliberately, with a
 * vendor's terms actually read.
 *
 * Everything here reads stored rows. No network, no recomputation.
 */

export type TierAYield = {
  /** Companies the curator actually attempted. */
  companiesAttempted: number
  /**
   * Companies where at least one page was actually READ. An attempted company whose
   * every path was refused at the preflight has not been measured, and counting it as
   * a zero-yield company would report "employers publish no addresses" when the truth
   * is "we never looked".
   */
  companiesMeasured: number
  companiesWithContact: number
  companiesWithZero: number
  /** Of the companies with a contact, those with a ROLE ALIAS rather than a person. */
  companiesWithAlias: number
  totalContacts: number
  contactsPerCompany: { mean: number; median: number; max: number }
  byPageKind: Record<string, number>
  byContactType: Record<string, number>
  executivesRejected: number
  /** The curator's own refusals, by reason: executives, off-domain, injection. */
  refusalsByReason: Record<string, number>
  /**
   * Refusals the GATE recorded before a request was issued, by reason. Separate
   * because these are the ones that mean "we never read the page", and a zero-yield
   * company with a preflight refusal behind it has not been measured at all.
   */
  preflightRefusalsByReason: Record<string, number>
  zeroYieldCompanies: { companyId: string; name: string; domain: string }[]
}

const ALIAS_TYPES = new Set(['careers_alias', 'talent_alias', 'university_recruiting'])

/**
 * Whether a refused URL sits on one of the attempted companies' domains.
 *
 * Subdomains count — the curator follows redirects through the gate, so an
 * apex-to-`www` hop is refused under `www.` while the company row holds the apex.
 */
function hostBelongsTo(url: string, domains: ReadonlySet<string>): boolean {
  let host: string
  try {
    host = new URL(url).host.toLowerCase().replace(/^www\./, '')
  } catch {
    return false
  }
  for (const d of domains) if (host === d || host.endsWith(`.${d}`)) return true
  return false
}

export async function tierAYield(db: Db, companyIds?: string[]): Promise<TierAYield> {
  const where = companyIds ? { companyId: { in: companyIds } } : {}

  const contacts = await db.contact.findMany({
    where: { ...where, discoveryMethod: 'page_published' },
    select: {
      companyId: true,
      contactType: true,
      sourcePageKind: true,
      company: { select: { displayName: true, canonicalDomain: true } },
    },
  })

  // "Attempted" is what the curator tried, not what it found — a company that yielded
  // nothing has no Contact row, so counting rows alone would make the zero-yield
  // number silently zero. The audit trail is the only record that an attempt happened.
  const attempts = await db.auditLog.findMany({
    where: {
      action: 'contact.curated',
      ...(companyIds ? { subjectId: { in: companyIds } } : {}),
    },
    select: { subjectId: true, metadata: true },
    orderBy: { createdAt: 'desc' },
  })
  const attemptedIds = new Set<string>()
  // A company whose pages were all refused before a request was issued has been
  // ATTEMPTED but not MEASURED, and the two must not be averaged together: a
  // zero-yield count that includes unread companies reads as evidence that employers
  // publish no addresses, when it is evidence that we never looked.
  const measuredIds = new Set<string>()
  for (const a of attempts) {
    if (a.subjectId === null) continue
    attemptedIds.add(a.subjectId)
    const pagesRead = (a.metadata as { pagesRead?: unknown } | null)?.pagesRead
    if (typeof pagesRead === 'number' && pagesRead > 0) measuredIds.add(a.subjectId)
  }

  const perCompany = new Map<string, number>()
  const byPageKind: Record<string, number> = {}
  const byContactType: Record<string, number> = {}
  const aliasCompanies = new Set<string>()
  const named = new Map<string, { name: string; domain: string }>()

  for (const c of contacts) {
    perCompany.set(c.companyId, (perCompany.get(c.companyId) ?? 0) + 1)
    const kind = c.sourcePageKind ?? 'unknown'
    byPageKind[kind] = (byPageKind[kind] ?? 0) + 1
    byContactType[c.contactType] = (byContactType[c.contactType] ?? 0) + 1
    if (ALIAS_TYPES.has(c.contactType)) aliasCompanies.add(c.companyId)
    named.set(c.companyId, { name: c.company.displayName, domain: c.company.canonicalDomain })
  }

  // Measured, not attempted: a company whose pages were never read published nothing
  // we can speak to, and calling it "zero yield" would be a finding about the
  // employer drawn from a request we did not make.
  const zeroIds = [...measuredIds].filter((id) => !perCompany.has(id))
  const zeroCompanies = await db.company.findMany({
    where: { id: { in: zeroIds } },
    select: { id: true, displayName: true, canonicalDomain: true },
  })

  const counts = [...perCompany.values()].sort((a, b) => a - b)
  const median = counts.length === 0 ? 0 : counts[Math.floor(counts.length / 2)]!
  const mean = counts.length === 0 ? 0 : counts.reduce((a, b) => a + b, 0) / counts.length

  // Scoped the same way every other figure is. Without the filter these two counted
  // the whole audit log while the rest of the report described a subset, so a scoped
  // call silently reported refusals belonging to companies it was not asked about.
  const auditScope = companyIds ? { subjectId: { in: companyIds } } : {}

  const [execRefusals, contactRefusals, preflightRefusals] = await Promise.all([
    db.auditLog.count({
      where: { ...auditScope, action: 'contact.refused', reasonCode: 'executive_only_contact' },
    }),
    db.auditLog.groupBy({
      by: ['reasonCode'],
      where: {
        ...auditScope,
        action: { in: ['contact.refused', 'contact.injection_blocked'] },
        reasonCode: { not: null },
      },
      _count: { _all: true },
    }),
    // Preflight refusals are recorded by the GATE, under `fetch.refused` with a URL
    // as the subject — not by the curator. Counting only the curator's own actions
    // reported `{}` on a run where pages were refused before they were read, which is
    // the opposite of what this field exists to show. Part G: a source disappearing
    // behind a robots or terms change must be VISIBLE rather than mistaken for absent
    // data.
    //
    // Grouped in JS rather than by SQL because the gate's subject is a URL, so the
    // only way to attribute a refusal to a company is to match its host — and an
    // unattributed count is worse than none here. The first version counted every
    // `fetch.refused` row in the database, so a curation run that refused nothing
    // still reported F2's research refusals as if they were its own.
    db.auditLog.findMany({
      where: { action: 'fetch.refused', reasonCode: { not: null } },
      select: { subjectId: true, reasonCode: true },
    }),
  ])

  const refusalsByReason: Record<string, number> = {}
  for (const r of contactRefusals) if (r.reasonCode) refusalsByReason[r.reasonCode] = r._count._all

  // Only refusals on a host belonging to a company the curator attempted. Everything
  // else in this table is F2's page research, and attributing it here would report a
  // clean curation run as one full of refusals.
  const attemptedHosts = new Set(
    (
      await db.company.findMany({
        where: { id: { in: [...attemptedIds] } },
        select: { canonicalDomain: true },
      })
    ).map((c) => c.canonicalDomain),
  )
  const preflightRefusalsByReason: Record<string, number> = {}
  for (const r of preflightRefusals) {
    if (!r.reasonCode || !r.subjectId) continue
    if (!hostBelongsTo(r.subjectId, attemptedHosts)) continue
    preflightRefusalsByReason[r.reasonCode] = (preflightRefusalsByReason[r.reasonCode] ?? 0) + 1
  }

  return {
    companiesAttempted: attemptedIds.size,
    companiesMeasured: measuredIds.size,
    companiesWithContact: perCompany.size,
    companiesWithZero: zeroIds.length,
    companiesWithAlias: aliasCompanies.size,
    totalContacts: contacts.length,
    contactsPerCompany: {
      mean: Number(mean.toFixed(2)),
      median,
      max: counts.length === 0 ? 0 : counts[counts.length - 1]!,
    },
    byPageKind,
    byContactType,
    executivesRejected: execRefusals,
    refusalsByReason,
    preflightRefusalsByReason,
    zeroYieldCompanies: zeroCompanies.map((c) => ({
      companyId: c.id,
      name: c.displayName,
      domain: c.canonicalDomain,
    })),
  }
}

/**
 * The line the yield number exists to support, stated in the report rather than left
 * for the reader to work out.
 */
/**
 * The line the yield number exists to support — and the refusal to state one when the
 * number has not actually been measured.
 *
 * The first live run refused every company `rate_limited` before reading a page, and
 * an earlier version of this function read that as "0% published a role alias" and
 * recommended buying a data broker. A verdict that confident, derived from pages
 * nobody fetched, is worse than no verdict: it is exactly the shape of B3's warning
 * about a panel that renders empty and implies a finding. So a run whose companies
 * were mostly never read reports that it was never read.
 */
export function providerVerdict(y: TierAYield): string {
  if (y.companiesAttempted === 0) return 'No companies attempted yet — run the curator first.'

  const measured = y.companiesMeasured
  if (measured === 0) {
    return `0 of ${y.companiesAttempted} companies had a page read — every one was refused before a request was issued. This is NOT a yield of zero; nothing has been measured. Refusals: ${JSON.stringify(y.preflightRefusalsByReason)}`
  }
  if (measured < y.companiesAttempted) {
    return (
      `Only ${measured} of ${y.companiesAttempted} companies had a page read; the rest were refused before a request was issued ` +
      `(${JSON.stringify(y.preflightRefusalsByReason)}). Rate the yield on the ${measured} measured, not on the attempted. ` +
      verdictFromRate(y.companiesWithAlias / measured)
    )
  }
  return verdictFromRate(y.companiesWithAlias / measured)
}

function verdictFromRate(aliasRate: number): string {
  const pct = (aliasRate * 100).toFixed(0)
  if (aliasRate >= 0.6) {
    return `${pct}% of companies published a role alias. Tier A carries the volume; a paid provider would be a quality addition, not a necessity. handover.md §1.2 can stay unexercised.`
  }
  if (aliasRate >= 0.3) {
    return `${pct}% of companies published a role alias. Tier A alone reaches roughly ${Math.round(aliasRate * 2000)} contacts at a 2,000-company corpus — short of target. Widening the corpus is the cheaper lever than buying a provider; measure again after.`
  }
  return `${pct}% of companies published a role alias. Tier A cannot reach the target on its own at any plausible corpus size. Reaching 1,000-2,000 contacts means exercising the §1.2 amendment with a real vendor — terms read first.`
}
