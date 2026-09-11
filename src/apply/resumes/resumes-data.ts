import type { RoleTrackKey } from '../../../generated/prisma/enums.js'

/**
 * The operator's resume library — the seam `RoleTrack.defaultResumeVersionId` was
 * left null for. F2's seeder deliberately did not fill it in, because which resume
 * goes with which track is operator data, not taxonomy.
 *
 * ## `hostedUrl` and `filePath` are both real, and neither replaces the other
 *
 * The two terminal actions want different artefacts, and F3 got this half right.
 *
 * An `ApplicationPacket` is submitted by the operator, by hand, through the employer's
 * own ATS — where a resume is **uploaded**, so what matters is the file on disk and
 * its hash. `filePath` and `fileSha256` stay exactly as F3 had them, and A7 hashes
 * `fileSha256` so an edit in place invalidates an approval.
 *
 * A draft is an **email**, where H3 applies ("link on first contact, attach after
 * reply" — B5: a new sending domain plus an attachment is the worst deliverability
 * combination available) and a `file://` path is useless to the recipient. F3 wrote
 * `linkUrl` as the `file://` form of `filePath` so nothing had to special-case a
 * missing value, and flagged replacing it as F4's job; F4 did not, and §2.3 of the F5
 * handover shows the result sitting in the body of a real approved draft:
 * `Resume: file:///Users/.../Resume_AI.pdf`.
 *
 * So `hostedUrl` is now the seed field and `linkUrl` is derived from it, falling back
 * to the `file://` form only when a document has not been hosted. The fallback is not
 * a convenience: a composer that silently emitted an empty resume line would be worse
 * than one that emits a visibly wrong link, and `verify:f5` refuses a `file://`
 * `linkUrl` outright.
 *
 * **Re-seeding with hosted URLs invalidates every existing `approval_hash`**, because
 * the approved message contained a different link. That is A7 working, not a problem
 * to route around.
 *
 * ## `swe` and `sde` are two rows over one file
 *
 * `trackKey` is single-valued, so a document serving two tracks needs a row per track.
 * They share a `filePath`, a `fileSha256` **and** a `hostedUrl`. Nothing may assume
 * the hash identifies a row: A7 hashes `resumeVersionId` and `resumeSha256` together,
 * so the pair still distinguishes the two while the hash alone does not.
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
  /**
   * Public https URL of the same document — what a draft links (H3).
   *
   * Verified by the operator to serve `200 application/pdf` inline, with no viewer
   * interception and no forced download: a recruiter who clicks this sees the resume,
   * which is the only thing that makes linking rather than attaching work.
   *
   * Null means "not hosted yet", and the seeder falls back to the `file://` form so a
   * packet still works. `verify:f5` treats a `file://` `linkUrl` as a failure.
   */
  hostedUrl: string | null
  /** True for the row wired into `RoleTrack.defaultResumeVersionId`. */
  isTrackDefault: boolean
}

/** Where the operator keeps the library. Overridable so a test never reads it. */
export const RESUME_LIBRARY_DIR = '/Users/aryamanjaiswal/Documents/Resume/resumes'

/** Where the operator publishes it. Same documents, public and linkable. */
export const RESUME_HOSTED_BASE = 'https://aryamanj.in/resume'

export const RESUME_VERSIONS: ResumeVersionSeed[] = [
  {
    label: 'iOS / Android — iOS lead',
    trackKey: 'ios_android',
    filePath: `${RESUME_LIBRARY_DIR}/Resume_IOS.pdf`,
    hostedUrl: `${RESUME_HOSTED_BASE}/ios.pdf`,
    isTrackDefault: true,
  },
  {
    label: 'iOS / Android — Android lead',
    trackKey: 'ios_android',
    filePath: `${RESUME_LIBRARY_DIR}/Resume_android.pdf`,
    hostedUrl: `${RESUME_HOSTED_BASE}/android.pdf`,
    isTrackDefault: false,
  },
  {
    label: 'AI Engineer',
    trackKey: 'ai_engineer',
    filePath: `${RESUME_LIBRARY_DIR}/Resume_AI.pdf`,
    hostedUrl: `${RESUME_HOSTED_BASE}/ai.pdf`,
    isTrackDefault: true,
  },
  {
    label: 'SDE — backend / systems',
    trackKey: 'sde',
    filePath: `${RESUME_LIBRARY_DIR}/Resume_backend.pdf`,
    hostedUrl: `${RESUME_HOSTED_BASE}/backend.pdf`,
    isTrackDefault: true,
  },
  {
    label: 'SWE — generalist',
    trackKey: 'swe',
    filePath: `${RESUME_LIBRARY_DIR}/Resume_backend.pdf`,
    // Same document as `sde`, so the same hosted URL. Two rows, one file, one link.
    hostedUrl: `${RESUME_HOSTED_BASE}/backend.pdf`,
    isTrackDefault: true,
  },
]

/** `file://` form of a path, with each segment encoded so a space survives. */
export function fileUrlFor(path: string): string {
  return `file://${path.split('/').map(encodeURIComponent).join('/')}`
}

/** What a draft links: the hosted document, or the local path if it is not hosted. */
export function linkUrlFor(seed: ResumeVersionSeed): string {
  return seed.hostedUrl ?? fileUrlFor(seed.filePath)
}
