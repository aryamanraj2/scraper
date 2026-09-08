import { createPrismaClient, type PrismaClient } from '../../src/core/db/client.js'

const TABLES = [
  'audit_log', 'secret_record', 'kill_switch', 'robots_cache', 'host_policy',
  'research_budget', 'suppression', 'opt_out', 'bounce', 'reply', 'delivery_event',
  'send_attempt', 'draft', 'lead', 'application_packet', 'research_brief',
  'contact', 'opportunity', 'company_signal', 'evidence', 'company',
  'role_track', 'resume_version', 'approved_claim', 'candidate_profile',
  'score_version', 'lead_hint',
]

let client: PrismaClient | undefined

export function testDb(): PrismaClient {
  if (!client) {
    const url = process.env.TEST_DATABASE_URL
    if (!url) throw new Error('TEST_DATABASE_URL is not set')
    client = createPrismaClient(url)
  }
  return client
}

export async function truncateAll(): Promise<void> {
  const db = testDb()
  await db.$executeRawUnsafe(
    `TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
  )
}

export async function closeTestDb(): Promise<void> {
  if (client) {
    await client.$disconnect()
    client = undefined
  }
}
