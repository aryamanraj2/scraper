import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  OPERATOR_IMPORT_CONFIDENCE,
  importContacts,
  operatorEntrySource,
} from '../../src/outreach/contacts/import.js'
import { closeTestDb, testDb, truncateAll } from '../helpers/db.js'

/**
 * The operator-entered contact path, held to the same three rules as the page-read
 * one: no executives at any tier, no addresses off the company's domain, and
 * provenance that says what actually produced the value.
 *
 * The fourth rule is the one specific to this path — nothing imported here is
 * `verified`, because nothing here was verified. A row a person typed out of a
 * vendor's free-tier UI is a candidate, and an unverified contact opens no outreach
 * case, so importing a thousand of them cannot cause a send.
 */

const HEADER = 'domain,email,full_name,title,contact_type,provider,source_url,notes'

const dir = mkdtempSync(join(tmpdir(), 'contact-import-'))
let counter = 0

function csv(...lines: string[]): string {
  const path = join(dir, `contacts-${(counter += 1)}.csv`)
  writeFileSync(path, `${HEADER}\n${lines.join('\n')}\n`)
  return path
}

const OPTS = { provider: 'apollo.io', operator: 'aryamanraj2' }

async function company(domain = 'zomato.com') {
  return testDb().company.create({
    data: { canonicalDomain: domain, displayName: domain, status: 'normalized' },
    select: { id: true },
  })
}

beforeEach(async () => truncateAll())
afterAll(async () => closeTestDb())

