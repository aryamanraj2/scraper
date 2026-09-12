#!/usr/bin/env tsx
/**
 * Import operator-entered contacts from a CSV.
 *
 *   npm run contacts:import -- --file data/contacts.csv
 *   npm run contacts:import -- --file data/contacts.csv --provider apollo.io
 *   npm run contacts:import -- --file data/contacts.csv --dry-run
 *   npm run contacts:import -- --file data/contacts.csv --report data/contact-import-report.csv
 *
 * Header: domain,email,full_name,title,contact_type,provider,source_url,notes
 * Required: domain,email. Everything else may be blank.
 *
 * **This command touches no network.** It is the only contact path in the project that
 * does not, because the lookup happened in a browser and the operator typed the result.
 * That is also why every row lands `verified = false` and opens no outreach case: see
 * the module comment in `src/outreach/contacts/import.ts`.
 *
 * Rows are refused for three reasons and each is reported rather than dropped —
 * executives (`handover.md` §1.1, unamended), addresses off the company's domain, and
 * domains that are not in the corpus yet. Seed a company before importing a contact
 * for it: `npm run ingest:seed -- --from-file <list>`.
 */
import 'dotenv/config'
import { userInfo } from 'node:os'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { prisma, disconnectPrisma } from '../src/core/db/client.js'
import { importContacts } from '../src/outreach/contacts/import.js'

const args = process.argv.slice(2)
const has = (f: string) => args.includes(f)
const val = (f: string) => {
  const i = args.indexOf(f)
  return i >= 0 ? args[i + 1] : undefined
}

const file = val('--file')
if (!file) {
  console.error('usage: npm run contacts:import -- --file <csv> [--provider apollo.io] [--dry-run] [--report <csv>]')
  process.exit(2)
}

const provider = val('--provider') ?? 'apollo.io'
// The operator is half the provenance, so it is recorded rather than assumed. The
// shell account is a reasonable default for a single-operator local system; pass
// `--operator` when it is not the right name.
const operator = val('--operator') ?? userInfo().username
const dryRun = has('--dry-run')

const db = prisma()
const result = await importContacts(db, resolve(file), { provider, operator, dryRun })

console.log(`\nImporting contacts from ${file}${dryRun ? '  (DRY RUN — nothing written)' : ''}`)
console.log(`  provider ${provider} · operator ${operator}\n`)

for (const row of result.rows) {
  if (row.outcome === 'imported') {
    console.log(`  ${String(row.line).padStart(4)}  ${row.email.padEnd(38)} ${row.contactType}`)
  } else {
    console.log(`  ${String(row.line).padStart(4)}  ${(row.email || '—').padEnd(38)} ${row.outcome.toUpperCase()}  ${row.detail}`)
  }
}

console.log('\n── import ──\n')
for (const [outcome, count] of Object.entries(result.counts)) {
  console.log(`  ${outcome.padEnd(18)} ${count}`)
}
console.log(
  '\n  Every imported row is verified=false and opens no outreach case. Confirm an\n' +
    '  address before it can be a send target.\n',
)

const reportPath = val('--report')
if (reportPath) {
  const header = 'line,email,domain,outcome,contact_type,detail'
  const body = result.rows
    .map((r) =>
      [String(r.line), r.email, r.domain, r.outcome, r.contactType ?? '', r.detail]
        .map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v))
        .join(','),
    )
    .join('\n')
  writeFileSync(resolve(reportPath), `${header}\n${body}\n`)
  console.log(`  report written to ${reportPath}\n`)
}

await disconnectPrisma()
