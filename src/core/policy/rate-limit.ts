/**
 * D4 preflight step 4: a per-host token bucket with a conservative default and a
 * documented per-host override. A published rate limit or crawl-delay always wins
 * over our default — never the other way round.
 *
 * Implemented as a last-request timestamp per host rather than a classic bucket:
 * at this volume the property we actually want is minimum SPACING between requests
 * to one host, which is what a crawl-delay means. A burst-capable bucket would
 * satisfy an average and still violate the delay.
 */
export type RateDecision =
  | { allowed: true; rateDelayMs: number }
  | { allowed: false; retryAfterMs: number }

export class HostRateLimiter {
  private readonly lastRequestAt = new Map<string, number>()

  constructor(
    private readonly defaultDelayMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * @param effectiveDelayMs the delay that applies to this host — the maximum of
   * our default, any per-host override, and any published crawl-delay.
   */
  check(host: string, effectiveDelayMs = this.defaultDelayMs): RateDecision {
    const last = this.lastRequestAt.get(host)
    const t = this.now()
    if (last === undefined) return { allowed: true, rateDelayMs: effectiveDelayMs }
    const elapsed = t - last
    if (elapsed >= effectiveDelayMs) return { allowed: true, rateDelayMs: effectiveDelayMs }
    return { allowed: false, retryAfterMs: effectiveDelayMs - elapsed }
  }

  /** Called only after a request is actually issued. */
  record(host: string): void {
    this.lastRequestAt.set(host, this.now())
  }

  reset(): void {
    this.lastRequestAt.clear()
  }
}

/** The delay that applies, given our default, an operator override and a published crawl-delay. */
export function effectiveDelayMs(
  defaultDelayMs: number,
  overrideMs: number | null | undefined,
  crawlDelaySeconds: number | null | undefined,
): number {
  const published = crawlDelaySeconds != null ? crawlDelaySeconds * 1000 : 0
  const override = overrideMs ?? 0
  return Math.max(defaultDelayMs, override, published)
}
