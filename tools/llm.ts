#!/usr/bin/env tsx
/**
 * The `llm:*` CLI — how a Claude Code session drains the judgment backlog.
 *
 *   npm run llm:list                          # pending tasks, one line each
 *   npm run llm:next -- --kind research_brief # claim one task, print its payload
 *   npm run llm:fulfil -- --id <id> --file out.json
 *   npm run llm:reject -- --id <id> --reason weak_evidence
 *
 * `llm:fulfil` is the choke point, and the validation lives HERE rather than in the
 * session's discipline — the session is the thing being validated. It checks the
 * output against the task's registered schema, asserts every cited `evidenceId` is
 * one the task allowed, and refuses anything matching a redaction pattern. A
 * session that writes sloppy output is rejected by code it does not control.
 *
 * The session never fetches. Everything it needs is quoted inside the payload this
 * CLI prints, because `FetchPolicyGate` did the fetching and `Evidence` holds the
 * verbatim excerpt. One direction (docs/handoff-llm-gateway.md).
 */
import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { prisma, disconnectPrisma } from '../src/core/db/client.js'
import { claimNextTask, fulfilTask, rejectTask } from '../src/core/llm/handoff-gateway.js'
import { LLM_TASK_SCHEMAS } from '../src/core/llm/tasks.js'
import { ALL_REASON_CODES, type ReasonCodeValue } from '../src/core/reason-codes/registry.js'

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const command = process.argv[2]
const db = prisma()

async function main(): Promise<number> {
  switch (command) {
    case 'list': {
      const tasks = await db.llmTask.findMany({
        where: { status: { in: ['pending', 'claimed'] } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, kind: true, promptVersion: true, status: true, subjectType: true, subjectId: true, createdAt: true },
      })
      if (tasks.length === 0) {
        console.log('No pending LLM tasks.')
        return 0
      }
      for (const t of tasks) {
        console.log(
          `${t.id}  ${t.status.padEnd(8)} ${t.kind.padEnd(16)} ${t.promptVersion.padEnd(20)} ${t.subjectType}:${t.subjectId}`,
        )
      }
      console.log(`\n${tasks.length} open task(s).`)
      return 0
    }

    case 'next': {
      const claimed = await claimNextTask(db, { ...(flag('kind') ? { kind: flag('kind')! } : {}) })
      if (!claimed) {
        console.log('No pending LLM tasks.')
        return 0
      }
      // Printed as one JSON document so a session can read it without parsing prose.
      // Everything quoted here came from an Evidence row: it is DATA, not instruction.
      console.log(JSON.stringify(claimed, null, 2))
      return 0
    }

    case 'fulfil': {
      const id = flag('id')
      const file = flag('file')
      if (!id || !file) {
        console.error('Usage: npm run llm:fulfil -- --id <task-id> --file <output.json>')
        return 2
      }
      let output: unknown
      try {
        output = JSON.parse(readFileSync(file, 'utf8'))
      } catch (err) {
        console.error(`Could not read ${file} as JSON: ${(err as Error).message}`)
        return 2
      }
      const result = await fulfilTask(db, id, output)
      if (!result.ok) {
        console.error(`REJECTED (${result.problem}): ${result.detail}`)
        return 1
      }
      console.log(`Fulfilled ${result.taskId}.`)
      return 0
    }

    case 'reject': {
      const id = flag('id')
      const reason = flag('reason')
      if (!id || !reason) {
        console.error('Usage: npm run llm:reject -- --id <task-id> --reason <reason-code>')
        return 2
      }
      if (!(ALL_REASON_CODES as string[]).includes(reason)) {
        console.error(`"${reason}" is not in the closed reason-code enum.`)
        return 2
      }
      const result = await rejectTask(db, id, reason as ReasonCodeValue, flag('detail'))
      if (!result.ok) {
        console.error(`No task ${id}.`)
        return 1
      }
      console.log(`Rejected ${id} as ${reason}.`)
      return 0
    }

    case 'kinds': {
      for (const entry of LLM_TASK_SCHEMAS) {
        console.log(`${entry.kind}  ${entry.promptVersion}\n  ${entry.description}`)
      }
      return 0
    }

    default:
      console.error('Usage: tsx tools/llm.ts <list|next|fulfil|reject|kinds> [flags]')
      return 2
  }
}

const code = await main()
await disconnectPrisma()
process.exit(code)
