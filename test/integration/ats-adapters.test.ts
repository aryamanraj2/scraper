import { describe, expect, it } from 'vitest'
import type { AtsProvider } from '../../src/core/interfaces/providers.js'
import { GreenhouseProvider } from '../../src/ingest/ats/greenhouse.js'
import { LeverProvider } from '../../src/ingest/ats/lever.js'
import { AshbyProvider } from '../../src/ingest/ats/ashby.js'
import { isSourceError } from '../../src/ingest/source-error.js'
import { StubFetcher, readFixture, readFixtureMeta } from '../helpers/fixtures.js'
import { mockAgent } from '../setup.js'

/**
 * Part G's test layers: "contract tests run against both real-with-fixtures and
 * fake adapters".
 *
 * Both halves run here, and they check different things. The MockAgent half proves
 * the adapter's REAL request path — through `FetchPolicyGate`, through undici,
 * through the transport the mock intercepts — parses a genuine recorded response.
 * The `StubFetcher` half proves the adapter's behaviour independently of the
 * transport, including the failure shapes a live source will not reproduce on
 * demand.
 *
 * Every fixture in `test/fixtures/` was captured from the live endpoint by
 * `npm run fixtures:record`. handover.md §11: no test touches a live source.
 */

type Case = {
  vendor: string
  fixture: string
  boardToken: string
  build: (fetcher: StubFetcher) => AtsProvider & { boardUrl(token: string): string }
  /** A field only this vendor's shape produces, to prove the mapping is real. */
  expect: (postings: Awaited<ReturnType<AtsProvider['listPostings']>>) => void
}

const CASES: Case[] = [
  {
    vendor: 'greenhouse',
    fixture: 'greenhouse-jobs',
    boardToken: 'razorpaysoftwareprivatelimited',
    build: (f) => new GreenhouseProvider(f),
    expect: (postings) => {
      // Greenhouse nests the location under `location.name` and publishes the
      // application URL on the migrated `job-boards.` host (B6).
      expect(postings.some((p) => p.location !== null)).toBe(true)
      expect(postings.every((p) => p.url.startsWith('https://'))).toBe(true)
      expect(postings.some((p) => p.url.includes('job-boards.greenhouse.io'))).toBe(true)
    },
  },
  {
    vendor: 'lever',
    fixture: 'lever-postings',
    boardToken: 'leverdemo',
    build: (f) => new LeverProvider(f),
    expect: (postings) => {
      // Lever calls the title `text` and dates postings in epoch milliseconds.
      expect(postings.every((p) => p.title.length > 0)).toBe(true)
      expect(postings.some((p) => p.postedAt instanceof Date)).toBe(true)
      expect(postings.some((p) => p.url.includes('jobs.lever.co/leverdemo'))).toBe(true)
    },
  },
  {
    vendor: 'ashby',
    fixture: 'ashby-job-board',
    boardToken: 'ashby',
    build: (f) => new AshbyProvider(f),
    expect: (postings) => {
      expect(postings.some((p) => p.url.includes('jobs.ashbyhq.com/ashby'))).toBe(true)
      expect(postings.some((p) => p.postedAt instanceof Date)).toBe(true)
    },
  },
]

