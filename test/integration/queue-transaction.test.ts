import { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { QUEUES, cancelScheduledSends, createBoss } from '../../src/core/queue/boss.js'
import { enqueueInTransaction, enqueueSendInTransaction } from '../../src/core/queue/enqueue.js'
import { closeTestDb, testDb, truncateAll } from '../helpers/db.js'

let boss: PgBoss

beforeAll(async () => {
  // Drop any queues left by an earlier run so the policies under test are the
  // ones this build creates, then use the real bootstrap.
  const bootstrap = new PgBoss({ connectionString: process.env.TEST_DATABASE_URL! })
  await bootstrap.start()
  for (const queue of Object.values(QUEUES)) {
    if (await bootstrap.getQueue(queue)) await bootstrap.deleteQueue(queue)
  }
  await bootstrap.stop({ graceful: false })

  boss = await createBoss(process.env.TEST_DATABASE_URL!)
})

beforeEach(async () => {
  await truncateAll()
  for (const queue of Object.values(QUEUES)) {
    const jobs = await boss.findJobs(queue, { queued: true })
    if (jobs.length > 0) await boss.deleteJob(queue, jobs.map((j) => j.id))
  }
})

afterAll(async () => {
  await boss.stop({ graceful: false })
  await closeTestDb()
})

/**
 * A6. The decisive reason for pg-boss over BullMQ is not cost — it is that the
 * evidence row and the job it schedules commit together. With a second datastore
 * the enqueue is non-transactional, and handover.md §11's reconstruction criterion
 * becomes a race: a job can exist for a row that was rolled back, or a row can
 * exist with no job.
 */
describe('transactional enqueue (A6)', () => {
  it('commits the job and the row together', async () => {
    const db = testDb()
    let jobId: string | null = null

    await db.$transaction(async (tx) => {
      const company = await tx.company.create({
        data: { canonicalDomain: 'commit.example', displayName: 'Commit Co' },
      })
      jobId = await enqueueInTransaction(boss, tx, QUEUES.companyResearch, {
        companyId: company.id,
      })
    })

    expect(jobId).not.toBeNull()
    const job = await boss.getJobById(QUEUES.companyResearch, jobId!)
    expect(job).not.toBeNull()
    expect(await db.company.count({ where: { canonicalDomain: 'commit.example' } })).toBe(1)
  })

  it('takes the job with it when the transaction rolls back', async () => {
    const db = testDb()
    let jobId: string | null = null

    await expect(
      db.$transaction(async (tx) => {
        const company = await tx.company.create({
          data: { canonicalDomain: 'rollback.example', displayName: 'Rollback Co' },
        })
        jobId = await enqueueInTransaction(boss, tx, QUEUES.companyResearch, {
          companyId: company.id,
        })
        throw new Error('deliberate failure after enqueue')
      }),
    ).rejects.toThrow('deliberate failure after enqueue')

    // The row is gone, and so is the job — no orphan on either side.
    expect(await db.company.count({ where: { canonicalDomain: 'rollback.example' } })).toBe(0)
    expect(jobId).not.toBeNull()
    expect(await boss.getJobById(QUEUES.companyResearch, jobId!)).toBeNull()
  })

  it('collapses a raced send enqueue into one job via singletonKey (A9)', async () => {
    const db = testDb()
    const idempotencyKey = 'send-attempt-idempotency-key-1'

    const first = await db.$transaction((tx) =>
      enqueueSendInTransaction(boss, tx, QUEUES.sendDraft, { draftId: 'd1' }, idempotencyKey),
    )
    const second = await db.$transaction((tx) =>
      enqueueSendInTransaction(boss, tx, QUEUES.sendDraft, { draftId: 'd1' }, idempotencyKey),
    )

    expect(first).not.toBeNull()
    expect(second).toBeNull()
    expect(await boss.findJobs(QUEUES.sendDraft, { queued: true })).toHaveLength(1)
  })
})

/**
 * A12: engaging the kill switch must CANCEL scheduled sends, not pause them. A
 * paused job resumes on the next start and sends the message the operator stopped.
 * F5 proves this against a real send path; this asserts the queue semantics the
 * helper relies on.
 */
describe('kill switch cancels scheduled sends (A12)', () => {
  it('moves queued sends to a terminal state that a restart cannot revive', async () => {
    const db = testDb()
    for (const draftId of ['d1', 'd2', 'd3']) {
      await db.$transaction((tx) =>
        enqueueSendInTransaction(boss, tx, QUEUES.sendDraft, { draftId }, `key-${draftId}`),
      )
    }
    await db.$transaction((tx) =>
      enqueueInTransaction(boss, tx, QUEUES.followUp, { draftId: 'd1' }),
    )

    const cancelled = await cancelScheduledSends(boss)
    expect(cancelled).toBe(4)

    expect(await boss.findJobs(QUEUES.sendDraft, { queued: true })).toHaveLength(0)
    expect(await boss.findJobs(QUEUES.followUp, { queued: true })).toHaveLength(0)

    // Non-send queues are untouched: the switch stops outbound mail, not research.
    await db.$transaction((tx) =>
      enqueueInTransaction(boss, tx, QUEUES.companyResearch, { companyId: 'c1' }),
    )
    expect(await boss.findJobs(QUEUES.companyResearch, { queued: true })).toHaveLength(1)
    expect(await cancelScheduledSends(boss)).toBe(0)
  })
})
