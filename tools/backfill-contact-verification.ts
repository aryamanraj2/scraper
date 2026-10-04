#!/usr/bin/env tsx
/**
 * F6's one-shot verification backfill — `docs/F6-DECISIONS.md` §3.1.
 *
 *   npm run contacts:verify-backfill               # DRY RUN (the default): counts, writes nothing
 *   npm run contacts:verify-backfill -- --write    # flip provider-`valid` rows to verified
 *
 * **Touches no network.** It reads the provider verdict already stored verbatim in each
 * imported contact's Evidence excerpt (`src/outreach/contacts/verify-backfill.ts`).
 *
 * Dry run is the default on purpose: the operator reads the per-provider counts and
 * confirms before anything is written, and a flag that has to be typed is the
 * confirmation.
 */
import 'dotenv/config'
import { userInfo } from 'node:os'
import { prisma, disconnectPrisma } from '../src/core/db/client.js'
import { backfillProviderVerification } from '../src/outreach/contacts/verify-backfill.js'

const args = process.argv.slice(2)
const write = args.includes('--write')
const operatorIndex = args.indexOf('--operator')
const operator = (operatorIndex >= 0 ? args[operatorIndex + 1] : undefined) ?? userInfo().username

const db = prisma()
const result = await backfillProviderVerification(db, { operator, dryRun: !write })

console.log(`\ncontacts:verify-backfill${result.dryRun ? '  (DRY RUN — nothing written)' : ''}  operator ${operator}\n`)
console.log('Unverified lookup_provider contacts, by provider and verbatim verdict:\n')
for (const [provider, verdicts] of Object.entries(result.byProvider).sort()) {
  const total = Object.values(verdicts).reduce((a, b) => a + b, 0)
  const parts = Object.entries(verdicts)
    .sort()
    .map(([v, n]) => `${v}=${n}`)
    .join('  ')
  console.log(`  ${provider.padEnd(10)} ${String(total).padStart(4)}   ${parts}`)
}

for (const r of result.rows.filter((row) => row.verdict === 'REFUSED:executive')) {
  console.log(`\n${result.dryRun ? 'Would retire' : 'Retired'} (executive filter): ${r.provider} ${r.companyName} — ${r.title ?? '(no title)'}`)
}

console.log(`\n${result.dryRun ? 'Would flip' : 'Flipped'} ${result.flips} contact(s) to verified:\n`)
for (const r of result.rows.filter((row) => row.flip)) {
  console.log(`  ${r.provider.padEnd(8)} ${r.companyName.slice(0, 22).padEnd(22)} ${r.email.padEnd(40)} ${r.title ?? '(no title)'}`)
}
console.log('')

await disconnectPrisma()
