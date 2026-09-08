import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { seedHostPolicies } from '../../src/core/policy/host-policy.js'
import { YC_OSS_FEEDS, YcOssSeedProvider, YC_SOURCE_KEYS, type YcSourceKey } from '../../src/ingest/yc/yc-oss.js'
import { runSeedIngest } from '../../src/ingest/yc/seed-loader.js'
import {
  DEFAULT_COMPANY_CREDITS_CAP,
  INDIA_COMPANY_CREDITS_CAP,
} from '../../src/ingest/budget/company-budget.js'
import { StubFetcher, readFixture } from '../helpers/fixtures.js'
import { closeTestDb, testDb, truncateAll } from '../helpers/db.js'

const HIRING_FEED = YC_OSS_FEEDS.hiring

beforeEach(async () => {
  await truncateAll()
  await seedHostPolicies(testDb())
})
afterAll(async () => closeTestDb())

function loaderFor(body: string, opts: { limit?: number } = {}) {
  const fetcher = new StubFetcher({ [HIRING_FEED]: { body } })
  return {
    fetcher,
    provider: new YcOssSeedProvider(fetcher, { feed: 'hiring', ...opts }),
  }
}

function recordsFromFixture(): Record<string, unknown>[] {
  return JSON.parse(readFixture('yc-oss-companies-hiring')) as Record<string, unknown>[]
}

describe('yc-oss seed ingest', () => {
  it('normalizes the recorded feed into Company rows', async () => {
    const { provider } = loaderFor(readFixture('yc-oss-companies-hiring'))
    const result = await runSeedIngest(testDb(), provider)

    expect(result.sourceFailure).toBeUndefined()
    expect(result.created).toBeGreaterThan(0)
    expect(result.created + result.skipped.length).toBe(result.seen)

    const companies = await testDb().company.findMany()
    expect(companies.length).toBe(result.created)
    for (const company of companies) {
      expect(company.canonicalDomain).not.toBe('')
      expect(company.canonicalDomain).not.toMatch(/^https?:/)
      expect(company.canonicalDomain).not.toMatch(/^www\./)
      expect(company.displayName).not.toBe('')
      expect(company.ycId).not.toBeNull()
      expect(company.status).toBe('normalized')
    }
  })

  it('retains the fields Part F names, including the ones F0 had no column for', async () => {
    const { provider } = loaderFor(readFixture('yc-oss-companies-hiring'))
    await runSeedIngest(testDb(), provider)

    const circuithub = await testDb().company.findUnique({ where: { canonicalDomain: 'circuithub.com' } })
    expect(circuithub).toMatchObject({
      displayName: 'CircuitHub',
      ycId: '5',
      ycBatch: 'Winter 2012',
      teamSize: 58,
      ycOneLiner: 'On-Demand Electronics Manufacturing',
      ycIsHiring: true,
      ycStatus: 'Active',
    })
    expect(circuithub?.locations).toEqual(['London, England, United Kingdom'])
    expect(circuithub?.countries).toEqual(['United Kingdom'])
    expect(circuithub?.ycLongDescription).toContain('CircuitHub offers on-demand electronics manufacturing')
    expect(circuithub?.tags).toContain('Robotics')
  })

  it('splits multi-office location strings and drops "Remote" from countries', async () => {
    const records = recordsFromFixture()
    const multi = { ...records[0], id: 9001, name: 'Multi', website: 'https://multi.example', all_locations: 'Bengaluru, Karnataka, India; San Francisco, CA, USA; Remote' }
    const { provider } = loaderFor(JSON.stringify([multi]))
    await runSeedIngest(testDb(), provider)

    const company = await testDb().company.findUnique({ where: { canonicalDomain: 'multi.example' } })
    expect(company?.locations).toEqual([
      'Bengaluru, Karnataka, India',
      'San Francisco, CA, USA',
      'Remote',
    ])
    expect(company?.countries).toEqual(['India', 'USA'])
  })

  it('is idempotent: a second run updates rather than duplicating', async () => {
    const body = readFixture('yc-oss-companies-hiring')
    const first = await runSeedIngest(testDb(), loaderFor(body).provider)
    const second = await runSeedIngest(testDb(), loaderFor(body).provider)

    expect(second.created).toBe(0)
    expect(second.updated).toBe(first.created)
    expect(await testDb().company.count()).toBe(first.created)
  })

  /**
   * ~13 Evidence rows per company against a daily-refreshed feed of ~1,480 hiring
   * companies: a loader that rewrote provenance every run would add tens of
   * thousands of identical rows a week, and `Evidence` would stop recording what
   * changed and start recording how often we looked.
   */
  it('writes no new Evidence when a record has not changed', async () => {
    const body = readFixture('yc-oss-companies-hiring')
    await runSeedIngest(testDb(), loaderFor(body, { limit: 5 }).provider)
    const after = await testDb().evidence.count()
    const signals = await testDb().companySignal.count()

    const second = await runSeedIngest(testDb(), loaderFor(body, { limit: 5 }).provider)

    expect(second.unchanged).toBe(5)
    expect(await testDb().evidence.count()).toBe(after)
    expect(await testDb().companySignal.count()).toBe(signals)

    const audit = await testDb().auditLog.findMany({
      where: { action: 'seed.record_unchanged' },
    })
    expect(audit).toHaveLength(5)
    expect(audit.every((a) => a.reasonCode === 'content_unchanged')).toBe(true)
  })

  it('writes fresh Evidence when a record actually changes', async () => {
    const base = recordsFromFixture()[0]!
    const first = JSON.stringify([{ ...base, id: 77, name: 'Shifty', website: 'https://shifty.example', team_size: 10 }])
    await runSeedIngest(testDb(), loaderFor(first).provider)
    const before = await testDb().evidence.count()

    const changed = JSON.stringify([{ ...base, id: 77, name: 'Shifty', website: 'https://shifty.example', team_size: 42 }])
    const result = await runSeedIngest(testDb(), loaderFor(changed).provider)

    expect(result.unchanged).toBe(0)
    expect(await testDb().evidence.count()).toBeGreaterThan(before)
    const company = await testDb().company.findUnique({ where: { canonicalDomain: 'shifty.example' } })
    expect(company?.teamSize).toBe(42)
  })

  it('honours the record limit, so a run can be sized to F1s 100-200 target', async () => {
    const { provider } = loaderFor(readFixture('yc-oss-companies-hiring'), { limit: 5 })
    const result = await runSeedIngest(testDb(), provider)
    expect(result.seen).toBe(5)
  })
})

