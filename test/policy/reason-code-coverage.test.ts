import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { FetchPolicyGate } from '../../src/core/policy/fetch-policy-gate.js'
import { HostRateLimiter } from '../../src/core/policy/rate-limit.js'
import { seedHostPolicies } from '../../src/core/policy/host-policy.js'
import { checkKillSwitch, engageKillSwitch, releaseKillSwitch } from '../../src/core/killswitch/kill-switch.js'
import { resolveSendingEnabled } from '../../src/core/config/config.js'
import { reachableReasonCodes, type ReasonCodeValue } from '../../src/core/reason-codes/registry.js'
import { runSeedIngest } from '../../src/ingest/yc/seed-loader.js'
import { YC_OSS_FEEDS, YcOssSeedProvider } from '../../src/ingest/yc/yc-oss.js'
import { GreenhouseProvider } from '../../src/ingest/ats/greenhouse.js'
import { ingestPostings } from '../../src/ingest/ats/ingest-postings.js'
import { StubFetcher, readFixture } from '../helpers/fixtures.js'
import { closeTestDb, testDb, truncateAll } from '../helpers/db.js'
import { mockAgent } from '../setup.js'

const USER_AGENT = 'outreach-intelligence-research/0.1 (+https://example.invalid/about)'

beforeEach(async () => {
  await truncateAll()
  await seedHostPolicies(testDb())
})
afterAll(async () => closeTestDb())

function gate(now?: () => Date, limiter?: HostRateLimiter) {
  return new FetchPolicyGate(
    testDb(),
    { userAgent: USER_AGENT, robotsTtlSeconds: 86_400, defaultRateDelayMs: 5_000, ...(now ? { now } : {}) },
    limiter,
  )
}

async function allowHost(host: string, extra: Record<string, unknown> = {}) {
  await testDb().hostPolicy.create({
    data: { host, mode: 'allow', origin: 'derived_company', ...extra },
  })
}

function serveRobots(origin: string, body: string) {
  mockAgent.get(origin).intercept({ path: '/robots.txt', method: 'GET' }).reply(200, body).persist()
}

/**
 * Part G's coverage rule: "every reason code in the closed enum must be reachable
 * by a test. Better completeness signal here than line coverage."
 *
 * Each scenario below drives the REAL code path and asserts the reason it produces.
 * The final assertion checks that the scenario table covers exactly the codes the
 * current build stage claims to be able to raise — so a new F0 code with no
 * scenario, or a scenario for a code the registry says is deferred, fails here.
 */
