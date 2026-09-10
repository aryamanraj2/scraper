#!/usr/bin/env tsx
/**
 * F3's artifact: generate reviewable application packets.
 *
 * **Touches no network.** Every input is a row F1 and F2 already fetched through
 * `FetchPolicyGate` and stored. That is the point of the milestone — the payload is
 * assembled from provenance already on disk, so it can be re-run freely.
 *
 * **Submits nothing** (H8, irreversible in Part H). The output is a URL, a resume and
 * a set of prefilled answers for a human to act on.
 *
 *   npm run packets:run                      generate, per-company cap 3
 *   npm run packets:run -- --cap 4           a different cap
 *   npm run packets:run -- --queue-answers   also queue the judgment questions
 *   npm run packets:run -- --drain           persist fulfilled briefs + merge answers
 *   npm run packets:run -- --list            just show what exists
 */
import 'dotenv/config'
import { prisma, disconnectPrisma } from '../src/core/db/client.js'
import { generateApplicationPackets } from '../src/apply/packet/generate.js'
import { applyAllFulfilledPacketAnswers } from '../src/apply/packet/apply-answers.js'
import { persistAllFulfilledBriefs } from '../src/apply/brief/persist-brief.js'
import { listPackets, queueCounts } from '../src/apply/viewer/queues.js'
import { PACKETS_PER_COMPANY_CAP } from '../src/apply/packet/select.js'

const args = process.argv.slice(2)
const has = (flag: string) => args.includes(flag)
const value = (flag: string) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

const db = prisma()

if (has('--drain')) {
  const briefs = await persistAllFulfilledBriefs(db)
  console.log(`\nResearchBrief: ${briefs.persisted} persisted from fulfilled tasks`)
  for (const f of briefs.failed) console.log(`  skipped ${f.taskId}: ${f.detail}`)

  const answers = await applyAllFulfilledPacketAnswers(db)
  console.log(`Packet answers: ${answers.applied} merged`)
  for (const f of answers.failed) console.log(`  skipped ${f.taskId}: ${f.detail}`)
}

if (!has('--list')) {
  const cap = value('--cap') ? Number(value('--cap')) : PACKETS_PER_COMPANY_CAP
  const outcome = await generateApplicationPackets(db, {
    cap,
    queueJudgmentTasks: has('--queue-answers'),
  })

  console.log(`\nGenerated ${outcome.packets.length} packet(s) across ${outcome.companies} compan(ies), cap ${outcome.cap}/company`)
  console.log(`  ${outcome.packets.filter((p) => p.created).length} created, ${outcome.packets.filter((p) => !p.created).length} refreshed`)
  console.log(`  ${outcome.cappedOut} eligible posting(s) withheld by the cap (recorded in AuditLog, still eligible)`)
  if (outcome.skipped.length > 0) {
    console.log(`  ${outcome.skipped.length} skipped:`)
    for (const s of outcome.skipped.slice(0, 10)) console.log(`      ${s.companyName}: ${s.reason}`)
  }

  const byTrack = new Map<string, number>()
  for (const p of outcome.packets) byTrack.set(p.trackKey, (byTrack.get(p.trackKey) ?? 0) + 1)
  console.log(`  by track: ${[...byTrack].map(([k, v]) => `${k}=${v}`).join(' ') || 'none'}`)
  const unanswered = outcome.packets.reduce((a, p) => a + p.unanswered, 0)
  const answered = outcome.packets.reduce((a, p) => a + p.answers, 0)
  console.log(`  answers: ${answered} prefilled, ${unanswered} left for the operator`)
}

const counts = await queueCounts(db)
console.log('\nQueues (handover.md §9)')
for (const q of counts) {
  const shown = q.available ? String(q.count) : `— not built (${q.milestone})`
  console.log(`  ${q.label.padEnd(20)} ${shown}`)
}

const packets = await listPackets(db)
console.log(`\n${packets.length} packet(s), highest score first`)
for (const p of packets.slice(0, 40)) {
  console.log(
    `  ${String(p.score ?? '--').padStart(3)}  ${p.companyName.padEnd(18)} ${(p.trackKey ?? '-').padEnd(12)} ` +
      `${(p.roleTitle ?? '(untitled)').slice(0, 44).padEnd(44)} ${p.status}`,
  )
}

await disconnectPrisma()
console.log('')
