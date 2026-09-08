import { fromPrisma, type PgBoss, type SendOptions } from 'pg-boss'
import type { Prisma } from '../../../generated/prisma/client.js'
import type { QueueName } from './boss.js'

/**
 * A6's payoff: the job and the rows that justify it commit together, or neither
 * does.
 *
 * pg-boss's Prisma adapter runs the enqueue INSERT on the caller's interactive
 * transaction, so a rollback takes the job with it. That is why this helper only
 * accepts a transaction client: enqueueing outside one is the mistake it exists to
 * prevent, and making it unrepresentable is cheaper than remembering.
 */
export async function enqueueInTransaction<T extends object>(
  boss: PgBoss,
  tx: Prisma.TransactionClient,
  queue: QueueName,
  payload: T,
  options: SendOptions = {},
): Promise<string | null> {
  return boss.send(queue, payload, { ...options, db: fromPrisma(tx) })
}

/**
 * Sends are the one at-most-once job class (A9), so a scheduled send carries a
 * singletonKey derived from the SendAttempt idempotency key. Two schedulers racing
 * produce one job, not two.
 */
export async function enqueueSendInTransaction<T extends object>(
  boss: PgBoss,
  tx: Prisma.TransactionClient,
  queue: QueueName,
  payload: T,
  idempotencyKey: string,
  options: SendOptions = {},
): Promise<string | null> {
  return boss.send(queue, payload, {
    ...options,
    singletonKey: idempotencyKey,
    db: fromPrisma(tx),
  })
}
