import { PgBoss } from 'pg-boss'

/**
 * A6: pg-boss on Postgres rather than BullMQ on Redis.
 *
 * The decisive property is not cost — it is transactional enqueue. handover.md
 * §11 requires that every message be reconstructible from its evidence, which is
 * far easier to guarantee when the evidence row and the follow-up job commit
 * together. A second datastore with a non-transactional enqueue makes that a race.
 * Throughput and fan-out, which is what BullMQ actually buys, are irrelevant at a
 * few hundred companies and at most 20 sends a day.
 */
/**
 * pg-boss dedups on `singletonKey` only when the queue policy says to. With the
 * default `standard` policy two racing schedulers produce two jobs, which for a
 * send queue is the double-send A9 exists to prevent — so the send queues are
 * `stately`: at most one job per singletonKey per state, covering created, active
 * and retry.
 */
export const QUEUE_POLICIES: Partial<Record<string, 'standard' | 'short' | 'singleton' | 'stately'>> = {
  'send.draft': 'stately',
  'send.followUp': 'stately',
}

export const QUEUES = {
  /** F1: ingest a seed source page or feed. */
  seedIngest: 'seed.ingest',
  /** F1/F2: refresh one company's evidence. */
  companyResearch: 'company.research',
  /** F2: recompute a lead's score under the active ScoreVersion. */
  leadScore: 'lead.score',
  /** F5: transmit an approved draft. The one at-most-once job class (A9). */
  sendDraft: 'send.draft',
  /** F5: the single follow-up, 7-10 business days out. */
  followUp: 'send.followUp',
  /** F5: poll replies and bounces. */
  inboxSync: 'inbox.sync',
} as const

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES]

export async function createBoss(connectionString: string): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString })
  await boss.start()
  for (const queue of Object.values(QUEUES)) {
    const policy = QUEUE_POLICIES[queue] ?? 'standard'
    const existing = await boss.getQueue(queue)
    if (!existing) {
      await boss.createQueue(queue, { policy })
      continue
    }
    // pg-boss refuses to change a queue's policy after creation, and createQueue
    // is a silent no-op on an existing queue. Continuing anyway would leave a send
    // queue running under `standard`, where singletonKey does not dedup at all —
    // which is the double-send A9 exists to prevent. Fail loudly instead.
    if (existing.policy !== policy) {
      throw new Error(
        `Queue "${queue}" exists with policy "${existing.policy}" but this build requires ` +
          `"${policy}". pg-boss cannot change a queue policy in place: drain the queue, ` +
          'delete it (boss.deleteQueue), and restart.',
      )
    }
  }
  return boss
}

/**
 * A12: the kill switch must CANCEL scheduled jobs rather than pause them. A paused
 * job resumes on the next start and sends exactly the message the operator stopped.
 *
 * F5 proves this end to end; the helper exists now so the send path has nothing to
 * invent later.
 */
export async function cancelScheduledSends(boss: PgBoss): Promise<number> {
  let cancelled = 0
  for (const queue of [QUEUES.sendDraft, QUEUES.followUp]) {
    // `queued: true` selects jobs still waiting to run. Cancelling moves them to
    // the terminal `cancelled` state, so a restart cannot revive them; pausing the
    // queue would leave them to fire later, which is the failure A12 names.
    const jobs = await boss.findJobs(queue, { queued: true })
    if (jobs.length > 0) {
      await boss.cancel(queue, jobs.map((j) => j.id))
      cancelled += jobs.length
    }
  }
  return cancelled
}
