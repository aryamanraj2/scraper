import type { Db } from '../../core/audit/audit-log.js'
import { ROLE_TRACKS } from './role-tracks.js'

/**
 * Projects the vocabularies in `role-tracks.ts` into `RoleTrack` rows.
 *
 * The rows are not the source of truth — the file is — but they have to exist,
 * for two reasons the schema already anticipates. `Opportunity.roleTrackId` points
 * at one, so a posting's track is a foreign key rather than a string; and
 * `RoleTrack.defaultResumeVersionId` is where F3 hangs the track-tailored resume
 * (`handover.md` §6: "each lead has one primary track and one selected resume").
 *
 * Keyword vocabularies are copied onto the row so the dashboard can show an
 * operator why a label was applied without reading the source. `defaultResumeVersionId`
 * is deliberately never touched here: it is operator data, and a re-seed must not
 * silently unpick a resume choice.
 */
export async function seedRoleTracks(db: Db): Promise<{ created: number; updated: number }> {
  let created = 0
  let updated = 0

  for (const track of ROLE_TRACKS) {
    const existing = await db.roleTrack.findUnique({ where: { key: track.key }, select: { id: true } })
    if (existing) {
      await db.roleTrack.update({
        where: { id: existing.id },
        data: {
          displayName: track.displayName,
          positiveKeywords: track.positive,
          negativeKeywords: track.negative,
        },
      })
      updated += 1
    } else {
      await db.roleTrack.create({
        data: {
          key: track.key,
          displayName: track.displayName,
          positiveKeywords: track.positive,
          negativeKeywords: track.negative,
        },
      })
      created += 1
    }
  }

  return { created, updated }
}

/** Track key → row id, for assigning `Opportunity.roleTrackId`. */
export async function roleTrackIdsByKey(db: Db): Promise<Map<string, string>> {
  const rows = await db.roleTrack.findMany({ select: { id: true, key: true } })
  return new Map(rows.map((r) => [r.key, r.id]))
}
