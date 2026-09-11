import type { Db } from '../../core/audit/audit-log.js'
import { MILESTONE_STAGE, isAtOrAfter, type Milestone } from '../../core/config/stage.js'
import { domainOf } from '../../core/crypto/secret-store.js'
import { sentOnDay, sentToDomainOnDay } from './counters.js'

/**
 * D6 condition 6 — daily and per-domain caps.
 *
 * `handover.md` §8 and Part F's F6 row set the ramp: *"five approved first-touch
 * emails/business day for week one, ten for week two if no warning metrics, then a
 * maximum of 20 first-touch emails/business day. No bulk blast."*
 *
 * ## Why F5's cap is lower than F6's floor
 *
 * At F5 every recipient is an owned inbox, so the cap is not protecting anyone from
 * us — it is protecting the sending account's reputation from a test loop, and
 * bounding the blast radius of a bug in the send loop itself. Twenty diagnostic
 * messages to your own inbox in a minute is a runaway, and it is the kind of runaway
 * that is easiest to write.
 *
 * The ramp beyond week one is **not** encoded here. F6 owns it, it is gated on
 * measured first-party signals (Part G's rollout criteria: "zero hard bounces, zero
 * opt-outs, zero wrong-contact reports"), and a cap that raised itself on a calendar
 * would be exactly the automatic escalation those criteria exist to prevent.
 *
 * ## The per-domain cap
 *
 * §8 asks for "conservative per-domain caps". It matters more than the daily cap for a
 * corpus like this one: the Tier A yield measured four `info@` addresses at four
 * different companies, but a wider corpus will have many recipients behind Google
 * Workspace, and a receiving provider judges a sender by what arrives from them in
 * aggregate.
 */

export type SendCaps = {
  perDay: number
  perDomainPerDay: number
}

export function capsForStage(stage: Milestone = MILESTONE_STAGE): SendCaps {
  // F6's week one. Beyond that is F6's decision, taken against measured signals.
  if (isAtOrAfter(stage, 'F6')) return { perDay: 5, perDomainPerDay: 3 }
  // F5: owned inboxes only. Enough to test threading and reconciliation, small enough
  // that a loop bug is visible rather than expensive.
  return { perDay: 10, perDomainPerDay: 10 }
}

export type CapVerdict =
  | { allowed: true; sentToday: number; sentToDomainToday: number }
  | { allowed: false; reason: 'cap_exceeded'; detail: string }

export async function checkCaps(
  db: Db,
  recipientEmail: string,
  opts: { now?: Date; caps?: SendCaps; stage?: Milestone } = {},
): Promise<CapVerdict> {
  const now = opts.now ?? new Date()
  const caps = opts.caps ?? capsForStage(opts.stage)

  const sentToday = await sentOnDay(db, now)
  if (sentToday >= caps.perDay) {
    return {
      allowed: false,
      reason: 'cap_exceeded',
      detail: `${sentToday} sent today, daily cap is ${caps.perDay}`,
    }
  }

  const domain = domainOf(recipientEmail)
  const sentToDomainToday = domain === '' ? 0 : await sentToDomainOnDay(db, domain, now)
  if (domain !== '' && sentToDomainToday >= caps.perDomainPerDay) {
    return {
      allowed: false,
      reason: 'cap_exceeded',
      detail: `${sentToDomainToday} sent to ${domain} today, per-domain cap is ${caps.perDomainPerDay}`,
    }
  }

  return { allowed: true, sentToday, sentToDomainToday }
}
