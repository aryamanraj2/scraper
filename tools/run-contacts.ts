#!/usr/bin/env tsx
/**
 * Tier A contact curation — **LIVE**. Reads employer careers/contact/jobs pages
 * through `FetchPolicyGate` and stores the role aliases and published HR addresses it
 * finds.
 *
 * This is the fourth command in the project that touches a live source, after
 * `ingest:seed`, `fixtures:record` and `intel:run -- --research N`. It goes through
 * the same gate, charges the same research budget, and refuses the same way.
 *
 *   npm run contacts:curate -- --limit 20      curate up to N qualified companies
 *   npm run contacts:curate -- --all           every qualified company
 *   npm run contacts:curate -- --max-pages 5   try the whole path list, not just 3
 *   npm run contacts:curate -- --report        yield report only, no network
 *
 * No provider is called and no address is constructed: §1.2 is untouched by this path.
 */
import 'dotenv/config'
import { prisma, disconnectPrisma } from '../src/core/db/client.js'
import { env } from '../src/core/config/config.js'
import { FetchPolicyGate } from '../src/core/policy/fetch-policy-gate.js'
import { curateCompanyContacts } from '../src/outreach/contacts/curate.js'
import { providerVerdict, tierAYield } from '../src/outreach/contacts/yield-report.js'

const args = process.argv.slice(2)
const has = (f: string) => args.includes(f)
const val = (f: string) => {
  const i = args.indexOf(f)
  return i >= 0 ? args[i + 1] : undefined
}

const db = prisma()
const config = env()

if (!has('--report')) {
  const limit = has('--all') ? undefined : Number(val('--limit') ?? 10)

  // Raising the cap costs nothing on a company that yields: the curator stops the
  // moment it finds an alias. The cost falls entirely on companies that publish no
  // address — which is precisely the population the yield question is about, so
  // measuring them on three of five paths understates the answer that decides
  // whether a paid provider gets bought.
  const maxPages = val('--max-pages') === undefined ? undefined : Number(val('--max-pages'))

  // Qualified leads only. Curating the whole corpus would spend research budget on
  // companies the scorer already rejected, and a contact for a rejected company is a
  // row nothing will ever use.
  const leads = await db.lead.findMany({
    where: { status: { in: ['qualified', 'accepted'] } },
    select: {
      company: { select: { id: true, canonicalDomain: true, displayName: true, countries: true } },
    },
    orderBy: { score: 'desc' },
    ...(limit === undefined ? {} : { take: limit }),
  })

  console.log(`\nCurating Tier A contacts for ${leads.length} qualified compan(ies). LIVE.\n`)

  const gate = new FetchPolicyGate(db, {
    userAgent: config.USER_AGENT,
    robotsTtlSeconds: config.ROBOTS_CACHE_TTL_SECONDS,
    defaultRateDelayMs: config.DEFAULT_HOST_RATE_DELAY_MS,
  })

  let n = 0
  for (const lead of leads) {
    n += 1
    // Every candidate path is on one employer host, so D4 step 4's spacing applies
    // between them. The gate refuses a too-early request rather than queueing it, so
    // this wait is what makes curation read more than one page per company — the
    // first live run without it reported five zero-yield companies it had never read.
    const outcome = await curateCompanyContacts(db, gate, lead.company, {
      interPageDelayMs: config.DEFAULT_HOST_RATE_DELAY_MS,
      ...(maxPages === undefined ? {} : { maxPages }),
    })
    const found = outcome.contacts.map((c) => `${c.email} (${c.contactType}/${c.pageKind})`).join(', ')
    console.log(
      `  ${String(n).padStart(3)}/${leads.length}  ${lead.company.displayName.padEnd(18)} ` +
        `${outcome.pagesRead.length} page(s) → ${outcome.contacts.length} contact(s)` +
        (outcome.executivesRejected > 0 ? ` · ${outcome.executivesRejected} exec rejected` : '') +
        (found ? `\n              ${found}` : '') +
        (outcome.contacts.length === 0 && outcome.refusals.length > 0
          ? `\n              refused: ${outcome.refusals.map((r) => r.reason).join(', ')}`
          : ''),
    )
  }
}

const y = await tierAYield(db)
console.log('\n── Tier A yield ──\n')
console.log(`  companies attempted      ${y.companiesAttempted}`)
console.log(`  pages actually read for  ${y.companiesMeasured}   <- the yield denominator`)
console.log(`  with at least 1 contact  ${y.companiesWithContact}`)
console.log(`  with a ROLE ALIAS        ${y.companiesWithAlias}`)
console.log(`  yielded zero             ${y.companiesWithZero}`)
console.log(`  total contacts           ${y.totalContacts}`)
console.log(
  `  per company              mean ${y.contactsPerCompany.mean} · median ${y.contactsPerCompany.median} · max ${y.contactsPerCompany.max}`,
)
console.log(`  by page kind             ${JSON.stringify(y.byPageKind)}`)
console.log(`  by contact type          ${JSON.stringify(y.byContactType)}`)
console.log(`  executives rejected      ${y.executivesRejected}`)
console.log(`  refusals by reason       ${JSON.stringify(y.refusalsByReason)}`)
console.log(`  preflight refusals       ${JSON.stringify(y.preflightRefusalsByReason)}`)
if (y.zeroYieldCompanies.length > 0) {
  console.log(`\n  zero-yield companies:`)
  for (const c of y.zeroYieldCompanies.slice(0, 25)) console.log(`      ${c.name} (${c.domain})`)
}
console.log(`\n  VERDICT: ${providerVerdict(y)}\n`)

await disconnectPrisma()
