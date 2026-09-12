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
  /**
   * Of the measured companies, those whose path walk was cut short by OUR OWN
   * per-company research cap rather than by the employer running out of pages.
   *
   * This is the distinction `companiesMeasured` does not make, and it is the one that
   * decides whether the yield number means anything. The curator tries up to five
   * paths and stops early on `budget_exhausted`, which is correct — there is no
   * headroom and every further page costs more — but a company that was refused at
   * `/contact` because the cap ran out has not been asked the question the yield
   * report claims to answer. Counting it as a zero-yield company reports "this
   * employer publishes no address" on the strength of a page we declined to fetch.
   *
   * Counted over the company's LATEST walk only. It used to count the whole audit
   * log, which made truncation a permanent property: a company cut short under F4's
   * cap of 20 stayed truncated after F5a raised the cap to 200 and a later run walked
   * it to the end, so the report refused a verdict on a yield it had just measured.
   *
   * Measured live under the cap of 20: 38 of 56 measured companies. Under 200 and a
   * five-path walk (F5b): 2 of 99.
   */
  companiesTruncatedByBudget: number
  /**
   * Measured, and walked to the end of the path list.
   *
   * Not a clean denominator either, and the report says so: the curator stops on its
   * first hit, so a company that yielded early spent one credit and could not have
   * been truncated. Being fully walked is partly CAUSED by yielding, which biases this
   * subset upward. It is the ceiling to `companiesMeasured`'s floor.
   */
  companiesFullyWalked: number
  companiesWithContact: number
  companiesWithZero: number
  /** Of the companies with a contact, those with a ROLE ALIAS rather than a person. */
  companiesWithAlias: number
  /** The same, restricted to fully-walked companies — the numerator that matches the denominator. */
  companiesWithAliasFullyWalked: number
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
 * Which attempted company a refused URL belongs to, or null.
 *
 * Subdomains count — the curator follows redirects through the gate, so an
 * apex-to-`www` hop is refused under `www.` while the company row holds the apex.
 *
 * It returns the company rather than a boolean because a refusal has to be
 * attributable: "98 budget refusals happened somewhere" and "38 companies were cut
 * short mid-walk" are the same rows and only the second is a finding.
 */
