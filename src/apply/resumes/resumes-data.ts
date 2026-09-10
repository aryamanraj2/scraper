import type { RoleTrackKey } from '../../../generated/prisma/enums.js'

/**
 * The operator's resume library — the seam `RoleTrack.defaultResumeVersionId` was
 * left null for. F2's seeder deliberately did not fill it in, because which resume
 * goes with which track is operator data, not taxonomy.
 *
 * ## Why a `file://` link and not a hosted URL
 *
 * H3 ("link on first contact, attach after reply") is a **deliverability** rule about
 * email: a new sending domain plus an attachment is the worst combination for
 * landing in an inbox. F3 sends no email. An `ApplicationPacket` is submitted by the
 * operator, by hand, through the employer's own ATS — where the resume is *uploaded*,
 * not linked — so the honest artefact here is the file on disk, and `filePath` plus
 * `fileSha256` are the fields that matter.
 *
 * `linkUrl` is non-null in the schema and carries the same path as a `file://` URL so
 * nothing has to special-case a missing value. **F4 must replace these with real
 * hosted URLs before any draft is composed**, because at that point H3 does apply and
 * a `file://` link in an email is useless to the recipient.
 *
 * ## Track mapping
 *
 * | Track | Resume | Why |
 * |---|---|---|
 * | `ios_android` | `Resume_IOS` (default), `Resume_android` | Two flavours of one track. iOS is the default: it carries the SmartOut contract role, the Swift Student Challenge, and Wandr's concurrency detail. Android is selected per draft when the posting leans Android. |
 * | `ai_engineer` | `Resume_AI` | Leads with the agentic text-to-SQL work and carries the AI/Agentic skills line. The largest track in the corpus. |
 * | `sde` | `Resume_backend` | Backend/Systems and CS Fundamentals lines; OpenStack and idempotent-ingest framing. |
 * | `swe` | `Resume_backend` | Same document as `sde`. The operator's generalist pitch is the backend one; `Main resume.pdf` is an iOS-flavoured variant and is deliberately not seeded — a generalist posting handed an iOS resume was the bug this mapping fixes. |
 *
 * `swe` and `sde` are two rows over one file: `trackKey` is single-valued, so a
 * document serving two tracks needs a row per track. They share a `fileSha256`.
 *
 * A track has exactly one default; the second `ios_android` row is available for the
 * operator to switch to per packet without re-seeding.
 */

export type ResumeVersionSeed = {
  /** Stable label. The seeder upserts on it. */
  label: string
  trackKey: RoleTrackKey
  /** Absolute path to the PDF the operator uploads into the ATS. */
  filePath: string
  /** True for the row wired into `RoleTrack.defaultResumeVersionId`. */
  isTrackDefault: boolean
}

/** Where the operator keeps the library. Overridable so a test never reads it. */
export const RESUME_LIBRARY_DIR = '/Users/aryamanjaiswal/Documents/Resume/resumes'

export const RESUME_VERSIONS: ResumeVersionSeed[] = [
  {
    label: 'iOS / Android — iOS lead',
    trackKey: 'ios_android',
    filePath: `${RESUME_LIBRARY_DIR}/Resume_IOS.pdf`,
    isTrackDefault: true,
  },
  {
    label: 'iOS / Android — Android lead',
    trackKey: 'ios_android',
    filePath: `${RESUME_LIBRARY_DIR}/Resume_android.pdf`,
    isTrackDefault: false,
  },
  {
    label: 'AI Engineer',
    trackKey: 'ai_engineer',
    filePath: `${RESUME_LIBRARY_DIR}/Resume_AI.pdf`,
    isTrackDefault: true,
  },
  {
    label: 'SDE — backend / systems',
    trackKey: 'sde',
    filePath: `${RESUME_LIBRARY_DIR}/Resume_backend.pdf`,
    isTrackDefault: true,
  },
  {
    label: 'SWE — generalist',
    trackKey: 'swe',
    filePath: `${RESUME_LIBRARY_DIR}/Resume_backend.pdf`,
    isTrackDefault: true,
  },
]

/** `file://` form of a path, with each segment encoded so a space survives. */
export function fileUrlFor(path: string): string {
  return `file://${path.split('/').map(encodeURIComponent).join('/')}`
}