describe('seed ingest reason codes', () => {
  /**
   * §6's F1 obligation: `duplicate` must be reachable through the real ingestion
   * path. Two YC records resolving to one registrable domain is the real case —
   * the unique index would raise a constraint error, and this makes it a recorded
   * decision instead.
   */
  it('records `duplicate` when two records resolve to one canonical domain', async () => {
    const records = recordsFromFixture()
    const base = records[0]!
    const body = JSON.stringify([
      { ...base, id: 1, name: 'Acme', website: 'https://acme.example' },
      { ...base, id: 2, name: 'Acme (dup)', website: 'http://www.acme.example/careers' },
    ])
    const result = await runSeedIngest(testDb(), loaderFor(body).provider)

    expect(result.created).toBe(1)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]).toMatchObject({ externalId: '2', reason: 'duplicate' })

    const audit = await testDb().auditLog.findMany({ where: { reasonCode: 'duplicate' } })
    expect(audit).toHaveLength(1)
  })

  it('records `source_unavailable` for a record with no usable website', async () => {
    const base = recordsFromFixture()[0]!
    const body = JSON.stringify([
      { ...base, id: 3, name: 'No site', website: '' },
      { ...base, id: 4, name: 'IP only', website: 'http://192.168.0.1/' },
    ])
    const result = await runSeedIngest(testDb(), loaderFor(body).provider)

    expect(result.created).toBe(0)
    expect(result.skipped.map((s) => s.reason)).toEqual(['source_unavailable', 'source_unavailable'])
  })

  it('records `source_unavailable` when the feed itself fails, and creates nothing', async () => {
    const fetcher = new StubFetcher({ [HIRING_FEED]: { statusCode: 503, body: 'upstream error' } })
    const result = await runSeedIngest(testDb(), new YcOssSeedProvider(fetcher, { feed: 'hiring' }))

    expect(result.sourceFailure?.reason).toBe('source_unavailable')
    expect(await testDb().company.count()).toBe(0)
  })

  it('surfaces a preflight refusal as that refusal, not as missing data', async () => {
    const fetcher = new StubFetcher({}, { [HIRING_FEED]: 'robots_disallowed' })
    const result = await runSeedIngest(testDb(), new YcOssSeedProvider(fetcher, { feed: 'hiring' }))

    expect(result.sourceFailure?.reason).toBe('robots_disallowed')
    expect(await testDb().company.count()).toBe(0)
  })

  /**
   * handover.md §1.4: a gated platform must never become a Company. If it did, the
   * next step would create a `derived_company` allow row for it — the denylist
   * being undone by ingestion.
   */
  it('never creates a Company, or a host allow row, for a denylisted domain', async () => {
    const base = recordsFromFixture()[0]!
    const body = JSON.stringify([
      { ...base, id: 5, name: 'Fake', website: 'https://www.linkedin.com/company/fake' },
    ])
    const result = await runSeedIngest(testDb(), loaderFor(body).provider)

    expect(result.created).toBe(0)
    expect(result.skipped[0]?.reason).toBe('source_unavailable')
    const linkedin = await testDb().hostPolicy.findUnique({ where: { host: 'linkedin.com' } })
    expect(linkedin?.mode).toBe('deny')
  })
})

