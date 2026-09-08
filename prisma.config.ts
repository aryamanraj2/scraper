import 'dotenv/config'
import { defineConfig, env } from 'prisma/config'

// Prisma 7 moved the migration connection URL out of schema.prisma. The runtime
// client does not read this — it is constructed with @prisma/adapter-pg in
// src/core/db/client.ts, which is also what pg-boss's fromPrisma() adapter
// requires for transactional enqueue.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
})
