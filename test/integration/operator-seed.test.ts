import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { seedHostPolicies } from '../../src/core/policy/host-policy.js'
import { runSeedIngest } from '../../src/ingest/yc/seed-loader.js'
import {
  OPERATOR_SEED_CONFIDENCE,
  OperatorFileSeedProvider,
  readOperatorSeedFile,
  upsertOperatorSeededCompany,
} from '../../src/ingest/file/operator-seed.js'
import {
  DEFAULT_COMPANY_CREDITS_CAP,
  INDIA_COMPANY_CREDITS_CAP,
} from '../../src/ingest/budget/company-budget.js'
import { closeTestDb, testDb, truncateAll } from '../helpers/db.js'

const HEADER = 'name,domain,hq_country,headcount_band,tracks,ats_guess,notes'

const dir = mkdtempSync(join(tmpdir(), 'operator-seed-'))
let fileCounter = 0

function seedFile(...lines: string[]): string {
  const path = join(dir, `seed-${(fileCounter += 1)}.csv`)
  writeFileSync(path, `${HEADER}\n${lines.join('\n')}\n`)
  return path
}

async function ingest(path: string) {
  return runSeedIngest(testDb(), new OperatorFileSeedProvider(readOperatorSeedFile(path)), {
    upsert: upsertOperatorSeededCompany,
  })
}

beforeEach(async () => {
  await truncateAll()
  await seedHostPolicies(testDb())
})
afterAll(async () => closeTestDb())

describe('operator seed file ingest', () => {
  it('turns rows into Company rows keyed by canonical domain', async () => {
    const result = await ingest(
      seedFile(
        'Zomato,zomato.com,India,5000+,ios_android|swe,unknown,food delivery',
        'Stripe,https://www.stripe.com/about,USA,5000+,swe,unknown,payments',
      ),
    )

    expect(result.created).toBe(2)
    expect(result.skipped).toEqual([])

    const zomato = await testDb().company.findUnique({ where: { canonicalDomain: 'zomato.com' } })
    expect(zomato?.displayName).toBe('Zomato')
    expect(zomato?.status).toBe('normalized')
    expect(zomato?.countries).toEqual(['India'])

    // A URL with scheme, www and a path still resolves to the registrable domain.
    expect(
      await testDb().company.findUnique({ where: { canonicalDomain: 'stripe.com' } }),
    ).not.toBeNull()
  })

  /**
   * `ycId` is unique and means "this is a YC record". Claiming it for an operator row
   * would both lie and, at scale, collide.
   */
  it('never claims ycId', async () => {
    await ingest(seedFile('Zomato,zomato.com,India,5000+,swe,unknown,x'))
    const zomato = await testDb().company.findUnique({ where: { canonicalDomain: 'zomato.com' } })
    expect(zomato?.ycId).toBeNull()
  })

  /** H5's India allowance falls out of the country column with no special case. */
  it('opens a per-company research envelope, with India at the higher cap', async () => {
    await ingest(
      seedFile(
        'Zomato,zomato.com,India,5000+,swe,unknown,x',
        'Stripe,stripe.com,USA,5000+,swe,unknown,y',
      ),
    )

    const rows = await testDb().researchBudget.findMany({
      where: { company: { canonicalDomain: { in: ['zomato.com', 'stripe.com'] } } },
      select: { creditsCap: true, company: { select: { canonicalDomain: true } } },
    })
    const capFor = (d: string) => rows.find((r) => r.company?.canonicalDomain === d)?.creditsCap
    expect(capFor('zomato.com')).toBe(INDIA_COMPANY_CREDITS_CAP)
    expect(capFor('stripe.com')).toBe(DEFAULT_COMPANY_CREDITS_CAP)
  })

  it('opens a derived_company host allow entry so the domain is fetchable at all', async () => {
    await ingest(seedFile('Zomato,zomato.com,India,5000+,swe,unknown,x'))
    const policy = await testDb().hostPolicy.findUnique({ where: { host: 'zomato.com' } })
    expect(policy).toMatchObject({ mode: 'allow', origin: 'derived_company' })
    expect(policy?.sourceUrl).toContain('file://')
  })

  it('records tracks and headcount as namespaced tags, so "which of these should have been ios_android" is a query', async () => {
    await ingest(seedFile('Zomato,zomato.com,India,1000-5000,ios_android|ai_engineer,unknown,x'))
    const zomato = await testDb().company.findUnique({ where: { canonicalDomain: 'zomato.com' } })
    expect(zomato?.tags).toEqual([
      'seed-track:ios_android',
      'seed-track:ai_engineer',
      'seed-headcount:1000-5000',
    ])
  })

  /** The detector decides. A guess written to `atsSlug` would be a claim nobody verified. */
  it('does not write ats_guess to atsSlug', async () => {
    await ingest(seedFile('Zomato,zomato.com,India,5000+,swe,greenhouse,x'))
    const zomato = await testDb().company.findUnique({ where: { canonicalDomain: 'zomato.com' } })
    expect(zomato?.atsSlug).toBeNull()
    expect(zomato?.atsBoardToken).toBeNull()

    // ...but it is retained, verbatim, on its own Evidence row, so the run can report
    // where the guess and the detector disagreed.
    const guess = await testDb().evidence.findFirst({
      where: { company: { canonicalDomain: 'zomato.com' }, excerpt: { contains: 'ats_guess' } },
    })
    expect(guess?.excerpt).toBe('{"ats_guess":"greenhouse"}')
  })

  it('writes one user_hint Evidence row per populated column, plus one for the line', async () => {
    await ingest(seedFile('Zomato,zomato.com,India,5000+,swe,unknown,food delivery'))
    const evidence = await testDb().evidence.findMany({
      where: { company: { canonicalDomain: 'zomato.com' } },
    })

    // Seven columns, all populated, plus the record-level row.
    expect(evidence.length).toBe(8)
    for (const row of evidence) {
      expect(row.sourceType).toBe('user_hint')
      expect(row.fetchedVia).toBe('user_hint')
      expect(row.confidence).toBe(OPERATOR_SEED_CONFIDENCE)
      expect(row.sourceUrl).toContain('file://')
    }
    expect(evidence.some((e) => e.excerpt === 'Zomato,zomato.com,India,5000+,swe,unknown,food delivery')).toBe(true)
  })

  it('writes no Evidence row for a column the operator left blank', async () => {
    await ingest(seedFile('Zomato,zomato.com,,,,,'))
    const evidence = await testDb().evidence.findMany({
      where: { company: { canonicalDomain: 'zomato.com' } },
    })
    // name + domain + the record-level row.
    expect(evidence.length).toBe(3)
  })

  /**
   * The signal vocabulary is a closed enum of things OBSERVED about a company. A typed
   * line is none of them, and filing it under the nearest value would put a false claim
   * about origin into the table the scorer reads.
   */
  it('writes no CompanySignal', async () => {
    await ingest(seedFile('Zomato,zomato.com,India,5000+,swe,unknown,x'))
    expect(await testDb().companySignal.count()).toBe(0)
  })

  it('is idempotent: a second run of an unchanged file writes no new Evidence', async () => {
    const path = seedFile('Zomato,zomato.com,India,5000+,swe,unknown,x')
    await ingest(path)
    const first = await testDb().evidence.count()

    const second = await ingest(path)
    expect(second.unchanged).toBe(1)
    expect(await testDb().evidence.count()).toBe(first)
  })

  it('reports an unusable domain as a skip with its reason, rather than dropping it', async () => {
    const result = await ingest(
      seedFile('Broken,not a domain at all,India,5000+,swe,unknown,x', 'Good,good.example,USA,<50,swe,unknown,y'),
    )
    expect(result.created).toBe(1)
    expect(result.skipped.length).toBe(1)
    expect(result.skipped[0]).toMatchObject({ name: 'Broken', reason: 'source_unavailable' })
  })

  it('reports two rows resolving to one domain as a duplicate', async () => {
    const result = await ingest(
      seedFile('Zomato,zomato.com,India,5000+,swe,unknown,x', 'Zomato again,www.zomato.com,India,5000+,swe,unknown,y'),
    )
    expect(result.created).toBe(1)
    expect(result.skipped[0]).toMatchObject({ reason: 'duplicate' })
  })

  it('rejects a row with no name or no domain, with its line number', () => {
    const file = readOperatorSeedFile(seedFile(',zomato.com,India,5000+,swe,unknown,x'))
    expect(file.seeds).toEqual([])
    expect(file.rejected[0]).toMatchObject({ line: 2, reason: 'name and domain are both required' })
  })

  it('fails the whole file when a required column is missing, rather than every row', () => {
    const path = join(dir, 'bad-header.csv')
    writeFileSync(path, 'name,website\nZomato,zomato.com\n')
    expect(() => readOperatorSeedFile(path)).toThrow(/missing required column\(s\): domain/)
  })
})

