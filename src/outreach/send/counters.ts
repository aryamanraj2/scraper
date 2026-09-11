import type { Db } from '../../core/audit/audit-log.js'

/**
 * First-party deliverability counters — B3, and nothing else.
 *
 * > *"Postmaster reporting is not dependable at the volumes this system will send…
 * > Do not build a reputation chart that renders empty and implies health. Instrument
 * > first-party counters only (sends, hard/soft bounces, replies, opt-outs from the
 * > Gmail API) and label provider reputation explicitly as not reliably observable at
 * > pilot volume."*
 *
 * Every number here is derived from rows this system wrote about messages it sent.
 * There is no Postmaster Tools client, no reputation score, and no field that could be
 * rendered as one. That is a deliberate absence rather than an omission: F3 §4.14
 * established the house rule that a panel a later milestone fills reports "not built"
 * rather than `0`, because a zero beside "Bounced" reads as *"nothing has bounced"*.
 *
 * The same rule is why `complaintSignal` is a three-state value rather than a number.
 * D6 condition 7 makes the complaint signal optional — *"not an observable required
 * metric at pilot volume; its absence must never block a send, and must never be
 * rendered as 'healthy'"*. A `0` would do exactly that. `'unavailable'` cannot.
 */

export type ComplaintSignal =
  | { state: 'unavailable'; why: string }
  | { state: 'observed'; rate: number }

export type DeliverabilityCounters = {
  windowDays: number
  /** Attempts that reached the provider — `sent`, not merely written. */
  sent: number
  inFlight: number
  failed: number
  aborted: number
  hardBounces: number
  softBounces: number
  replies: number
  optOuts: number
  /** Of `sent`. Null when nothing was sent, because 0/0 is not 0% (B3's own point). */
  hardBounceRate: number | null
  complaintSignal: ComplaintSignal
  /** B3, carried in the data so a UI cannot render the panel without it. */
  providerReputationNote: string
}

export const PROVIDER_REPUTATION_NOTE =
  'Provider reputation is not reliably observable at pilot volume (B3). These are ' +
  'first-party counters only: what this system sent, and what came back to this mailbox.'

export async function deliverabilityCounters(
  db: Db,
  opts: { windowDays?: number; now?: Date } = {},
): Promise<DeliverabilityCounters> {
  const windowDays = opts.windowDays ?? 30
  const now = opts.now ?? new Date()
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000)

  const [sent, inFlight, failed, aborted, hardBounces, softBounces, replies, optOuts] =
    await Promise.all([
      db.sendAttempt.count({ where: { status: 'sent', attemptedAt: { gte: since } } }),
      db.sendAttempt.count({ where: { status: 'in_flight', attemptedAt: { gte: since } } }),
      db.sendAttempt.count({ where: { status: 'failed', attemptedAt: { gte: since } } }),
      db.sendAttempt.count({ where: { status: 'aborted', attemptedAt: { gte: since } } }),
      db.bounce.count({ where: { hardness: 'hard', occurredAt: { gte: since } } }),
      db.bounce.count({ where: { hardness: 'soft', occurredAt: { gte: since } } }),
      db.reply.count({ where: { receivedAt: { gte: since } } }),
      db.optOut.count({ where: { occurredAt: { gte: since } } }),
    ])

  return {
    windowDays,
    sent,
    inFlight,
    failed,
    aborted,
    hardBounces,
    softBounces,
    replies,
    optOuts,
    hardBounceRate: sent === 0 ? null : hardBounces / sent,
    complaintSignal: {
      state: 'unavailable',
      why:
        'Gmail exposes no per-message complaint signal to a sender at this volume, and ' +
        'Postmaster Tools withholds data below its reporting threshold (B3).',
    },
    providerReputationNote: PROVIDER_REPUTATION_NOTE,
  }
}

/** Sends that actually reached the provider on a given UTC day. */
export async function sentOnDay(db: Db, day: Date): Promise<number> {
  const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()))
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
  return db.sendAttempt.count({
    where: {
      // `in_flight` counts against the cap as well as `sent`. An attempt whose outcome
      // is unknown may well have been delivered, and a cap that only counted confirmed
      // sends would let a run of ambiguous failures quietly exceed it.
      status: { in: ['sent', 'in_flight'] },
      attemptedAt: { gte: start, lt: end },
    },
  })
}

/** Sends to one recipient domain on a given UTC day. */
export async function sentToDomainOnDay(db: Db, domain: string, day: Date): Promise<number> {
  const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()))
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
  return db.sendAttempt.count({
    where: {
      status: { in: ['sent', 'in_flight'] },
      attemptedAt: { gte: start, lt: end },
      contact: { emailNormalized: { endsWith: `@${domain.toLowerCase()}` } },
    },
  })
}
