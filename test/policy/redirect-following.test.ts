import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { FetchPolicyGate } from '../../src/core/policy/fetch-policy-gate.js'
import { HostRateLimiter } from '../../src/core/policy/rate-limit.js'
import { seedHostPolicies } from '../../src/core/policy/host-policy.js'
import { fetchPage } from '../../src/ingest/fetch-page.js'
import { detectAtsForCompany } from '../../src/ingest/ats/detect.js'
import { StubFetcher } from '../helpers/fixtures.js'
import { closeTestDb, testDb, truncateAll } from '../helpers/db.js'
import { mockAgent } from '../setup.js'

const USER_AGENT = 'outreach-intelligence-research/0.1 (+https://example.invalid/about)'

beforeEach(async () => {
  await truncateAll()
  await seedHostPolicies(testDb())
})
afterAll(async () => closeTestDb())

function redirect(to: string, statusCode = 302) {
  return { statusCode, body: '', headers: { location: to } }
}

describe('redirect following goes back through the gate', () => {
  it('follows apex to www and returns the page that actually served', async () => {
    const fetcher = new StubFetcher({
      'https://acme.example': redirect('https://www.acme.example/'),
      'https://www.acme.example/': { body: '<a href="https://jobs.lever.co/acmeco">Jobs</a>' },
    })

    const page = await fetchPage(fetcher, 'https://acme.example')
    expect(page).toMatchObject({ ok: true, url: 'https://www.acme.example/', fetches: 2 })
  })

  it('resolves a relative Location against the current URL', async () => {
    const fetcher = new StubFetcher({
      'https://acme.example/careers': redirect('/en/careers', 301),
      'https://acme.example/en/careers': { body: 'ok' },
    })
    const page = await fetchPage(fetcher, 'https://acme.example/careers')
    expect(page).toMatchObject({ ok: true, url: 'https://acme.example/en/careers' })
  })

  it('stops at the hop cap instead of chasing forever', async () => {
    const fetcher = new StubFetcher({
      'https://a.example/1': redirect('https://a.example/2'),
      'https://a.example/2': redirect('https://a.example/3'),
      'https://a.example/3': redirect('https://a.example/4'),
      'https://a.example/4': redirect('https://a.example/5'),
    })
    const page = await fetchPage(fetcher, 'https://a.example/1', { maxHops: 2 })
    expect(page).toMatchObject({ ok: false, reason: 'source_unavailable' })
    if (page.ok) throw new Error('unreachable')
    expect(page.detail).toContain('redirect hops')
  })

  it('detects a loop before the cap', async () => {
    const fetcher = new StubFetcher({
      'https://a.example/x': redirect('https://a.example/y'),
      'https://a.example/y': redirect('https://a.example/x'),
    })
    const page = await fetchPage(fetcher, 'https://a.example/x')
    expect(page).toMatchObject({ ok: false, reason: 'source_unavailable' })
    if (page.ok) throw new Error('unreachable')
    expect(page.detail).toContain('redirect loop')
  })

  it('reports a preflight refusal on a hop as that refusal', async () => {
    const fetcher = new StubFetcher(
      { 'https://a.example': redirect('https://blocked.example/careers') },
      { 'https://blocked.example/careers': 'robots_disallowed' },
    )
    const page = await fetchPage(fetcher, 'https://a.example')
    expect(page).toMatchObject({ ok: false, reason: 'robots_disallowed' })
  })
})

/**
 * The reason F0 refused to install undici's redirect interceptor (deviation §4.8):
 * an automatically-followed cross-origin redirect lands on a host the preflight
 * never approved. Following one hop at a time through the gate keeps the check —
 * so a redirect to a denylisted host is refused exactly as a direct request would
 * be, at the transport layer.
 *
 * handover.md §1.4: never automate LinkedIn. A redirect must not be a way around
 * that.
 */
describe('a redirect cannot escape the host policy', () => {
  it('refuses a redirect into a denylisted host, with zero sockets opened to it', async () => {
    mockAgent
      .get('https://redirector.example')
      .intercept({ path: '/robots.txt', method: 'GET' })
      .reply(200, 'User-agent: *\nAllow: /\n')
      .persist()
    mockAgent
      .get('https://redirector.example')
      .intercept({ path: '/careers', method: 'GET' })
      .reply(302, '', { headers: { location: 'https://www.linkedin.com/jobs/view/1' } })
      .persist()

    // Any request to linkedin.com would have to be intercepted to succeed. It is
    // deliberately NOT intercepted: net connect is disabled, so a real attempt
    // throws rather than silently passing.
    await testDb().hostPolicy.create({
      data: { host: 'redirector.example', mode: 'allow', origin: 'derived_company' },
    })

    const gate = new FetchPolicyGate(
      testDb(),
      { userAgent: USER_AGENT, robotsTtlSeconds: 86_400, defaultRateDelayMs: 0 },
      new HostRateLimiter(0),
    )

    const page = await fetchPage(gate, 'https://redirector.example/careers')
    expect(page).toMatchObject({ ok: false, reason: 'host_denied' })

    const refusals = await testDb().auditLog.findMany({
      where: { reasonCode: 'host_denied' },
    })
    expect(refusals.length).toBeGreaterThan(0)
    expect(refusals.some((r) => r.subjectId?.includes('linkedin.com'))).toBe(true)
  })
})

describe('detection follows redirects', () => {
  it('finds a board on the page a redirect lands on', async () => {
    const company = await testDb().company.create({
      data: {
        canonicalDomain: 'redirected.example',
        displayName: 'Redirected',
        countries: [],
        locations: [],
        tags: [],
      },
    })

    const fetcher = new StubFetcher({
      'https://redirected.example': redirect('https://redirected.example/home'),
      'https://redirected.example/home': { body: '<p>Marketing copy</p>' },
      'https://redirected.example/careers': redirect('https://redirected.example/jobs-page'),
      'https://redirected.example/jobs-page': {
        body: '<iframe src="https://job-boards.greenhouse.io/redirectedco"></iframe>',
      },
    })

    const outcome = await detectAtsForCompany(
      testDb(),
      fetcher,
      { ...company, careersUrl: null, website: null },
      { maxPages: 2 },
    )

    expect(outcome).toMatchObject({ found: true })
    if (!outcome.found) throw new Error('unreachable')
    expect(outcome.detection).toMatchObject({ vendor: 'greenhouse', boardToken: 'redirectedco' })
    expect(outcome.sourceUrl).toBe('https://redirected.example/jobs-page')
  })

  it('keeps trying later paths after an ordinary HTTP failure', async () => {
    const company = await testDb().company.create({
      data: {
        canonicalDomain: 'partly.example',
        displayName: 'Partly',
        countries: [],
        locations: [],
        tags: [],
      },
    })

    const fetcher = new StubFetcher({
      'https://partly.example': { statusCode: 500, body: 'server error' },
      'https://partly.example/careers': {
        body: '<a href="https://jobs.ashbyhq.com/partlyco">Roles</a>',
      },
    })

    const outcome = await detectAtsForCompany(
      testDb(),
      fetcher,
      { ...company, careersUrl: null, website: null },
      { maxPages: 2 },
    )

    expect(outcome).toMatchObject({ found: true })
    if (!outcome.found) throw new Error('unreachable')
    expect(outcome.detection.boardToken).toBe('partlyco')
  })
})