/**
 * Eighteen of the operator's 188 rows are already in the corpus, some of them scored
 * and qualified. The yc upsert writes the whole yc field set every pass and resets
 * `status` to `normalized`; running it over these rows would blank columns this file
 * does not have and reverse work F2 and F3 did.
 */
describe('operator seed over a company that already exists', () => {
  async function existingYcCompany() {
    return testDb().company.create({
      data: {
        canonicalDomain: 'zomato.com',
        displayName: 'Zomato Ltd',
        website: 'https://zomato.com',
        ycId: 'yc-123',
        ycBatch: 'Winter 2012',
        teamSize: 5000,
        ycOneLiner: 'restaurant discovery',
        ycStatus: 'Active',
        countries: ['United States of America'],
        tags: ['Food'],
        status: 'researched',
      },
      select: { id: true },
    })
  }

  it('does not reverse the lifecycle', async () => {
    await existingYcCompany()
    await ingest(seedFile('Zomato,zomato.com,India,5000+,ios_android,unknown,x'))
    const after = await testDb().company.findUnique({ where: { canonicalDomain: 'zomato.com' } })
    expect(after?.status).toBe('researched')
  })

  it('does not blank the yc fields this file has no values for', async () => {
    await existingYcCompany()
    await ingest(seedFile('Zomato,zomato.com,India,5000+,ios_android,unknown,x'))
    expect(
      await testDb().company.findUnique({ where: { canonicalDomain: 'zomato.com' } }),
    ).toMatchObject({
      displayName: 'Zomato Ltd',
      ycId: 'yc-123',
      ycBatch: 'Winter 2012',
      teamSize: 5000,
      ycOneLiner: 'restaurant discovery',
      ycStatus: 'Active',
    })
  })

  it('unions countries and tags rather than replacing them', async () => {
    await existingYcCompany()
    await ingest(seedFile('Zomato,zomato.com,India,5000+,ios_android,unknown,x'))
    const after = await testDb().company.findUnique({ where: { canonicalDomain: 'zomato.com' } })
    expect(after?.countries).toEqual(['United States of America', 'India'])
    expect(after?.tags).toEqual(['Food', 'seed-track:ios_android', 'seed-headcount:5000+'])
  })

  it('counts it as updated, not created', async () => {
    await existingYcCompany()
    const result = await ingest(seedFile('Zomato,zomato.com,India,5000+,ios_android,unknown,x'))
    expect(result.created).toBe(0)
    expect(result.updated).toBe(1)
  })
})
