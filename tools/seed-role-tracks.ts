#!/usr/bin/env tsx
/**
 * Seeds the four `RoleTrack` rows from `src/intel/taxonomy/role-tracks.ts`.
 *
 * Idempotent, and safe to re-run after a vocabulary change: it refreshes the
 * keyword lists and leaves `defaultResumeVersionId` alone, because that column is
 * the operator's choice, not the taxonomy's.
 */
import 'dotenv/config'
import { prisma, disconnectPrisma } from '../src/core/db/client.js'
import { seedRoleTracks } from '../src/intel/taxonomy/seed-tracks.js'

const db = prisma()
const result = await seedRoleTracks(db)
console.log(`Role tracks: ${result.created} created, ${result.updated} updated.`)
await disconnectPrisma()
