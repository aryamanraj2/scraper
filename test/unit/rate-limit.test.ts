import { describe, expect, it } from 'vitest'
import { HostRateLimiter, effectiveDelayMs } from '../../src/core/policy/rate-limit.js'

describe('per-host rate policy (D4 step 4)', () => {
  it('spaces requests to one host by the effective delay', () => {
    let now = 1_000_000
    const limiter = new HostRateLimiter(5_000, () => now)

    expect(limiter.check('example.com')).toEqual({ allowed: true, rateDelayMs: 5_000 })
    limiter.record('example.com')

    now += 1_000
    expect(limiter.check('example.com')).toEqual({ allowed: false, retryAfterMs: 4_000 })

    now += 4_000
    expect(limiter.check('example.com')).toEqual({ allowed: true, rateDelayMs: 5_000 })
  })

  it('tracks hosts independently', () => {
    let now = 0
    const limiter = new HostRateLimiter(1_000, () => now)
    limiter.record('a.example')
    now += 10
    expect(limiter.check('b.example').allowed).toBe(true)
    expect(limiter.check('a.example').allowed).toBe(false)
  })

  it('lets a published crawl-delay beat our default, never the other way round', () => {
    // A site asking for 30s gets 30s even though our default is 5s.
    expect(effectiveDelayMs(5_000, null, 30)).toBe(30_000)
    // A site asking for 1s still gets our conservative 5s.
    expect(effectiveDelayMs(5_000, null, 1)).toBe(5_000)
    // An operator override raises, and a crawl-delay can still raise it further.
    expect(effectiveDelayMs(5_000, 10_000, null)).toBe(10_000)
    expect(effectiveDelayMs(5_000, 10_000, 60)).toBe(60_000)
  })
})
