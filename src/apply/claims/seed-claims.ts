import type { Db } from '../../core/audit/audit-log.js'
import { writeAudit } from '../../core/audit/audit-log.js'
import { APPROVED_CLAIMS, missingRequiredClaimKeys, type ApprovedClaimSeed } from './claims-data.js'

export type SeedClaimsOutcome = {
  created: number
  updated: number
  deactivated: number
  byCategory: Record<string, number>
  missingRequired: string[]
}

/**
 * Loads the operator's approved claims.
 *
 * Idempotent on `key`, so editing a claim's wording updates the row rather than
 * leaving two versions of the same fact where a later milestone could cite either.
 *
 * A claim that disappears from the seed list is **deactivated, never deleted**. An
 * `ApplicationPacket` stores the claim ids its answers cite, and deleting a row would
 * strand a packet the operator has already accepted — provenance that pointed at
 * something and now points at nothing is worse than provenance marked withdrawn.
 * `isActive = false` also stops the claim being offered to any new answer.
 */
export async function seedApprovedClaims(
  db: Db,
  seeds: ApprovedClaimSeed[] = APPROVED_CLAIMS,
): Promise<SeedClaimsOutcome> {
  const out: SeedClaimsOutcome = {
    created: 0,
    updated: 0,
    deactivated: 0,
    byCategory: {},
    missingRequired: [],
  }

  for (const seed of seeds) {
    const existing = await db.approvedClaim.findUnique({ where: { key: seed.key }, select: { id: true } })
    const data = { text: seed.text, category: seed.category, sourceRef: seed.sourceRef, isActive: true }
    if (existing) {
      await db.approvedClaim.update({ where: { id: existing.id }, data })
      out.updated += 1
    } else {
      await db.approvedClaim.create({ data: { key: seed.key, ...data } })
      out.created += 1
    }
    out.byCategory[seed.category] = (out.byCategory[seed.category] ?? 0) + 1
  }

  const seededKeys = new Set(seeds.map((s) => s.key))
  const stale = await db.approvedClaim.findMany({
    where: { isActive: true, key: { notIn: [...seededKeys] } },
    select: { id: true, key: true },
  })
  for (const row of stale) {
    await db.approvedClaim.update({ where: { id: row.id }, data: { isActive: false } })
    out.deactivated += 1
  }

  out.missingRequired = missingRequiredClaimKeys(seededKeys)

  await writeAudit(db, {
    actorType: 'user',
    actorId: 'operator',
    action: 'claim.library_seeded',
    subjectType: 'ApprovedClaim',
    metadata: {
      created: out.created,
      updated: out.updated,
      deactivated: out.deactivated,
      byCategory: out.byCategory,
      missingRequired: out.missingRequired,
    },
  })

  return out
}
