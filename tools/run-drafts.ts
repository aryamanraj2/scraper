#!/usr/bin/env tsx
/**
 * The F4 artifact: compose outreach drafts from stored rows.
 *
 * **Touches no network.** Like `packets:run`, everything it needs is already in the
 * database — `Contact` rows the curator read through `FetchPolicyGate`, `Evidence`
 * rows from F1/F2, `ApprovedClaim` rows the operator wrote. Only four commands in
 * this project reach a live source, and this is not one of them.
 *
 *   npm run drafts:run                 compose drafts for every qualified lead
 *   npm run drafts:run -- --limit 5    a first look
 *   npm run drafts:run -- --queue      queue the outreach_draft LLM tasks
 *   npm run drafts:run -- --drain      merge fulfilled tasks, then run the gate
 *   npm run drafts:run -- --gate       run the Quality Gate over composed drafts
 *   npm run drafts:run -- --approve <id> --by <name>    freeze approval_hash (A7)
 *
 * Sending is hard-disabled and stays so until F5. This produces drafts and nothing else.
 */
import 'dotenv/config'
import { prisma, disconnectPrisma } from '../src/core/db/client.js'
import { MILESTONE_STAGE } from '../src/core/config/stage.js'
import { resolveSendingEnabled } from '../src/core/config/config.js'
import { composeDrafts, gateDraft } from '../src/outreach/draft/compose.js'
import { queueOutreachDraft, applyOutreachDraft } from '../src/outreach/draft/queue-draft.js'
import { approveDraft } from '../src/outreach/draft/approve.js'

const args = process.argv.slice(2)
const has = (f: string) => args.includes(f)
const val = (f: string) => {
  const i = args.indexOf(f)
  return i >= 0 ? args[i + 1] : undefined
}

const db = prisma()

// Stated on every run rather than assumed. Sending needs two independent factors and
// this build has neither: MILESTONE_STAGE is a source constant a reviewed commit
// changes, not an environment variable.
const sending = resolveSendingEnabled()
console.log(`\nMILESTONE_STAGE=${MILESTONE_STAGE} · sending ${sending.enabled ? 'ENABLED' : 'disabled'}\n`)

const approveId = val('--approve')
if (approveId) {
  const by = val('--by') ?? 'operator'
  const result = await approveDraft(db, approveId, by)
  if (result.ok) {
    console.log(`  approved ${approveId}`)
    console.log(`  approval_hash ${result.approvalHash}`)
    console.log(`\n  Frozen (A7). Editing any hashed field now invalidates the approval.\n`)
  } else {
    console.log(`  REFUSED (${result.reason}): ${result.detail}\n`)
  }
  await disconnectPrisma()
  process.exit(result.ok ? 0 : 1)
}

if (!has('--gate') && !has('--drain')) {
  const limit = val('--limit') === undefined ? undefined : Number(val('--limit'))
  const out = await composeDrafts(db, limit === undefined ? {} : { limit })

  console.log(`  composed ${out.draftsCreated} · updated ${out.draftsUpdated}\n`)
  for (const d of out.drafts) {
    console.log(`    ${d.companyName.padEnd(18)} slot ${d.touchSlot}  ${d.outreachCase.padEnd(28)} ${d.contactEmail}`)
  }
  if (out.refusals.length > 0) {
    console.log(`\n  refused ${out.refusals.length}:`)
    const byReason = out.refusals.reduce<Record<string, number>>((a, r) => {
      a[r.reason] = (a[r.reason] ?? 0) + 1
      return a
    }, {})
    for (const [reason, n] of Object.entries(byReason)) console.log(`    ${String(n).padStart(3)}  ${reason}`)
  }
}

if (has('--queue')) {
  const drafts = await db.draft.findMany({ where: { approvedAt: null }, select: { id: true } })
  let queued = 0
  const skipped: Record<string, number> = {}
  for (const d of drafts) {
    const r = await queueOutreachDraft(db, d.id)
    if (r.queued) queued += 1
    else skipped[r.reason] = (skipped[r.reason] ?? 0) + 1
  }
  console.log(`\n  queued ${queued} outreach_draft task(s)`)
  if (Object.keys(skipped).length > 0) console.log(`  skipped ${JSON.stringify(skipped)}`)
  console.log(`  Drain them from a Claude Code session: npm run llm:next -- --kind outreach_draft\n`)
}

if (has('--drain')) {
  const tasks = await db.llmTask.findMany({
    where: { kind: 'outreach_draft', status: 'fulfilled' },
    select: { id: true },
  })
  let merged = 0
  for (const t of tasks) {
    const r = await applyOutreachDraft(db, t.id)
    if (r.merged) merged += 1
    else if (r.reason !== 'approved') console.log(`    merge skipped (${r.reason}): ${r.detail}`)
  }
  console.log(`\n  merged ${merged} fulfilled task(s)\n`)
}

if (has('--gate') || has('--drain')) {
  const drafts = await db.draft.findMany({
    where: { approvedAt: null },
    select: { id: true, lead: { select: { company: { select: { displayName: true } } } } },
  })
  let passed = 0
  for (const d of drafts) {
    const r = await gateDraft(db, d.id)
    if (r.ok) passed += 1
    else console.log(`    GATE FAIL  ${d.lead.company.displayName.padEnd(18)} ${r.detail}`)
  }
  console.log(`\n  gate: ${passed}/${drafts.length} passed\n`)
}

const counts = await db.draft.groupBy({ by: ['status'], _count: { _all: true } })
console.log('── drafts by status ──\n')
for (const c of counts) console.log(`  ${c.status.padEnd(20)} ${c._count._all}`)
console.log()

await disconnectPrisma()