describe('the derived_company obligation (F1 handover §8.4)', () => {
  it('creates an allow entry per company, with provenance', async () => {
    const { provider } = loaderFor(readFixture('yc-oss-companies-hiring'), { limit: 3 })
    await runSeedIngest(testDb(), provider)

    const companies = await testDb().company.findMany()
    for (const company of companies) {
      const policy = await testDb().hostPolicy.findUnique({
        where: { host: company.canonicalDomain },
      })
      expect(policy, company.canonicalDomain).toMatchObject({
        mode: 'allow',
        origin: 'derived_company',
        includeSubdomains: true,
      })
      expect(policy?.sourceUrl).toBe(HIRING_FEED)
      expect(policy?.note).toContain(company.id)
    }
  })

  /**
   * An allow row is not a fetch permit. robots, terms, rate policy and budget all
   * still run — that is deviation §4.1's whole point, and it would be easy to
   * believe otherwise.
   */
  it('grants nothing on its own: the host is allowed but still robots-checked', async () => {
    const { provider } = loaderFor(readFixture('yc-oss-companies-hiring'), { limit: 1 })
    await runSeedIngest(testDb(), provider)
    const company = (await testDb().company.findMany())[0]!

    const { resolveHostPolicy } = await import('../../src/core/policy/host-policy.js')
    const verdict = await resolveHostPolicy(testDb(), company.canonicalDomain)
    expect(verdict).toMatchObject({ kind: 'allowed', origin: 'derived_company', termsProhibited: false })
  })
})

describe('research budget seeding (H5, F1 handover §10 question 3)', () => {
  it('opens a per-company envelope at ingestion, before anything can be spent', async () => {
    const { provider } = loaderFor(readFixture('yc-oss-companies-hiring'), { limit: 3 })
    await runSeedIngest(testDb(), provider)

    const companies = await testDb().company.findMany()
    for (const company of companies) {
      const budget = await testDb().researchBudget.findFirst({ where: { companyId: company.id } })
      expect(budget, company.canonicalDomain).not.toBeNull()
      expect(budget?.creditsSpent).toBe(0)
    }
  })

  it('gives an India company the higher allowance H5 requires', async () => {
    const base = recordsFromFixture()[0]!
    const body = JSON.stringify([
      { ...base, id: 11, name: 'IN Co', website: 'https://inco.example', all_locations: 'Bengaluru, Karnataka, India' },
      { ...base, id: 12, name: 'US Co', website: 'https://usco.example', all_locations: 'San Francisco, CA, USA' },
    ])
    await runSeedIngest(testDb(), loaderFor(body).provider)

    const india = await testDb().company.findUnique({ where: { canonicalDomain: 'inco.example' } })
    const us = await testDb().company.findUnique({ where: { canonicalDomain: 'usco.example' } })
    const indiaBudget = await testDb().researchBudget.findFirst({ where: { companyId: india!.id } })
    const usBudget = await testDb().researchBudget.findFirst({ where: { companyId: us!.id } })

    expect(indiaBudget?.creditsCap).toBe(INDIA_COMPANY_CREDITS_CAP)
    expect(usBudget?.creditsCap).toBe(DEFAULT_COMPANY_CREDITS_CAP)
    expect(INDIA_COMPANY_CREDITS_CAP).toBeGreaterThan(DEFAULT_COMPANY_CREDITS_CAP)
  })

  it('never resets an existing envelope, which would hand back spent budget', async () => {
    const body = readFixture('yc-oss-companies-hiring')
    await runSeedIngest(testDb(), loaderFor(body, { limit: 1 }).provider)
    const company = (await testDb().company.findMany())[0]!
    await testDb().researchBudget.updateMany({
      where: { companyId: company.id },
      data: { creditsSpent: 7 },
    })

    await runSeedIngest(testDb(), loaderFor(body, { limit: 1 }).provider)

    const budgets = await testDb().researchBudget.findMany({ where: { companyId: company.id } })
    expect(budgets).toHaveLength(1)
    expect(budgets[0]?.creditsSpent).toBe(7)
  })
})

