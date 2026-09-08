import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { FetchPolicyGate } from '../../src/core/policy/fetch-policy-gate.js'
import { HostRateLimiter } from '../../src/core/policy/rate-limit.js'
import { seedHostPolicies } from '../../src/core/policy/host-policy.js'
import { closeTestDb, testDb, truncateAll } from '../helpers/db.js'
import { mockAgent } from '../setup.js'

const USER_AGENT = 'outreach-intelligence-research/0.1 (+https://example.invalid/about)'

function gate(now?: () => Date, limiter?: HostRateLimiter) {
  return new FetchPolicyGate(
    testDb(),
    {
      userAgent: USER_AGENT,
      robotsTtlSeconds: 86_400,
      defaultRateDelayMs: 5_000,
      ...(now ? { now } : {}),
    },
    limiter,
  )
}

beforeEach(async () => {
  await truncateAll()
  await seedHostPolicies(testDb())
})
afterAll(async () => closeTestDb())

describe('FetchPolicyGate — D4 preflight', () => {
  it('refuses a denied host and opens NO socket to it', async () => {
    // Transport-level assertion, not an adapter-level one (Part G). If any code
    // path reached LinkedIn, this interceptor would fire and flip the flag.
    let linkedinWasContacted = false
    mockAgent
      .get('https://www.linkedin.com')
      .intercept({ path: /.*/, method: 'GET' })
      .reply(() => {
        linkedinWasContacted = true
        return { statusCode: 200, data: '' }
      })
      .persist()

    const result = await gate().check('https://www.linkedin.com/jobs/view/123')
    expect(result).toEqual({ allowed: false, reason: 'host_denied' })
    expect(linkedinWasContacted).toBe(false)

    // Even the robots.txt probe must not happen — a denied host is refused before
    // any URL is constructed.
    const fetched = await gate().fetchText('https://www.linkedin.com/company/example')
    expect(fetched).toEqual({ ok: false, reason: 'host_denied' })
    expect(linkedinWasContacted).toBe(false)

    const audits = await testDb().auditLog.findMany({ where: { reasonCode: 'host_denied' } })
    expect(audits.length).toBe(2)
  })

  it('refuses a LeadHint URL pointing at a gated platform', async () => {
    // handover.md §15: the dashboard stores the user's URL as a hint and never
    // fetches it. D4 step 5 makes that structural rather than a convention.
    const db = testDb()
    const hint = await db.leadHint.create({
      data: { rawUrl: 'https://linkedin.com/jobs/view/999', note: 'saw this role' },
    })
    const result = await gate().check(hint.rawUrl!)
    expect(result).toEqual({ allowed: false, reason: 'host_denied' })
  })

  it('refuses an unknown host — allowlist membership is required, not optional', async () => {
    const result = await gate().check('https://random-startup.example/careers')
    expect(result).toEqual({ allowed: false, reason: 'host_denied' })
  })

  it('allows an employer host once it has a derived_company allow entry', async () => {
    const db = testDb()
    await db.hostPolicy.create({
      data: {
        host: 'startup.example',
        mode: 'allow',
        origin: 'derived_company',
        sourceUrl: 'https://startup.example/',
        note: 'canonical domain of an ingested Company',
      },
    })
    mockAgent
      .get('https://startup.example')
      .intercept({ path: '/robots.txt', method: 'GET' })
      .reply(200, 'User-agent: *\nAllow: /\n')

    const result = await gate().check('https://startup.example/careers')
    expect(result).toEqual({ allowed: true, rateDelayMs: 5_000 })
  })

  it('honours robots.txt for our exact path, and issues no request to the disallowed page', async () => {
    let pageWasFetched = false
    mockAgent
      .get('https://startup.example')
      .intercept({ path: '/robots.txt', method: 'GET' })
      .reply(200, 'User-agent: *\nDisallow: /careers\nAllow: /about\n')
      .persist()
    mockAgent
      .get('https://startup.example')
      .intercept({ path: '/careers', method: 'GET' })
      .reply(() => {
        pageWasFetched = true
        return { statusCode: 200, data: 'jobs' }
      })
      .persist()

    await testDb().hostPolicy.create({
      data: { host: 'startup.example', mode: 'allow', origin: 'derived_company' },
    })

    const result = await gate().fetchText('https://startup.example/careers')
    expect(result).toEqual({ ok: false, reason: 'robots_disallowed' })
    expect(pageWasFetched).toBe(false)
  })

  it('treats an unreachable robots.txt as restrictive, not permissive', async () => {
    await testDb().hostPolicy.create({
      data: { host: 'broken.example', mode: 'allow', origin: 'derived_company' },
    })
    // No interceptor registered and net connect disabled: the probe throws, which
    // is the "missing or unparseable" case.
    const result = await gate().check('https://broken.example/careers')
    expect(result).toEqual({ allowed: false, reason: 'robots_disallowed' })

    const cached = await testDb().robotsCache.findUnique({ where: { host: 'broken.example' } })
    expect(cached?.parseOk).toBe(false)
  })

  it('lets stated terms override a permissive robots.txt', async () => {
    let robotsWasFetched = false
    mockAgent
      .get('https://terms.example')
      .intercept({ path: '/robots.txt', method: 'GET' })
      .reply(() => {
        robotsWasFetched = true
        return { statusCode: 200, data: 'User-agent: *\nAllow: /\n' }
      })
      .persist()

    await testDb().hostPolicy.create({
      data: {
        host: 'terms.example',
        mode: 'allow',
        origin: 'operator',
        termsProhibited: true,
        note: 'terms prohibit automated access',
      },
    })

    const result = await gate().check('https://terms.example/careers')
    expect(result).toEqual({ allowed: false, reason: 'terms_prohibited' })
    // Not even a robots probe: robots permission cannot rescue a prohibited host.
    expect(robotsWasFetched).toBe(false)
  })

  it('applies the per-host delay, and a published crawl-delay beats our default', async () => {
    let now = new Date('2026-01-01T00:00:00Z').getTime()
    const limiter = new HostRateLimiter(5_000, () => now)
    mockAgent
      .get('https://slow.example')
      .intercept({ path: '/robots.txt', method: 'GET' })
      .reply(200, 'User-agent: *\nAllow: /\nCrawl-delay: 30\n')
      .persist()
    mockAgent
      .get('https://slow.example')
      .intercept({ path: /^\/page/, method: 'GET' })
      .reply(200, 'content')
      .persist()

    await testDb().hostPolicy.create({
      data: { host: 'slow.example', mode: 'allow', origin: 'derived_company' },
    })
    const g = gate(() => new Date(now), limiter)

    const first = await g.fetchText('https://slow.example/page1')
    expect(first.ok).toBe(true)

    now += 10_000
    expect(await g.check('https://slow.example/page2')).toEqual({
      allowed: false,
      reason: 'rate_limited',
    })

    now += 21_000
    expect(await g.check('https://slow.example/page2')).toEqual({
      allowed: true,
      rateDelayMs: 30_000,
    })
  })

  it('stops when the research budget is exhausted', async () => {
    const db = testDb()
    mockAgent
      .get('https://budget.example')
      .intercept({ path: '/robots.txt', method: 'GET' })
      .reply(200, 'User-agent: *\nAllow: /\n')
      .persist()
    await db.hostPolicy.create({
      data: { host: 'budget.example', mode: 'allow', origin: 'derived_company' },
    })
    const company = await db.company.create({
      data: { canonicalDomain: 'budget.example', displayName: 'Budget Co' },
    })
    await db.researchBudget.create({
      data: { companyId: company.id, periodMonth: '2026-01', creditsCap: 0, billedUsdCap: 0 },
    })

    const g = gate(() => new Date('2026-01-15T00:00:00Z'))
    const result = await g.check('https://budget.example/careers', { companyId: company.id })
    expect(result).toEqual({ allowed: false, reason: 'budget_exhausted' })
  })

  it('stops when the global monthly cap is exhausted, even for an unbudgeted company', async () => {
    const db = testDb()
    mockAgent
      .get('https://global.example')
      .intercept({ path: '/robots.txt', method: 'GET' })
      .reply(200, 'User-agent: *\nAllow: /\n')
      .persist()
    await db.hostPolicy.create({
      data: { host: 'global.example', mode: 'allow', origin: 'derived_company' },
    })
    await db.researchBudget.create({
      data: { companyId: null, periodMonth: '2026-01', creditsCap: 0, billedUsdCap: 0 },
    })

    const g = gate(() => new Date('2026-01-15T00:00:00Z'))
    expect(await g.check('https://global.example/careers')).toEqual({
      allowed: false,
      reason: 'budget_exhausted',
    })
  })

  it('records every refusal with its reason code, so a vanished source is visible', async () => {
    await gate().check('https://linkedin.com/x')
    await gate().check('https://unknown.example/y')
    const counts = await testDb().auditLog.groupBy({
      by: ['reasonCode'],
      _count: { _all: true },
      where: { action: 'fetch.refused' },
    })
    const byReason = Object.fromEntries(counts.map((c) => [c.reasonCode, c._count._all]))
    expect(byReason.host_denied).toBe(2)
  })

  it('rejects non-http schemes and unparseable URLs', async () => {
    expect(await gate().check('file:///etc/passwd')).toEqual({ allowed: false, reason: 'host_denied' })
    expect(await gate().check('not a url')).toEqual({ allowed: false, reason: 'host_denied' })
  })
})