describe.each(CASES)('$vendor adapter', (testCase) => {
  const build = () => {
    const fetcher = new StubFetcher({})
    const provider = testCase.build(fetcher)
    return { provider, fetcher, url: provider.boardUrl(testCase.boardToken) }
  }

  it('parses the recorded live response into Postings', async () => {
    const { provider, url } = build()
    const fetcher = new StubFetcher({ [url]: { body: readFixture(testCase.fixture) } })
    const withFixture = testCase.build(fetcher)

    const postings = await withFixture.listPostings(testCase.boardToken)
    expect(postings.length).toBeGreaterThan(0)
    for (const posting of postings) {
      expect(posting.externalId).not.toBe('')
      expect(posting.title).not.toBe('')
      expect(posting.url).not.toBe('')
    }
    testCase.expect(postings)
    expect(provider.boardUrl(testCase.boardToken)).toBe(url)
  })

  it('issues exactly one request — these boards do not paginate', async () => {
    const { url } = build()
    const fetcher = new StubFetcher({ [url]: { body: readFixture(testCase.fixture) } })
    await testCase.build(fetcher).listPostings(testCase.boardToken)
    expect(fetcher.requested).toEqual([url])
  })

  it('reports a preflight refusal as that refusal, not as bad data', async () => {
    const { url } = build()
    const fetcher = new StubFetcher({}, { [url]: 'robots_disallowed' })
    const provider = testCase.build(fetcher)
    await expect(provider.listPostings(testCase.boardToken)).rejects.toSatisfy(
      (err: unknown) => isSourceError(err) && err.reasonCode === 'robots_disallowed',
    )
  })

  it('reports a non-2xx as source_unavailable', async () => {
    const { url } = build()
    const fetcher = new StubFetcher({ [url]: { statusCode: 404, body: 'not found' } })
    await expect(testCase.build(fetcher).listPostings(testCase.boardToken)).rejects.toSatisfy(
      (err: unknown) => isSourceError(err) && err.reasonCode === 'source_unavailable',
    )
  })

  /**
   * The failure that does not announce itself. A body cut at the byte ceiling is
   * still valid UTF-8 and parses as far as it goes, so without the explicit flag a
   * partial feed becomes a `SyntaxError` far from its cause — or worse, a board
   * that silently lost half its postings.
   */
  it('refuses a truncated body rather than parsing a prefix', async () => {
    const { url } = build()
    const full = readFixture(testCase.fixture)
    const fetcher = new StubFetcher({
      [url]: { body: full.slice(0, Math.floor(full.length / 2)), truncated: true },
    })
    await expect(testCase.build(fetcher).listPostings(testCase.boardToken)).rejects.toSatisfy(
      (err: unknown) => isSourceError(err) && err.reasonCode === 'source_unavailable',
    )
  })

  it('reports unparseable JSON as source_unavailable', async () => {
    const { url } = build()
    const fetcher = new StubFetcher({ [url]: { body: '{ not json' } })
    await expect(testCase.build(fetcher).listPostings(testCase.boardToken)).rejects.toSatisfy(
      (err: unknown) => isSourceError(err) && err.reasonCode === 'source_unavailable',
    )
  })

  it('skips a malformed posting rather than losing the whole board', async () => {
    const { url } = build()
    const raw = JSON.parse(readFixture(testCase.fixture)) as unknown
    const jobs = Array.isArray(raw) ? raw : (raw as { jobs: unknown[] }).jobs
    const damaged = [{ nonsense: true }, ...jobs]
    const body = JSON.stringify(Array.isArray(raw) ? damaged : { ...(raw as object), jobs: damaged })

    const fetcher = new StubFetcher({ [url]: { body } })
    const postings = await testCase.build(fetcher).listPostings(testCase.boardToken)
    expect(postings.length).toBe(jobs.length - countUnlisted(testCase.vendor, jobs))
  })
})

/** Ashby publishes unlisted reqs in the same array; those are not public roles. */
function countUnlisted(vendor: string, jobs: unknown[]): number {
  if (vendor !== 'ashby') return 0
  return jobs.filter((j) => (j as { isListed?: boolean }).isListed === false).length
}

/**
 * The transport half. This one goes through the real `FetchPolicyGate` request
 * path, so it proves the adapter works against the socket layer the running system
 * uses — not only against a stub that agrees with it.
 */
describe('adapters over the real gate transport', () => {
  it('reads a Greenhouse board through FetchPolicyGate and MockAgent', async () => {
    const { FetchPolicyGate } = await import('../../src/core/policy/fetch-policy-gate.js')
    const { seedHostPolicies } = await import('../../src/core/policy/host-policy.js')
    const { testDb, truncateAll } = await import('../helpers/db.js')

    await truncateAll()
    await seedHostPolicies(testDb())

    const meta = readFixtureMeta('greenhouse-jobs')
    const boardPath = new URL(meta.url).pathname

    mockAgent
      .get('https://boards-api.greenhouse.io')
      .intercept({ path: '/robots.txt', method: 'GET' })
      .reply(200, 'User-agent: *\nAllow: /\n')
      .persist()
    mockAgent
      .get('https://boards-api.greenhouse.io')
      .intercept({ path: `${boardPath}?content=true`, method: 'GET' })
      .reply(200, readFixture('greenhouse-jobs'))
      .persist()

    const gate = new FetchPolicyGate(testDb(), {
      userAgent: 'outreach-intelligence-research/0.1 (+https://example.invalid/about)',
      robotsTtlSeconds: 86_400,
      defaultRateDelayMs: 0,
    })

    const postings = await new GreenhouseProvider(gate).listPostings(
      'razorpaysoftwareprivatelimited',
    )
    expect(postings.length).toBeGreaterThan(0)
  })
})