/**
 * F1's central exit criterion, stated in the handover as: "A test that walks a
 * sampled Company and Opportunity and asserts each populated field has a citing
 * Evidence row with a non-empty verbatim excerpt and a source URL."
 */
describe('every populated field is traceable to an Evidence row', () => {
  it('cites each persisted yc-oss field, verbatim, with a source URL', async () => {
    const { provider } = loaderFor(readFixture('yc-oss-companies-hiring'), { limit: 5 })
    await runSeedIngest(testDb(), provider)

    const records = new Map(
      recordsFromFixture().map((r) => [String(r['id']), r]),
    )
    const companies = await testDb().company.findMany()
    expect(companies.length).toBeGreaterThan(0)

    for (const company of companies) {
      const evidence = await testDb().evidence.findMany({ where: { companyId: company.id } })
      expect(evidence.length, company.canonicalDomain).toBeGreaterThan(0)

      for (const row of evidence) {
        expect(row.excerpt.trim(), 'excerpt must not be empty').not.toBe('')
        expect(row.excerpt.length).toBeLessThanOrEqual(500)
        expect(row.sourceUrl).toBe(HIRING_FEED)
        expect(row.sourceType).toBe('yc')
        expect(row.contentHash).not.toBe('')
      }

      const record = records.get(company.ycId!)!
      // Every source key the loader claims to persist, and that the record
      // actually published, must have a row quoting that key.
      for (const key of Object.keys(YC_SOURCE_KEYS) as YcSourceKey[]) {
        const value = record[key]
        if (value === undefined || value === null) continue
        if (Array.isArray(value) && value.length === 0) continue
        if (typeof value === 'string' && value.trim() === '') continue

        const citing = evidence.filter((e) => e.excerpt.includes(`"${key}"`))
        expect(citing.length, `${company.canonicalDomain}: no Evidence cites "${key}"`).toBeGreaterThan(0)
      }

      // And the excerpt must actually contain the value, not merely the key —
      // otherwise provenance is a label rather than a quotation.
      const nameEvidence = evidence.find((e) => e.excerpt.includes('"name"'))
      expect(nameEvidence?.excerpt).toContain(JSON.stringify(company.displayName))

      const signals = await testDb().companySignal.findMany({ where: { companyId: company.id } })
      expect(signals.map((s) => s.signalType)).toContain('yc_profile')
      for (const signal of signals) {
        expect(evidence.map((e) => e.id)).toContain(signal.evidenceId)
      }
    }
  })

  /**
   * `long_description` is the one field that can exceed the 500-character column.
   * A verbatim PREFIX is still verbatim; a summary would not be, and D5 forbids it.
   */
  it('stores a long description as a verbatim prefix that opens the stored text', async () => {
    const { provider } = loaderFor(readFixture('yc-oss-companies-hiring'), { limit: 10 })
    await runSeedIngest(testDb(), provider)

    const withLong = await testDb().company.findFirst({
      where: { ycLongDescription: { not: null } },
    })
    const evidence = await testDb().evidence.findMany({ where: { companyId: withLong!.id } })
    const descriptionRow = evidence.find((e) => e.excerpt.includes('"long_description"'))

    expect(descriptionRow).toBeDefined()
    // The excerpt is a JSON fragment, so compare on the inner text.
    const quotedPrefix = descriptionRow!.excerpt.slice(0, 120).replace(/^\{"long_description":"/, '')
    expect(withLong!.ycLongDescription!.startsWith(quotedPrefix.split('\\')[0]!)).toBe(true)
  })
})