const scenarios: Record<string, () => Promise<ReasonCodeValue>> = {
  host_denied: async () => {
    const r = await gate().check('https://www.linkedin.com/jobs/view/1')
    return r.allowed ? ('sending_disabled' as ReasonCodeValue) : r.reason
  },

  robots_disallowed: async () => {
    await allowHost('blocked.example')
    serveRobots('https://blocked.example', 'User-agent: *\nDisallow: /careers\n')
    const r = await gate().check('https://blocked.example/careers')
    return r.allowed ? ('sending_disabled' as ReasonCodeValue) : r.reason
  },

  terms_prohibited: async () => {
    await allowHost('prohibited.example', { termsProhibited: true })
    const r = await gate().check('https://prohibited.example/careers')
    return r.allowed ? ('sending_disabled' as ReasonCodeValue) : r.reason
  },

  rate_limited: async () => {
    let now = Date.now()
    const limiter = new HostRateLimiter(5_000, () => now)
    await allowHost('rated.example')
    serveRobots('https://rated.example', 'User-agent: *\nAllow: /\n')
    mockAgent.get('https://rated.example').intercept({ path: /^\/p/, method: 'GET' }).reply(200, 'x').persist()
    const g = gate(() => new Date(now), limiter)
    await g.fetchText('https://rated.example/p1')
    now += 100
    const r = await g.check('https://rated.example/p2')
    return r.allowed ? ('sending_disabled' as ReasonCodeValue) : r.reason
  },

  budget_exhausted: async () => {
    await allowHost('broke.example')
    serveRobots('https://broke.example', 'User-agent: *\nAllow: /\n')
    await testDb().researchBudget.create({
      data: { companyId: null, periodMonth: '2026-03', creditsCap: 0, billedUsdCap: 0 },
    })
    const g = gate(() => new Date('2026-03-10T00:00:00Z'))
    const r = await g.check('https://broke.example/careers')
    return r.allowed ? ('sending_disabled' as ReasonCodeValue) : r.reason
  },

  sending_disabled: async () => {
    const d = resolveSendingEnabled({ envFlag: true })
    return d.enabled ? ('host_denied' as ReasonCodeValue) : d.reason
  },

  kill_switch_global: async () => {
    await engageKillSwitch(testDb(), 'global', '*', 'tester', 'coverage scenario')
    const d = await checkKillSwitch(testDb())
    return d.engaged ? d.reason : ('sending_disabled' as ReasonCodeValue)
  },

  kill_switch_domain: async () => {
    await engageKillSwitch(testDb(), 'domain', 'Example.com', 'tester')
    const d = await checkKillSwitch(testDb(), { domain: 'example.com' })
    return d.engaged ? d.reason : ('sending_disabled' as ReasonCodeValue)
  },

  kill_switch_account: async () => {
    await engageKillSwitch(testDb(), 'account', 'me@owned.example', 'tester')
    const d = await checkKillSwitch(testDb(), { account: 'me@owned.example' })
    return d.engaged ? d.reason : ('sending_disabled' as ReasonCodeValue)
  },

  // --- F1 ingestion -------------------------------------------------------

  /**
   * Two yc-oss records resolving to one registrable domain. The unique index on
   * `canonical_domain` would surface this as a constraint error; the loader turns
   * it into the recorded decision the operator can actually read.
   */
  duplicate: async () => {
    const base = (JSON.parse(readFixture('yc-oss-companies-hiring')) as Record<string, unknown>[])[0]!
    const body = JSON.stringify([
      { ...base, id: 901, name: 'Acme', website: 'https://acme.example' },
      { ...base, id: 902, name: 'Acme again', website: 'http://www.acme.example/careers' },
    ])
    const fetcher = new StubFetcher({ [YC_OSS_FEEDS.hiring]: { body } })
    const result = await runSeedIngest(testDb(), new YcOssSeedProvider(fetcher, { feed: 'hiring' }))
    return result.skipped[0]?.reason ?? ('sending_disabled' as ReasonCodeValue)
  },

  /** A board that answered, with something that is not data. */
  source_unavailable: async () => {
    const company = await testDb().company.create({
      data: {
        canonicalDomain: 'unavailable.example',
        displayName: 'Unavailable',
        countries: [],
        locations: [],
        tags: [],
      },
    })
    const url = 'https://boards-api.greenhouse.io/v1/boards/gone/jobs?content=true'
    const fetcher = new StubFetcher({ [url]: { statusCode: 503, body: 'upstream error' } })
    const result = await ingestPostings(testDb(), new GreenhouseProvider(fetcher), {
      id: company.id,
      atsBoardToken: 'gone',
    })
    return result.sourceFailure?.reason ?? ('sending_disabled' as ReasonCodeValue)
  },

  /**
   * §8.2.4: re-ingesting an identical posting must hit this rather than churning
   * rows. Owned by F1 rather than F2 — see the registry entry.
   */
  content_unchanged: async () => {
    const company = await testDb().company.create({
      data: {
        canonicalDomain: 'unchanged.example',
        displayName: 'Unchanged',
        countries: [],
        locations: [],
        tags: [],
      },
    })
    const token = 'razorpaysoftwareprivatelimited'
    const url = `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`
    const body = readFixture('greenhouse-jobs')
    const board = { id: company.id, atsBoardToken: token }

    await ingestPostings(testDb(), new GreenhouseProvider(new StubFetcher({ [url]: { body } })), board)
    await ingestPostings(testDb(), new GreenhouseProvider(new StubFetcher({ [url]: { body } })), board)

    const audit = await testDb().auditLog.findFirst({
      where: { action: 'ats.posting_unchanged' },
    })
    return (audit?.reasonCode as ReasonCodeValue | undefined) ?? ('sending_disabled' as ReasonCodeValue)
  },
}

describe('every F1-owned reason code is reachable through its real code path', () => {
  for (const [code, run] of Object.entries(scenarios)) {
    it(`raises ${code}`, async () => {
      expect(await run()).toBe(code)
    })
  }

  it('covers exactly the codes this build stage claims to raise', () => {
    expect(Object.keys(scenarios).sort()).toEqual([...reachableReasonCodes('F1')].sort())
  })
})

describe('kill switch (A12)', () => {
  it('is not engaged by default', async () => {
    expect(await checkKillSwitch(testDb())).toEqual({ engaged: false })
  })

  it('reports the broadest engaged scope, so the operator sees the real cause', async () => {
    const db = testDb()
    await engageKillSwitch(db, 'domain', 'example.com', 'tester')
    await engageKillSwitch(db, 'global', '*', 'tester')
    const decision = await checkKillSwitch(db, { domain: 'example.com' })
    expect(decision).toMatchObject({ engaged: true, scope: 'global', reason: 'kill_switch_global' })
  })

  it('scopes a domain switch to that domain only', async () => {
    const db = testDb()
    await engageKillSwitch(db, 'domain', 'blocked.example', 'tester')
    expect(await checkKillSwitch(db, { domain: 'blocked.example' })).toMatchObject({ engaged: true })
    expect(await checkKillSwitch(db, { domain: 'other.example' })).toEqual({ engaged: false })
  })

  it('releases, and records both actions in the audit log', async () => {
    const db = testDb()
    await engageKillSwitch(db, 'global', '*', 'tester', 'pilot paused')
    await releaseKillSwitch(db, 'global', '*', 'tester')
    expect(await checkKillSwitch(db)).toEqual({ engaged: false })

    const actions = (await db.auditLog.findMany({ orderBy: { createdAt: 'asc' } })).map((a) => a.action)
    expect(actions).toContain('kill_switch.engage')
    expect(actions).toContain('kill_switch.release')
  })
})
