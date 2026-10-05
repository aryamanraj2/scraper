#!/usr/bin/env tsx
/**
 * Research named companies' own pages. LIVE, through FetchPolicyGate.
 *
 *   npm run research:pages -- --domains baseten.co,supabase.com
 *   npm run research:pages -- --domains baseten.co --paths /,/about,/company
 *   npm run research:pages -- --domains strava.com --paths https://press.strava.com/articles/...
 *
 * Why this exists beside `intel:run --research`: that command walks the corpus
 * oldest-first and then re-scores every company. F6 step 3b needed something
 * narrower: real "what does this company do" text for the qualified companies whose
 * stored evidence was only job titles or scraped navigation, without touching any score
 * the pilot's qualified set rests on. So this takes an explicit list of domains, and
 * there is deliberately no "all".
 *
 * Every request is the ordinary research path: `researchCompanyPage`, which runs the
 * D4 preflight (host policy, robots.txt, terms, rate, budget), refuses an
 * instruction-shaped page, and writes `company_page` Evidence with an audit row. It
 * scores nothing.
 */
import 'dotenv/config'
import { prisma, disconnectPrisma } from '../src/core/db/client.js'
import { env } from '../src/core/config/config.js'
import { FetchPolicyGate } from '../src/core/policy/fetch-policy-gate.js'
import { researchCompanyPage } from '../src/intel/research/page-research.js'

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

const domains = (flag('domains') ?? '').split(',').map((d) => d.trim()).filter(Boolean)
const paths = (flag('paths') ?? '/,/about').split(',').map((p) => p.trim()).filter(Boolean)
if (domains.length === 0) {
  console.error('Usage: npm run research:pages -- --domains a.com,b.com [--paths /,/about]')
  process.exit(2)
}

const db = prisma()
const config = env()
const gate = new FetchPolicyGate(db, {
  userAgent: config.USER_AGENT,
  robotsTtlSeconds: config.ROBOTS_CACHE_TTL_SECONDS,
  defaultRateDelayMs: config.DEFAULT_HOST_RATE_DELAY_MS,
})

// Path-major, so a host's next page comes after every other host has had a turn. The
// gate refuses a request inside a host's rate window rather than queueing it, and the
// right response to `rate_limited` is to wait, never to retry around it (§1.5). The
// first run of this tool went domain-major and had every second page refused.
const companies = new Map<string, { id: string; canonicalDomain: string; countries: string[] }>()
for (const domain of domains) {
  const company = await db.company.findUnique({
    where: { canonicalDomain: domain },
    select: { id: true, canonicalDomain: true, countries: true },
  })
  if (company) companies.set(domain, company)
  else console.log(`  ${domain.padEnd(24)} not in the corpus; skipped`)
}
for (const path of paths) {
  for (const company of companies.values()) {
    // A full URL (e.g. a press.<domain> article) is fetched as given; scope is still checked downstream.
    const url = path.startsWith('https://') ? path : `https://${company.canonicalDomain}${path}`
    const r = await researchCompanyPage(db, gate, company, url, { sameHostDelayMs: config.DEFAULT_HOST_RATE_DELAY_MS })
    const detail = r.kind === 'refused' ? `${r.reason}: ${r.detail}` : r.kind === 'unusable' ? r.detail : ''
    console.log(`  ${url.padEnd(44)} ${r.kind}${detail ? ` (${detail.slice(0, 80)})` : ''}`)
  }
}

await disconnectPrisma()
