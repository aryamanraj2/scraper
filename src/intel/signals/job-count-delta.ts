import type { Db } from '../../core/audit/audit-log.js'
import { writeAudit } from '../../core/audit/audit-log.js'
import { writeCompanySignal } from '../../core/evidence/write-evidence.js'

/**
 * B2's hiring signal: week-over-week change in a company's open ATS job count.
 *
 * The X API is excluded from v1 (no free tier, B2), and the plan's substitute is
 * better for the signal we actually want — "this startup is adding engineers" is
 * measured more reliably by a board's own posting count than by founder chatter.
 *
 * ## No fetch happens here
 *
 * F1 already stores one `job_posting` `CompanySignal` per board read, with the open
 * count in `numericValue` and its own `Evidence` row quoting the board feed
 * (F1 §4.13). The delta is arithmetic over two rows we already hold. That is the
 * whole point of splitting observation from derivation: if the delta definition
 * ever changes, the raw counts replay.
 *
 * ## Where the delta's provenance points
 *
 * The signal cites the NEWER observation's `Evidence` row — the one whose excerpt
 * quotes the count that moved. The older row is not cited on the signal because
 * `CompanySignal` references exactly one `Evidence`, and inventing an `Evidence`
 * row for a number we computed would put a value into the provenance table that no
 * source ever published. Instead the derivation — both observation ids, both
 * counts, both timestamps — is written to `AuditLog`, which is where this system
 * records how it reached a conclusion.
 */

export type JobCountObservation = {
  signalId: string
  evidenceId: string
  count: number
  observedAt: Date
}

export type DeltaOutcome =
  | { computed: true; delta: number; previous: JobCountObservation; latest: JobCountObservation; signalId: string }
  | { computed: false; reason: 'insufficient_observations' | 'already_recorded' }

/** Reads the two most recent `job_posting` observations for a company. */
export async function recentJobCountObservations(
  db: Db,
  companyId: string,
  limit = 2,
): Promise<JobCountObservation[]> {
  const rows = await db.companySignal.findMany({
    where: { companyId, signalType: 'job_posting', numericValue: { not: null } },
    orderBy: { observedAt: 'desc' },
    take: limit,
    select: { id: true, evidenceId: true, numericValue: true, observedAt: true },
  })
  return rows.map((r) => ({
    signalId: r.id,
    evidenceId: r.evidenceId,
    count: r.numericValue as number,
    observedAt: r.observedAt,
  }))
}

/**
 * Computes and records `ats_job_count_delta` for one company.
 *
 * Returns `insufficient_observations` when only one board read exists. That is an
 * ordinary state, not a failure: a company's first refresh can never have a delta,
 * and the scorer treats a null delta as "unknown" rather than as "no growth" —
 * scoring a first observation as flat would penalise every newly-detected board.
 */
export async function computeJobCountDelta(db: Db, companyId: string): Promise<DeltaOutcome> {
  const [latest, previous] = await recentJobCountObservations(db, companyId)
  if (!latest || !previous) return { computed: false, reason: 'insufficient_observations' }

  // Idempotent: a delta is identified by the observation it was computed AT, so a
  // re-run over the same pair must not write a second row. This matters because
  // the weekly refresh and an ad-hoc rescore both call this.
  const existing = await db.companySignal.findFirst({
    where: { companyId, signalType: 'ats_job_count_delta', observedAt: latest.observedAt },
    select: { id: true },
  })
  if (existing) return { computed: false, reason: 'already_recorded' }

  const delta = latest.count - previous.count

  const signal = await writeCompanySignal(db, {
    companyId,
    // The newer observation, whose Evidence excerpt quotes the count that moved.
    evidenceId: latest.evidenceId,
    signalType: 'ats_job_count_delta',
    observedAt: latest.observedAt,
    // Inherited from the observations rather than invented: a delta is exactly as
    // trustworthy as the two board reads behind it.
    confidence: 0.95,
    numericValue: delta,
  })

  await writeAudit(db, {
    actorType: 'system',
    actorId: 'signal-graph',
    action: 'signal.job_count_delta',
    subjectType: 'Company',
    subjectId: companyId,
    metadata: {
      delta,
      latest: { signalId: latest.signalId, evidenceId: latest.evidenceId, count: latest.count, observedAt: latest.observedAt.toISOString() },
      previous: { signalId: previous.signalId, evidenceId: previous.evidenceId, count: previous.count, observedAt: previous.observedAt.toISOString() },
    },
  })

  return { computed: true, delta, previous, latest, signalId: signal.id }
}

/**
 * The most recently recorded delta for a company, for the scorer. Null means
 * "unknown" — fewer than two observations — and never "zero".
 */
export async function latestJobCountDelta(db: Db, companyId: string): Promise<number | null> {
  const row = await db.companySignal.findFirst({
    where: { companyId, signalType: 'ats_job_count_delta' },
    orderBy: { observedAt: 'desc' },
    select: { numericValue: true },
  })
  return row?.numericValue ?? null
}
