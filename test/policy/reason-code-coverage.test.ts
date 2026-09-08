import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { FetchPolicyGate } from '../../src/core/policy/fetch-policy-gate.js'
import { HostRateLimiter } from '../../src/core/policy/rate-limit.js'
import { seedHostPolicies } from '../../src/core/policy/host-policy.js'
import { checkKillSwitch, engageKillSwitch, releaseKillSwitch } from '../../src/core/killswitch/kill-switch.js'
import { resolveSendingEnabled } from '../../src/core/config/config.js'
import { reachableReasonCodes, type ReasonCodeValue } from '../../src/core/reason-codes/registry.js'
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
}

describe('every F0-owned reason code is reachable through its real code path', () => {
  for (const [code, run] of Object.entries(scenarios)) {
    it(`raises ${code}`, async () => {
      expect(await run()).toBe(code)
    })
  }

  it('covers exactly the codes this build stage claims to raise', () => {
    expect(Object.keys(scenarios).sort()).toEqual([...reachableReasonCodes('F0')].sort())
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
