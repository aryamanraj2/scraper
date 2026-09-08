#!/usr/bin/env tsx
/**
 * Runs F0's four exit criteria and prints a verdict per criterion.
 *
 * The criteria, verbatim from Part F: "Migrations apply; reason-code enum complete;
 * secrets round-trip without touching logs; no HTTP client is reachable outside the
 * gate."
 */
import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { prisma, disconnectPrisma } from '../src/core/db/client.js'
import { ALL_REASON_CODES, REASON_CODE_REGISTRY } from '../src/core/reason-codes/registry.js'

type Check = { name: string; ok: boolean; detail: string }
const checks: Check[] = []
const bin = (name: string) => join(process.cwd(), 'node_modules', '.bin', name)

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  // Merge stderr into stdout: a failing check must report why, not print a blank.
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  })
}

// 1. Migrations apply, and the two partial unique indexes survived them.
try {
  const status = run(bin('prisma'), ['migrate', 'status'])
  const applied = !/have not yet been applied|drift/i.test(status)
  const db = prisma()
  const indexes = await db.$queryRawUnsafe<Array<{ indexname: string }>>(
    `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='send_attempt' AND indexdef ILIKE '%WHERE%' ORDER BY indexname`,
  )
  const tables = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*)::bigint AS n FROM pg_tables WHERE schemaname='public'`,
  )
  checks.push({
    name: 'Migrations apply',
    ok: applied && indexes.length === 2,
    detail: `${tables[0]?.n ?? 0} tables; partial indexes: ${indexes.map((i) => i.indexname).join(', ') || 'MISSING'}`,
  })
} catch (err) {
  checks.push({ name: 'Migrations apply', ok: false, detail: String(err) })
}

// 2. Reason-code enum complete: registry and Prisma enum in exact bijection.
{
  const missing = ALL_REASON_CODES.filter((c) => !(c in REASON_CODE_REGISTRY))
  const enumSet = new Set<string>(ALL_REASON_CODES)
  const extra = Object.keys(REASON_CODE_REGISTRY).filter((k) => !enumSet.has(k))
  checks.push({
    name: 'Reason-code enum complete',
    ok: missing.length === 0 && extra.length === 0,
    detail:
      missing.length || extra.length
        ? `missing: [${missing.join(', ')}] extra: [${extra.join(', ')}]`
        : `${ALL_REASON_CODES.length} codes, registry bijective`,
  })
}

// 3 and 4 are proven by the suite, which asserts them against the real code paths.
for (const [name, pattern] of [
  ['Secrets round-trip without touching logs', 'test/integration/secret-store.test.ts'],
  ['No HTTP client reachable outside the gate', 'test/policy'],
] as const) {
  try {
    const out = run(bin('vitest'), ['run', pattern])
    checks.push({ name, ok: true, detail: (out.match(/Tests\s+.*/) ?? ['passed'])[0]!.trim() })
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string }
    checks.push({ name, ok: false, detail: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim().slice(-600) || String(err) })
  }
}

await disconnectPrisma()

console.log('\nF0 exit criteria\n')
for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}\n        ${c.detail}`)
const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} criteria met.\n`)
process.exit(failed.length === 0 ? 0 : 1)
