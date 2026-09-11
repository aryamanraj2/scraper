import type { Db } from '../../core/audit/audit-log.js'
import { checkKillSwitch } from '../../core/killswitch/kill-switch.js'
import type { ReasonCodeValue } from '../../core/reason-codes/registry.js'
import { deliverabilityCounters } from './counters.js'

/**
 * D6 condition 7 — the circuit breaker.
 *
 * > *"circuit breaker closed — hard-bounce rate, manual kill switch, and **complaint
 * > signal *if available*** (not an observable required metric at pilot volume, per
 * > B3; its absence must never block a send, and must never be rendered as
 * > 'healthy')"*
 *
 * Three inputs, and the third is the one everybody gets wrong. The complaint signal is
 * read if it exists and is otherwise reported as `unavailable` — never as zero, never
 * as a pass, and never as a fail. `counters.ts` types it as a three-state value
 * precisely so that "no data" cannot be silently coerced into "healthy" by a `?? 0`.
 *
 * ## The hard-bounce threshold, and the trap in it
 *
 * A rate needs a denominator. At five sends, one hard bounce is 20% — which is either
 * a catastrophe or a typo, and the arithmetic cannot tell you which. A breaker that
 * trips on a rate alone would fire on the first mistake of the pilot and stay tripped;
 * one that ignores small samples would not fire until real damage was done.
 *
 * So both must hold: at least `minSample` sends in the window **and** a rate above the
 * threshold. Below the sample floor the breaker instead trips on an absolute count,
 * because three hard bounces is wrong at any volume and does not need a rate to say
 * so.
 *
 * A11's reasoning generalises here: *"seven components against ~25 sends/week and a
 * sub-10% reply rate means 0-3 positive events. Fitting weights on that actively
 * degrades the system."* The same sample problem applies to a breaker, and the answer
 * is the same — do not pretend a ratio is meaningful before it is.
 */

export type BreakerConfig = {
  windowDays: number
  /** Trip above this rate, once the sample floor is met. */
  hardBounceRate: number
  minSample: number
  /** Trip on this many hard bounces regardless of sample size. */
  absoluteHardBounces: number
}

export const DEFAULT_BREAKER: BreakerConfig = {
  windowDays: 30,
  hardBounceRate: 0.05,
  minSample: 20,
  absoluteHardBounces: 3,
}

export type BreakerVerdict =
  | { open: false; hardBounces: number; sent: number; complaintSignal: 'unavailable' | 'observed' }
  | { open: true; reason: ReasonCodeValue; detail: string }

export async function checkBreaker(
  db: Db,
  opts: {
    config?: BreakerConfig
    now?: Date
    /** Recipient domain and sender account, for the scoped kill switches. */
    domain?: string | undefined
    account?: string | undefined
  } = {},
): Promise<BreakerVerdict> {
  const config = opts.config ?? DEFAULT_BREAKER

  // The manual switch first. It is the operator saying stop, and no computed signal
  // should be able to out-vote it or delay reporting it. A12 also requires that
  // engaging it CANCELS scheduled jobs rather than pausing them — that is
  // `cancelScheduledSends` in the queue module; this is the read side.
  const kill = await checkKillSwitch(db, {
    ...(opts.domain ? { domain: opts.domain } : {}),
    ...(opts.account ? { account: opts.account } : {}),
  })
  if (kill.engaged) {
    return { open: true, reason: kill.reason, detail: `kill switch engaged at ${kill.scope}:${kill.target}` }
  }

  const counters = await deliverabilityCounters(db, {
    windowDays: config.windowDays,
    ...(opts.now ? { now: opts.now } : {}),
  })

  if (counters.hardBounces >= config.absoluteHardBounces) {
    return {
      open: true,
      reason: 'breaker_open',
      detail:
        `${counters.hardBounces} hard bounces in ${config.windowDays}d ` +
        `(absolute limit ${config.absoluteHardBounces})`,
    }
  }

  if (counters.sent >= config.minSample && counters.hardBounceRate !== null) {
    if (counters.hardBounceRate > config.hardBounceRate) {
      return {
        open: true,
        reason: 'breaker_open',
        detail:
          `hard-bounce rate ${(counters.hardBounceRate * 100).toFixed(1)}% over ` +
          `${counters.sent} sends exceeds ${(config.hardBounceRate * 100).toFixed(1)}%`,
      }
    }
  }

  return {
    open: false,
    hardBounces: counters.hardBounces,
    sent: counters.sent,
    // Reported, never scored. An `unavailable` complaint signal is not evidence of
    // health and this value exists so a caller cannot forget that it is missing.
    complaintSignal: counters.complaintSignal.state,
  }
}
