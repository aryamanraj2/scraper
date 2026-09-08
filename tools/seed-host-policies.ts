#!/usr/bin/env tsx
/**
 * Writes the static allow/deny seed lists into host_policy so they are visible in
 * the dashboard and auditable next to operator entries.
 *
 * The in-code lists in src/core/policy/host-lists.ts remain authoritative for deny,
 * so an unseeded database is still safe — this is for visibility, not enforcement.
 */
import 'dotenv/config'
import { prisma, disconnectPrisma } from '../src/core/db/client.js'
import { seedHostPolicies } from '../src/core/policy/host-policy.js'

const counts = await seedHostPolicies(prisma())
console.log(`Seeded host policies: ${counts.allow} allow, ${counts.deny} deny.`)
await disconnectPrisma()
