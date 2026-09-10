import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import type { Db } from '../../core/audit/audit-log.js'
import { writeAudit } from '../../core/audit/audit-log.js'
import { RESUME_VERSIONS, fileUrlFor, type ResumeVersionSeed } from './resumes-data.js'

export type SeedResumeOutcome = {
  created: number
  updated: number
  missingFiles: string[]
  tracksWired: string[]
  tracksWithoutDefault: string[]
}

/**
 * Loads the operator's resume library and wires each `RoleTrack` to its default.
 *
 * Idempotent on `label`, so re-running after the operator edits a PDF refreshes the
 * hash rather than forking a second row. The hash is recomputed on every run for
 * exactly that reason: a resume is a file the operator changes, and a stale
 * `fileSha256` would make an `ApplicationPacket` cite a document that no longer says
 * what it said.
 *
 * A missing file is reported, not thrown. The operator may have moved the library,
 * and refusing to seed the other four rows because one path is stale would be a
 * worse outcome than seeding four and naming the fifth.
 */
export async function seedResumeVersions(
  db: Db,
  seeds: ResumeVersionSeed[] = RESUME_VERSIONS,
): Promise<SeedResumeOutcome> {
  const out: SeedResumeOutcome = {
    created: 0,
    updated: 0,
    missingFiles: [],
    tracksWired: [],
    tracksWithoutDefault: [],
  }

  const defaultsByTrack = new Map<string, string>()

  for (const seed of seeds) {
    let sha: string | null = null
    try {
      statSync(seed.filePath)
      sha = createHash('sha256').update(readFileSync(seed.filePath)).digest('hex')
    } catch {
      out.missingFiles.push(seed.filePath)
    }

    const data = {
      trackKey: seed.trackKey,
      linkUrl: fileUrlFor(seed.filePath),
      filePath: seed.filePath,
      fileSha256: sha,
      isActive: true,
    }

    const existing = await db.resumeVersion.findFirst({
      where: { label: seed.label },
      select: { id: true },
    })
    const row = existing
      ? await db.resumeVersion.update({ where: { id: existing.id }, data, select: { id: true } })
      : await db.resumeVersion.create({ data: { label: seed.label, ...data }, select: { id: true } })
    if (existing) out.updated += 1
    else out.created += 1

    if (seed.isTrackDefault) defaultsByTrack.set(seed.trackKey, row.id)
  }

  // Wiring the track default is the whole point of the seam. A track left null here
  // means F3 cannot choose a resume for any posting on it, so the gap is reported
  // rather than discovered one packet at a time.
  const tracks = await db.roleTrack.findMany({ select: { id: true, key: true } })
  for (const track of tracks) {
    const resumeId = defaultsByTrack.get(track.key)
    if (!resumeId) {
      out.tracksWithoutDefault.push(track.key)
      continue
    }
    await db.roleTrack.update({ where: { id: track.id }, data: { defaultResumeVersionId: resumeId } })
    out.tracksWired.push(track.key)
  }

  await writeAudit(db, {
    actorType: 'user',
    actorId: 'operator',
    action: 'resume.library_seeded',
    subjectType: 'ResumeVersion',
    metadata: {
      created: out.created,
      updated: out.updated,
      tracksWired: out.tracksWired,
      missingFiles: out.missingFiles.length,
    },
  })

  return out
}
