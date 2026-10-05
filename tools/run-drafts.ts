#!/usr/bin/env tsx
/**
 * The F4 artifact: compose outreach drafts from stored rows.
 *
 * **Touches no network.** Like `packets:run`, everything it needs is already in the
 * database — `Contact` rows the curator read through `FetchPolicyGate`, `Evidence`
 * rows from F1/F2, `ApprovedClaim` rows the operator wrote. Only four commands in
 * this project reach a live source, and this is not one of them.
 *
 *   npm run drafts:run                 compose drafts for qualified leads that have none yet
 *   npm run drafts:run -- --recompose  ALSO rewrite existing unapproved drafts (drops their
 *                                      written text until the next --drain)
 *   npm run drafts:run -- --limit 5    a first look
 *   npm run drafts:run -- --company Strava --company Linear ...
 *                                      every step below, for these companies only
 *   npm run drafts:run -- --queue --draft <id> --draft <id>
 *                                      queue, drain, gate or review these drafts only
 *   npm run drafts:run -- --queue      queue the outreach_draft LLM tasks
 *   npm run drafts:run -- --drain      merge fulfilled tasks, then run the gate
 *   npm run drafts:run -- --gate       run the Quality Gate over composed drafts
 *   npm run drafts:run -- --review     the approval view: every awaiting draft, title first
 *   npm run drafts:run -- --approve <id> --by <name>    freeze approval_hash (A7)
 *   npm run drafts:run -- --revoke <id> --by <name>     withdraw ONE approval (back to composing)
 *
 * Sending is hard-disabled and stays so until F5. This produces drafts and nothing else.
 */
import 'dotenv/config'
import { prisma, disconnectPrisma } from '../src/core/db/client.js'
import { MILESTONE_STAGE } from '../src/core/config/stage.js'
import { resolveSendingEnabled } from '../src/core/config/config.js'
import { composeDrafts, gateDraft } from '../src/outreach/draft/compose.js'
import { queueOutreachDraft, applyOutreachDraft, latestFulfilledDraftTasks } from '../src/outreach/draft/queue-draft.js'
import { approveDraft, revokeApproval } from '../src/outreach/draft/approve.js'
import { formatDraftForReview } from '../src/outreach/draft/review.js'

const args = process.argv.slice(2)
const has = (f: string) => args.includes(f)
const val = (f: string) => {
  const i = args.indexOf(f)
  return i >= 0 ? args[i + 1] : undefined
}

const db = prisma()

// Repeatable. A sample run must not re-compose or queue the other drafts.
const repeated = (flag: string) => args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]!] : []))
const companyNames = repeated('--company')
const draftIds = repeated('--draft')
const onlyCompanies = {
  ...(companyNames.length > 0 ? { lead: { company: { displayName: { in: companyNames } } } } : {}),
  ...(draftIds.length > 0 ? { id: { in: draftIds } } : {}),
}

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

// One id, one approval withdrawn. No list form, no --all: an approval is a decision
// about one message, and so is taking it back (§1.6).
const revokeId = val('--revoke')
if (revokeId) {
  const by = val('--by') ?? 'operator'
  const result = await revokeApproval(db, revokeId, by)
  if (result.ok) {
    console.log(`  revoked ${revokeId} (was ${result.revokedHash?.slice(0, 12) ?? 'no hash'}…) -> composing`)
    console.log(`\n  Re-compose, drain and gate it; it needs a fresh approval.\n`)
  } else {
    console.log(`  REFUSED (${result.reason}): ${result.detail}\n`)
  }
  await disconnectPrisma()
  process.exit(result.ok ? 0 : 1)
}

if (has('--review')) {
  const drafts = await db.draft.findMany({
    where: { status: 'awaiting_approval', ...onlyCompanies },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      status: true,
      touchSlot: true,
      outreachCase: true,
      subject: true,
      bodyText: true,
      lead: { select: { company: { select: { displayName: true } } } },
      contact: { select: { emailNormalized: true, publicTitle: true, contactType: true, discoveryMethod: true } },
    },
  })
  for (const d of drafts) console.log(formatDraftForReview({ ...d, companyName: d.lead.company.displayName }) + '\n')
  console.log(`  ${drafts.length} draft(s) awaiting approval. Approve each one by id; there is no bulk form.\n`)
  await disconnectPrisma()
  process.exit(0)
}

if (!has('--gate') && !has('--drain')) {
  const limit = val('--limit') === undefined ? undefined : Number(val('--limit'))
  const out = await composeDrafts(db, {
    ...(limit === undefined ? {} : { limit }),
    ...(companyNames.length > 0 ? { companyNames } : {}),
    ...(draftIds.length > 0 ? { onlyDraftIds: draftIds } : {}),
    recompose: has('--recompose'),
  })

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
  const drafts = await db.draft.findMany({ where: { approvedAt: null, ...onlyCompanies }, select: { id: true } })
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
  const scoped = new Set(
    (await db.draft.findMany({ where: { approvedAt: null, ...onlyCompanies }, select: { id: true } })).map((d) => d.id),
  )
  const tasks = (await latestFulfilledDraftTasks(db)).filter((t) => scoped.has(t.subjectId))
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
    where: { approvedAt: null, ...onlyCompanies },
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
