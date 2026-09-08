import { execFileSync } from 'node:child_process'
import { config as loadDotenv } from 'dotenv'

/**
 * Applies migrations to the test database once per run.
 *
 * `migrate deploy` rather than `db push`: the two partial unique indexes in
 * prisma/migrations/*_partial_unique_indexes cannot be expressed in schema.prisma,
 * and db push would report them as drift and offer to drop them. Running deploy
 * here means the suite exercises exactly the migration path production uses.
 */
export default function setup(): void {
  loadDotenv({ quiet: true })
  const url = process.env.TEST_DATABASE_URL
  if (!url) throw new Error('TEST_DATABASE_URL is not set; see .env.example')

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  })
}
