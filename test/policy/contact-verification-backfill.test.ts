import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { importContacts } from '../../src/outreach/contacts/import.js'
import {
  BACKFILL_ACTION,
  RETIRE_ACTION,
  backfillProviderVerification,
  readProviderVerdict,
} from '../../src/outreach/contacts/verify-backfill.js'
import { closeTestDb, testDb, truncateAll } from '../helpers/db.js'

/**
 * F6-DECISIONS §3.1. A provider's `valid` verdict — and only `valid` — verifies an
 * imported contact, and the backfill reads that verdict out of the stored Evidence line
 * rather than out of any file.
 *
 * Each test below is a way the backfill could verify somebody it should not, and each
 * must fail closed. Verifying a contact is what lets a draft be composed to them, so a
 * wrong `true` here is the first step toward an email nobody vouched for.
 */

const HEADER = 'domain,email,full_name,title,contact_type,provider,source_url,notes,email_status'
const OPTS = { provider: 'salesql', operator: 'aryamanraj2' }
const dir = mkdtempSync(join(tmpdir(), 'verify-backfill-'))
let counter = 0

function csv(...lines: string[]): string {
  const path = join(dir, `contacts-${(counter += 1)}.csv`)
  writeFileSync(path, `${HEADER}\n${lines.join('\n')}\n`)
  return path
}

/**
 * Rows exactly as the pre-F6 importer left them: the 9-field line stored verbatim as
 * the excerpt, and `verified = false` because the verdict column was never read.
 */
async function legacyImport(...lines: string[]): Promise<void> {
  await importContacts(testDb(), csv(...lines), OPTS)
  await testDb().contact.updateMany({ data: { verified: false } })
}

async function verifiedEmails(): Promise<string[]> {
  const rows = await testDb().contact.findMany({ where: { verified: true }, select: { emailNormalized: true } })
  return rows.map((r) => r.emailNormalized).sort()
}

beforeEach(async () => {
  await truncateAll()
  await testDb().company.create({ data: { canonicalDomain: 'acme.com', displayName: 'Acme', status: 'normalized' } })
})
afterAll(async () => closeTestDb())

describe('importer — the email_status column', () => {
  it('verifies a row the provider called exactly `valid`, and nothing else', async () => {
    await importContacts(
      testDb(),
      csv(
        'acme.com,a@acme.com,A A,Software Engineer,,salesql,,,valid',
        'acme.com,b@acme.com,B B,Software Engineer,,salesql,,,accept_all',
        'acme.com,c@acme.com,C C,Software Engineer,,salesql,,,',
        'acme.com,d@acme.com,D D,Software Engineer,,salesql,,,Valid',
      ),
      OPTS,
    )
    expect(await verifiedEmails()).toEqual(['a@acme.com'])
  })

  it('leaves every row unverified when the column is absent', async () => {
    const path = join(dir, 'legacy-header.csv')
    writeFileSync(path, 'domain,email,title\nacme.com,e@acme.com,Software Engineer\n')
    await importContacts(testDb(), path, OPTS)
    expect(await verifiedEmails()).toEqual([])
  })
})

describe('readProviderVerdict', () => {
  const base = { sourceUrl: 'operator-entry://salesql/op', emailNormalized: 'a@acme.com' }

  it('reads the verdict past a quoted comma that split(",") would misread', () => {
    // A naive split puts `Platform"` in the title column and shifts the verdict.
    const excerpt = 'acme.com,a@acme.com,A A,"Engineering Manager, Platform",,salesql,,"notes, with commas",valid'
    expect(readProviderVerdict({ ...base, excerpt })).toEqual({ ok: true, verdict: 'valid' })
  })

  it('refuses a line whose email is not the contact\'s — the columns are not where we think', () => {
    const excerpt = 'acme.com,someone.else@acme.com,,,,salesql,,,valid'
    expect(readProviderVerdict({ ...base, excerpt })).toEqual({ ok: false, reason: 'email_mismatch' })
  })

  it('refuses a line with the wrong field count rather than guessing', () => {
    expect(readProviderVerdict({ ...base, excerpt: 'acme.com,a@acme.com,valid' })).toEqual({
      ok: false,
      reason: 'unparseable',
    })
  })

  it('refuses a truncated excerpt, because the verdict is what a prefix loses first', () => {
    const excerpt = `acme.com,a@acme.com,,,,salesql,,${'x'.repeat(480)},valid`.slice(0, 500)
    expect(readProviderVerdict({ ...base, excerpt })).toEqual({ ok: false, reason: 'truncated' })
  })

  it('refuses Evidence the importer did not write', () => {
    const excerpt = 'acme.com,a@acme.com,,,,salesql,,,valid'
    expect(readProviderVerdict({ ...base, sourceUrl: 'https://acme.com/careers', excerpt })).toEqual({
      ok: false,
      reason: 'not_operator_entry',
    })
  })
})

