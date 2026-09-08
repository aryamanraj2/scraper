import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../../../generated/prisma/client.js'

/**
 * Prisma 7 constructs the client with a driver adapter rather than a connection
 * URL in the schema. That is not incidental here: pg-boss's `fromPrisma(tx)`
 * adapter — the mechanism behind A6's transactional enqueue — requires Prisma v7+
 * with `@prisma/adapter-pg`.
 */
export function createPrismaClient(connectionString: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString })
  return new PrismaClient({ adapter })
}

let singleton: PrismaClient | undefined

export function prisma(): PrismaClient {
  if (!singleton) {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL is not set')
    singleton = createPrismaClient(url)
  }
  return singleton
}

export async function disconnectPrisma(): Promise<void> {
  if (singleton) {
    await singleton.$disconnect()
    singleton = undefined
  }
}

export type { PrismaClient }