describe('contact import', () => {
  it('stores a named employee against the company, unverified', async () => {
    await company()
    const result = await importContacts(
      testDb(),
      csv('zomato.com,priya.n@zomato.com,Priya N,Senior Software Engineer,,,,'),
      OPTS,
    )

    expect(result.counts.imported).toBe(1)
    const contact = await testDb().contact.findUnique({
      where: { emailNormalized: 'priya.n@zomato.com' },
    })
    expect(contact).toMatchObject({
      contactType: 'named_employee',
      discoveryMethod: 'lookup_provider',
      verified: false,
      publicTitle: 'Senior Software Engineer',
      // Tier A's page-kind attribution is meaningless for a row nobody fetched, and a
      // value here would enter the Tier A yield report as if a page had been read.
      sourcePageKind: null,
    })
  })

  /**
   * `handover.md` §1.1 is not amended by this milestone. A lookup provider asked for
   * "someone at a 12-person startup" returns the founder, because at a 12-person
   * startup the founder is who it has.
   */
  it('refuses an executive by title', async () => {
    await company()
    const result = await importContacts(
      testDb(),
      csv('zomato.com,deepinder@zomato.com,Deepinder G,Co-Founder & CEO,,,,'),
      OPTS,
    )

    expect(result.counts.executive).toBe(1)
    expect(await testDb().contact.count()).toBe(0)
  })

  it('refuses an executive by local part, with no title text at all', async () => {
    await company()
    const result = await importContacts(testDb(), csv('zomato.com,founders@zomato.com,,,,,,'), OPTS)
    expect(result.counts.executive).toBe(1)
    expect(await testDb().contact.count()).toBe(0)
  })

  /**
   * §1.1 says never target them. Recording the address in an audit row so a later
   * query could find it would keep exactly what the rule says not to keep — the same
   * decision `curate.ts` makes.
   */
  it('does not record a refused executive address anywhere', async () => {
    await company()
    await importContacts(testDb(), csv('zomato.com,ceo@zomato.com,,Chief Executive,,,,'), OPTS)

    const audits = await testDb().auditLog.findMany({ where: { reasonCode: 'executive_only_contact' } })
    expect(audits.length).toBe(1)
    expect(JSON.stringify(audits[0]?.metadata)).not.toContain('ceo@zomato.com')
  })

  /** A `gmail.com` address is a personal account (§1.2); another company's is someone else's employee. */
  it('refuses an address off the company domain', async () => {
    await company()
    const result = await importContacts(
      testDb(),
      csv(
        'zomato.com,priya.personal@gmail.com,Priya N,Engineer,,,,',
        'zomato.com,someone@swiggy.com,X,Engineer,,,,',
      ),
      OPTS,
    )
    expect(result.counts.off_domain).toBe(2)
    expect(await testDb().contact.count()).toBe(0)
  })

  it('accepts an address on a subdomain of the company domain', async () => {
    await company()
    const result = await importContacts(testDb(), csv('zomato.com,talent@careers.zomato.com,,,,,,'), OPTS)
    expect(result.counts.imported).toBe(1)
  })

  /**
   * A Contact needs a companyId. Creating a Company from a contact list would produce
   * a row with no research, no score and no evidence, existing only to hold an address.
   */
  it('reports a domain that is not in the corpus rather than inventing a Company', async () => {
    const result = await importContacts(testDb(), csv('unknown.example,hr@unknown.example,,,,,,'), OPTS)
    expect(result.counts.unknown_company).toBe(1)
    expect(await testDb().company.count()).toBe(0)
    expect(await testDb().contact.count()).toBe(0)
  })

  it('writes an Evidence row citing the provider and the operator, not a page', async () => {
    const c = await company()
    await importContacts(
      testDb(),
      csv('zomato.com,careers@zomato.com,,,,apollo.io,https://app.apollo.io/x,found via free tier'),
      OPTS,
    )

    const contact = await testDb().contact.findUniqueOrThrow({
      where: { emailNormalized: 'careers@zomato.com' },
    })
    const evidence = await testDb().evidence.findUniqueOrThrow({ where: { id: contact.evidenceId } })

    expect(evidence.companyId).toBe(c.id)
    expect(evidence.sourceUrl).toBe(operatorEntrySource('apollo.io', 'aryamanraj2'))
    expect(evidence.sourceType).toBe('user_hint')
    expect(evidence.fetchedVia).toBe('user_hint')
    expect(evidence.confidence).toBe(OPERATOR_IMPORT_CONFIDENCE)
    // The excerpt is the operator's own line, verbatim — including any provider link
    // they noted, which belongs INSIDE the quote rather than in the column that has to
    // say where this system got the value.
    expect(evidence.excerpt).toBe(
      'zomato.com,careers@zomato.com,,,,apollo.io,https://app.apollo.io/x,found via free tier',
    )
  })

  it('classifies a role alias from its local part when the operator gives no type', async () => {
    await company()
    await importContacts(
      testDb(),
      csv(
        'zomato.com,careers@zomato.com,,,,,,',
        'zomato.com,campus@zomato.com,,,,,,',
        'zomato.com,ananya@zomato.com,Ananya,Technical Recruiter,,,,',
      ),
      OPTS,
    )

    const byEmail = Object.fromEntries(
      (await testDb().contact.findMany()).map((c) => [c.emailNormalized, c.contactType]),
    )
    expect(byEmail).toEqual({
      'careers@zomato.com': 'careers_alias',
      'campus@zomato.com': 'university_recruiting',
      'ananya@zomato.com': 'named_talent',
    })
  })

  it('honours an explicit contact_type the operator supplies, and ignores an invalid one', async () => {
    await company()
    await importContacts(
      testDb(),
      csv(
        'zomato.com,a@zomato.com,,,talent_alias,,,',
        'zomato.com,b@zomato.com,,Engineer,not_a_type,,,',
      ),
      OPTS,
    )
    const byEmail = Object.fromEntries(
      (await testDb().contact.findMany()).map((c) => [c.emailNormalized, c.contactType]),
    )
    expect(byEmail['a@zomato.com']).toBe('talent_alias')
    expect(byEmail['b@zomato.com']).toBe('named_employee')
  })

  it('is idempotent on an address that already exists', async () => {
    await company()
    const file = csv('zomato.com,careers@zomato.com,,,,,,')
    await importContacts(testDb(), file, OPTS)
    const second = await importContacts(testDb(), file, OPTS)

    expect(second.counts.already_present).toBe(1)
    expect(await testDb().contact.count()).toBe(1)
  })

  it('writes nothing on a dry run', async () => {
    await company()
    const result = await importContacts(testDb(), csv('zomato.com,careers@zomato.com,,,,,,'), {
      ...OPTS,
      dryRun: true,
    })
    expect(result.counts.imported).toBe(1)
    expect(await testDb().contact.count()).toBe(0)
    expect(await testDb().evidence.count()).toBe(0)
  })

  it('reports a malformed row with its line number instead of shifting the columns', async () => {
    await company()
    const path = join(dir, 'short-row.csv')
    writeFileSync(path, `${HEADER}\nzomato.com,careers@zomato.com\n`)
    const result = await importContacts(testDb(), path, OPTS)

    expect(result.counts.unusable_row).toBe(1)
    expect(result.rows[0]).toMatchObject({ line: 2 })
    expect(await testDb().contact.count()).toBe(0)
  })

  it('fails the whole file when a required column is missing', async () => {
    const path = join(dir, 'bad-header.csv')
    writeFileSync(path, 'company,address\nzomato.com,careers@zomato.com\n')
    await expect(importContacts(testDb(), path, OPTS)).rejects.toThrow(
      /missing required column\(s\): domain, email/,
    )
  })

  /**
   * The Tier A yield report is the number that decides whether a paid provider gets
   * bought, and it is a statement about what employer PAGES publish. An imported row
   * that leaked into it would move that number without a page having been read — the
   * exact failure `companiesMeasured` was introduced to prevent.
   */
  it('does not enter the Tier A yield, which measures page-published addresses only', async () => {
    await company()
    await importContacts(testDb(), csv('zomato.com,careers@zomato.com,,,,,,'), OPTS)

    const { tierAYield } = await import('../../src/outreach/contacts/yield-report.js')
    const y = await tierAYield(testDb())
    expect(y.totalContacts).toBe(0)
    expect(y.companiesWithAlias).toBe(0)
  })
})