function companyForRefusedUrl(
  url: string,
  domainToCompany: ReadonlyMap<string, string>,
): string | null {
  let host: string
  try {
    host = new URL(url).host.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
  for (const [domain, companyId] of domainToCompany) {
    if (host === domain || host.endsWith(`.${domain}`)) return companyId
  }
  return null
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
    select: { subjectId: true, metadata: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  })
  const attemptedIds = new Set<string>()
  /**
   * When each company's LATEST walk happened, and when the one before it did.
   *
   * `companiesTruncatedByBudget` counted `budget_exhausted` refusals over the whole
   * audit log, so a company cut short under F4's cap of 20 stayed "truncated"
   * forever — including after F5a raised the cap to 200 and a later run walked it to
   * the end. The report would then refuse a verdict on a yield it had just finished
   * measuring, which is the mistake F5a §5 exists to prevent, one run further on.
   *
   * The window is exclusive at the previous walk and inclusive at the latest,
   * because the gate writes a refusal DURING the walk and the curator writes
   * `contact.curated` after it. A company walked only once has no lower bound.
   */
  const walkWindow = new Map<string, { latest: Date; previous: Date | null }>()
  // A company whose pages were all refused before a request was issued has been
  // ATTEMPTED but not MEASURED, and the two must not be averaged together: a
  // zero-yield count that includes unread companies reads as evidence that employers
  // publish no addresses, when it is evidence that we never looked.
  const measuredIds = new Set<string>()
  for (const a of attempts) {
    if (a.subjectId === null) continue
    attemptedIds.add(a.subjectId)
    // `attempts` is ordered newest first, so the first row seen for a company is its
    // latest walk and the second is the one before it.
    const seen = walkWindow.get(a.subjectId)
    if (seen === undefined) walkWindow.set(a.subjectId, { latest: a.createdAt, previous: null })
    else if (seen.previous === null) seen.previous = a.createdAt
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
      select: { subjectId: true, reasonCode: true, createdAt: true },
    }),
  ])

  const refusalsByReason: Record<string, number> = {}
  for (const r of contactRefusals) if (r.reasonCode) refusalsByReason[r.reasonCode] = r._count._all

  // Only refusals on a host belonging to a company the curator attempted. Everything
  // else in this table is F2's page research, and attributing it here would report a
  // clean curation run as one full of refusals.
  const domainToCompany = new Map(
    (
      await db.company.findMany({
        where: { id: { in: [...attemptedIds] } },
        select: { id: true, canonicalDomain: true },
      })
    ).map((c) => [c.canonicalDomain, c.id] as const),
  )
  const preflightRefusalsByReason: Record<string, number> = {}
  const truncatedIds = new Set<string>()
  for (const r of preflightRefusals) {
    if (!r.reasonCode || !r.subjectId) continue
    const companyId = companyForRefusedUrl(r.subjectId, domainToCompany)
    if (companyId === null) continue
    preflightRefusalsByReason[r.reasonCode] = (preflightRefusalsByReason[r.reasonCode] ?? 0) + 1
    // A company that read a page and was then refused for want of budget was asked a
    // narrower question than the report claims to have asked it.
    if (r.reasonCode === 'budget_exhausted' && measuredIds.has(companyId)) {
      const window = walkWindow.get(companyId)
      const belongsToLatestWalk =
        window !== undefined &&
        r.createdAt <= window.latest &&
        (window.previous === null || r.createdAt > window.previous)
      if (belongsToLatestWalk) truncatedIds.add(companyId)
    }
  }

  const fullyWalkedIds = [...measuredIds].filter((id) => !truncatedIds.has(id))

  return {
    companiesAttempted: attemptedIds.size,
    companiesMeasured: measuredIds.size,
    companiesTruncatedByBudget: truncatedIds.size,
    companiesFullyWalked: fullyWalkedIds.length,
    companiesWithContact: perCompany.size,
    companiesWithZero: zeroIds.length,
    companiesWithAlias: aliasCompanies.size,
    companiesWithAliasFullyWalked: fullyWalkedIds.filter((id) => aliasCompanies.has(id)).length,
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

  const prefix =
    measured < y.companiesAttempted
      ? `Only ${measured} of ${y.companiesAttempted} companies had a page read; the rest were refused before a request was issued ` +
        `(${JSON.stringify(y.preflightRefusalsByReason)}). `
      : ''

  // The correction that matters most to the buy decision, and the one the raw
  // "N of M had a page read" line hides. A company cut off at `/careers` because its
  // 20-credit envelope ran out was asked about one page, not five, and calling it
  // zero-yield states a fact about the employer on the strength of a page we chose not
  // to fetch.
  //
  // **And the obvious repair — rate the subset that was walked to the end — is a
  // second wrong number, not a right one.** The curator stops the moment it finds a
  // recruiting route, so a company that yields on `/careers` spends one credit and can
  // never be truncated, while a company that yields nothing keeps walking until the
  // cap stops it. Yielding is therefore a CAUSE of being fully walked, and the
  // fully-walked rate is biased upward by construction.
  //
  // So there are two numbers and neither is the answer: the all-measured rate is a
  // floor, the fully-walked rate is a ceiling, and the honest output is to say so and
  // refuse the verdict. That is the same position this function already takes when
  // nothing was read at all — a confident rate derived from pages nobody fetched is
  // worse than no rate.
  if (y.companiesTruncatedByBudget > 0) {
    const floor = ((y.companiesWithAlias / measured) * 100).toFixed(0)
    const walked = y.companiesFullyWalked
    const ceiling =
      walked === 0 ? null : ((y.companiesWithAliasFullyWalked / walked) * 100).toFixed(0)
    return (
      `${prefix}NO VERDICT — the yield has not been measured. ${y.companiesTruncatedByBudget} of the ${measured} ` +
      `measured companies were cut short mid-walk by OUR per-company research cap, not by the employer. ` +
      `Rating all ${measured} gives ${floor}%, which is a FLOOR: the truncated companies were never fully asked. ` +
      (ceiling === null
        ? `No company was walked to the end of the path list, so there is no upper bound either. `
        : `Rating the ${walked} walked to the end gives ${ceiling}%, which is a CEILING: the curator stops on its ` +
          `first hit, so a company that yielded early could not have been truncated, and the fully-walked subset is ` +
          `biased towards yielders by construction. `) +
      `Raise the per-company credits cap and re-run the curator before quoting a rate to a vendor decision.`
    )
  }

  return prefix + verdictFromRate(y.companiesWithAlias / measured)
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