describe('backfillProviderVerification', () => {
  const LINES = [
    'acme.com,valid@acme.com,V V,Software Engineer,,salesql,,,valid',
    'acme.com,acceptall@acme.com,A A,Software Engineer,,salesql,,,accept_all',
    'acme.com,blank@acme.com,B B,Software Engineer,,salesql,,,',
    // The word "valid" in the notes must not be read as the verdict.
    'acme.com,notes@acme.com,N N,Software Engineer,,salesql,,"was valid, now unknown",',
  ]

  it('is a dry run by default and writes nothing, audit rows included', async () => {
    await legacyImport(...LINES)
    const auditBefore = await testDb().auditLog.count()

    const result = await backfillProviderVerification(testDb(), { operator: 'op' })

    expect(result.dryRun).toBe(true)
    expect(result.flips).toBe(1)
    expect(result.byProvider).toEqual({ salesql: { valid: 1, accept_all: 1, '(blank)': 2 } })
    expect(await verifiedEmails()).toEqual([])
    expect(await testDb().auditLog.count()).toBe(auditBefore)
  })

  it('on --write, verifies only the `valid` row, with one audit row naming the evidence and the token', async () => {
    await legacyImport(...LINES)
    const evidenceCount = await testDb().evidence.count()

    const result = await backfillProviderVerification(testDb(), { operator: 'op', dryRun: false })

    expect(result.flips).toBe(1)
    expect(await verifiedEmails()).toEqual(['valid@acme.com'])
    const contact = await testDb().contact.findUniqueOrThrow({ where: { emailNormalized: 'valid@acme.com' } })
    const audits = await testDb().auditLog.findMany({ where: { action: BACKFILL_ACTION } })
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ subjectId: contact.id, actorId: 'op' })
    expect(audits[0]!.metadata).toMatchObject({ evidenceId: contact.evidenceId, verdict: 'valid', provider: 'salesql' })
    // No second provenance row: the existing one already holds the verdict verbatim.
    expect(await testDb().evidence.count()).toBe(evidenceCount)
  })

  it('is idempotent: a second run flips nothing and writes no second audit row', async () => {
    await legacyImport(...LINES)
    await backfillProviderVerification(testDb(), { operator: 'op', dryRun: false })
    const again = await backfillProviderVerification(testDb(), { operator: 'op', dryRun: false })

    expect(again.flips).toBe(0)
    expect(await testDb().auditLog.count({ where: { action: BACKFILL_ACTION } })).toBe(1)
  })

  it('re-runs the executive filter first: a refused row is retired, never verified', async () => {
    // The widened filter now refuses this title at import, so the row is planted the
    // way the pre-F6 importer left it: imported under a title it passed, then carrying
    // the one the old rule missed.
    await legacyImport('acme.com,sonal@acme.com,S S,Recruiter,named_talent,snov,,,valid')
    await testDb().contact.updateMany({ data: { publicTitle: 'Head -Talent Acquisition' } })

    const dry = await backfillProviderVerification(testDb(), { operator: 'op' })
    expect(dry).toMatchObject({ flips: 0, executives: 1 })
    expect((await testDb().contact.findFirstOrThrow()).status).toBe('active')

    await backfillProviderVerification(testDb(), { operator: 'op', dryRun: false })
    const contact = await testDb().contact.findFirstOrThrow()
    expect(contact).toMatchObject({ verified: false, status: 'retired' })
    const audit = await testDb().auditLog.findFirstOrThrow({ where: { action: RETIRE_ACTION } })
    expect(audit).toMatchObject({ subjectId: contact.id, reasonCode: 'executive_only_contact' })
    // §1.1: the refused address is not copied into the audit trail.
    expect(JSON.stringify(audit.metadata)).not.toContain('sonal')
  })

  it('re-importing a retired contact never revives it, and never creates a second row', async () => {
    await legacyImport('acme.com,sonal@acme.com,S S,Recruiter,named_talent,snov,,,valid')
    await testDb().contact.updateMany({ data: { publicTitle: 'Head -Talent Acquisition' } })
    await backfillProviderVerification(testDb(), { operator: 'op', dryRun: false })

    // Under the title the filter refuses: refused at the door, row untouched.
    const asExec = await importContacts(
      testDb(),
      csv('acme.com,sonal@acme.com,S S,Head -Talent Acquisition,named_talent,snov,,,valid'),
      OPTS,
    )
    expect(asExec.counts.executive).toBe(1)
    // Under a title it would pass: the address already exists, so nothing is written.
    const asBenign = await importContacts(
      testDb(),
      csv('acme.com,sonal@acme.com,S S,Recruiter,named_talent,snov,,,valid'),
      OPTS,
    )
    expect(asBenign.counts.already_present).toBe(1)

    const rows = await testDb().contact.findMany({ where: { emailNormalized: 'sonal@acme.com' } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'retired', verified: false, publicTitle: 'Head -Talent Acquisition' })
  })

  it('never touches a page-published contact', async () => {
    await legacyImport(LINES[0]!)
    await testDb().contact.updateMany({ data: { discoveryMethod: 'page_published' } })
    const result = await backfillProviderVerification(testDb(), { operator: 'op', dryRun: false })
    expect(result.rows).toHaveLength(0)
    expect(await verifiedEmails()).toEqual([])
  })
})
