import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { seedHostPolicies } from '../../src/core/policy/host-policy.js'
import { GreenhouseProvider } from '../../src/ingest/ats/greenhouse.js'
import { ingestPostings, postingContentHash } from '../../src/ingest/ats/ingest-postings.js'
import { detectAtsForCompany, saveDetection } from '../../src/ingest/ats/detect.js'
import { StubFetcher, readFixture } from '../helpers/fixtures.js'
import { closeTestDb, testDb, truncateAll } from '../helpers/db.js'

const BOARD_TOKEN = 'razorpaysoftwareprivatelimited'
const BOARD_URL = `https://boards-api.greenhouse.io/v1/boards/${BOARD_TOKEN}/jobs?content=true`

beforeEach(async () => {
  await truncateAll()
  await seedHostPolicies(testDb())
})
afterAll(async () => closeTestDb())

async function makeCompany(overrides: Record<string, unknown> = {}) {
  return testDb().company.create({
    data: {
      canonicalDomain: 'razorpay.com',
      displayName: 'Razorpay',
      website: 'https://razorpay.com',
      countries: ['India'],
      locations: ['Bengaluru, Karnataka, India'],
      tags: [],
      status: 'normalized',
      ...overrides,
    },
  })
}

function boardFetcher(body = readFixture('greenhouse-jobs')) {
  return new StubFetcher({ [BOARD_URL]: { body } })
}

describe('ATS posting ingest', () => {
  it('attaches live postings as Opportunity rows with ATS evidence', async () => {
    const company = await makeCompany()
    const fetcher = boardFetcher()
    const result = await ingestPostings(testDb(), new GreenhouseProvider(fetcher), {
      id: company.id,
      atsBoardToken: BOARD_TOKEN,
    })

    expect(result.sourceFailure).toBeUndefined()
    expect(result.created).toBe(result.fetched)

    const opportunities = await testDb().opportunity.findMany({ where: { companyId: company.id } })
    expect(opportunities.length).toBe(result.fetched)
    for (const opportunity of opportunities) {
      expect(opportunity.kind).toBe('published_role')
      expect(opportunity.status).toBe('open')
      expect(opportunity.externalId).not.toBeNull()
      expect(opportunity.roleUrl).toMatch(/^https:\/\//)
      expect(opportunity.lastSeenAt).toBeInstanceOf(Date)
    }
  })

  /** F1 exit criterion, Opportunity half: every populated field cites Evidence. */
  it('cites every attached posting with a verbatim excerpt and a source URL', async () => {
    const company = await makeCompany()
    await ingestPostings(testDb(), new GreenhouseProvider(boardFetcher()), {
      id: company.id,
      atsBoardToken: BOARD_TOKEN,
    })

    const opportunities = await testDb().opportunity.findMany({ where: { companyId: company.id } })
    const evidence = await testDb().evidence.findMany({
      where: { companyId: company.id, sourceType: 'ats' },
    })

    for (const opportunity of opportunities) {
      const citing = evidence.filter((e) => e.sourceUrl === opportunity.roleUrl)
      expect(citing.length, `no Evidence for ${opportunity.title}`).toBeGreaterThan(0)
      const row = citing[0]!
      expect(row.excerpt).toContain(JSON.stringify(opportunity.title))
      expect(row.excerpt.length).toBeLessThanOrEqual(500)
      expect(row.contentHash).not.toBe('')
      expect(row.fetchedVia).toBe('structured_feed')
    }
  })

  /**
   * §8.2.4: "Re-ingesting an unchanged posting should hit `content_unchanged` via
   * `contentHash` rather than churn rows." Without this a weekly refresh rewrites
   * the whole corpus every run and buries the real changes.
   */
  it('records content_unchanged on re-ingest and writes no new Evidence', async () => {
    const company = await makeCompany()
    const first = await ingestPostings(testDb(), new GreenhouseProvider(boardFetcher()), {
      id: company.id,
      atsBoardToken: BOARD_TOKEN,
    })
    const evidenceAfterFirst = await testDb().evidence.count({ where: { companyId: company.id } })

    const second = await ingestPostings(testDb(), new GreenhouseProvider(boardFetcher()), {
      id: company.id,
      atsBoardToken: BOARD_TOKEN,
    })

    expect(second.unchanged).toBe(first.created)
    expect(second.created).toBe(0)

    // One new Evidence row only: the per-refresh job-count observation.
    const evidenceAfterSecond = await testDb().evidence.count({ where: { companyId: company.id } })
    expect(evidenceAfterSecond).toBe(evidenceAfterFirst + 1)

    const audit = await testDb().auditLog.findMany({ where: { reasonCode: 'content_unchanged' } })
    expect(audit.length).toBe(first.created)
  })

  it('writes a fresh Evidence row when a posting actually changes', async () => {
    const company = await makeCompany()
    await ingestPostings(testDb(), new GreenhouseProvider(boardFetcher()), {
      id: company.id,
      atsBoardToken: BOARD_TOKEN,
    })

    const raw = JSON.parse(readFixture('greenhouse-jobs')) as { jobs: Record<string, unknown>[] }
    raw.jobs[0]!['title'] = 'Retitled Role'
    const changed = await ingestPostings(
      testDb(),
      new GreenhouseProvider(boardFetcher(JSON.stringify(raw))),
      { id: company.id, atsBoardToken: BOARD_TOKEN },
    )

    expect(changed.unchanged).toBe(changed.fetched - 1)
    expect(changed.updated).toBe(1)
    expect(changed.created).toBe(0)
    const renamed = await testDb().opportunity.findFirst({ where: { title: 'Retitled Role' } })
    expect(renamed).not.toBeNull()
  })

  /**
   * The hash must not track fields that move without the facts moving. Greenhouse's
   * `updated_at` changes on any edit, so including it would report every cosmetic
   * touch as a changed role.
   */
  it('ignores a moved timestamp when deciding whether content changed', () => {
    const base = {
      externalId: '1',
      title: 'Backend Engineer',
      url: 'https://job-boards.greenhouse.io/acme/jobs/1',
      location: 'Bengaluru',
      content: 'Build things.',
    }
    expect(postingContentHash({ ...base, postedAt: new Date('2026-01-01') })).toBe(
      postingContentHash({ ...base, postedAt: new Date('2026-09-01') }),
    )
    expect(postingContentHash({ ...base, postedAt: null })).not.toBe(
      postingContentHash({ ...base, title: 'Frontend Engineer', postedAt: null }),
    )
  })

  it('records `duplicate` when one feed repeats an externalId', async () => {
    const company = await makeCompany()
    const raw = JSON.parse(readFixture('greenhouse-jobs')) as { jobs: Record<string, unknown>[] }
    raw.jobs.push({ ...raw.jobs[0]! })

    const result = await ingestPostings(
      testDb(),
      new GreenhouseProvider(boardFetcher(JSON.stringify(raw))),
      { id: company.id, atsBoardToken: BOARD_TOKEN },
    )

    expect(result.duplicates).toBe(1)
    const audit = await testDb().auditLog.findMany({
      where: { reasonCode: 'duplicate', action: 'ats.posting_skipped' },
    })
    expect(audit).toHaveLength(1)
  })

  it('records `source_unavailable` and writes nothing when the board fails', async () => {
    const company = await makeCompany()
    const fetcher = new StubFetcher({ [BOARD_URL]: { statusCode: 500, body: 'boom' } })
    const result = await ingestPostings(testDb(), new GreenhouseProvider(fetcher), {
      id: company.id,
      atsBoardToken: BOARD_TOKEN,
    })

    expect(result.sourceFailure?.reason).toBe('source_unavailable')
    expect(await testDb().opportunity.count()).toBe(0)
    const audit = await testDb().auditLog.findMany({ where: { action: 'ats.board_failed' } })
    expect(audit[0]?.reasonCode).toBe('source_unavailable')
  })

  /**
   * B2's substitute for the excluded X API: week-over-week ATS job-count deltas.
   * F2 computes the delta, but only if F1 stored a count per refresh — which is
   * what the F1 handover §9 asks F1 to get right so F2 needs no refetch.
   */
  it('stores an open-posting count per refresh, so F2 can compute a delta without refetching', async () => {
    const company = await makeCompany()
    const first = await ingestPostings(testDb(), new GreenhouseProvider(boardFetcher()), {
      id: company.id,
      atsBoardToken: BOARD_TOKEN,
    })

    const raw = JSON.parse(readFixture('greenhouse-jobs')) as { jobs: Record<string, unknown>[] }
    raw.jobs = raw.jobs.slice(0, 3)
    await ingestPostings(testDb(), new GreenhouseProvider(boardFetcher(JSON.stringify(raw))), {
      id: company.id,
      atsBoardToken: BOARD_TOKEN,
    })

    const signals = await testDb().companySignal.findMany({
      where: { companyId: company.id, signalType: 'job_posting' },
      orderBy: { createdAt: 'asc' },
    })
    expect(signals).toHaveLength(2)
    expect(signals[0]?.numericValue).toBe(first.fetched)
    expect(signals[1]?.numericValue).toBe(3)
    // The delta F2 will record as `ats_job_count_delta` is computable from these
    // two rows alone.
    expect(signals[1]!.numericValue! - signals[0]!.numericValue!).toBe(3 - first.fetched)
  })
})

describe('ATS detection over the network path', () => {
  it('resolves a board from a stored careers URL without issuing a request', async () => {
    const company = await makeCompany({
      careersUrl: 'https://job-boards.greenhouse.io/acmecorp',
    })
    const fetcher = new StubFetcher({})
    const outcome = await detectAtsForCompany(testDb(), fetcher, company)

    expect(outcome).toMatchObject({ found: true, fetches: 0 })
    expect(fetcher.requested).toEqual([])
  })

  /**
   * Lever's missing discovery endpoint (B6) in practice: the slug exists nowhere
   * but the company's own page, so detection has to read one.
   */
  it('resolves a Lever slug by reading the company homepage', async () => {
    const company = await makeCompany({ canonicalDomain: 'acme.example', website: null })
    const fetcher = new StubFetcher({
      'https://acme.example': {
        body: '<a href="https://jobs.lever.co/acmeco/1234">Open roles</a>',
      },
    })

    const outcome = await detectAtsForCompany(testDb(), fetcher, {
      ...company,
      careersUrl: null,
      website: null,
    })

    expect(outcome).toMatchObject({ found: true })
    if (!outcome.found) throw new Error('unreachable')
    expect(outcome.detection).toMatchObject({ vendor: 'lever', boardToken: 'acmeco' })

    await saveDetection(testDb(), company.id, outcome.detection, outcome.sourceUrl)
    const saved = await testDb().company.findUnique({ where: { id: company.id } })
    expect(saved).toMatchObject({ atsSlug: 'lever', atsBoardToken: 'acmeco' })

    // The token is a stored fact, so it needs provenance like any other.
    const evidence = await testDb().evidence.findFirst({
      where: { companyId: company.id, sourceType: 'company_page' },
    })
    expect(evidence?.excerpt).toContain('jobs.lever.co/acmeco')
  })

  it('tries a short list of careers paths, then stops', async () => {
    const company = await makeCompany({ canonicalDomain: 'quiet.example', website: null })
    const fetcher = new StubFetcher({
      'https://quiet.example': { body: '<html>nothing here</html>' },
      'https://quiet.example/careers': { body: '<html>still nothing</html>' },
    })

    const outcome = await detectAtsForCompany(
      testDb(),
      fetcher,
      { ...company, careersUrl: null, website: null },
      { maxPages: 3 },
    )

    expect(outcome).toMatchObject({ found: false, reason: 'source_unavailable' })
    expect(fetcher.requested).toHaveLength(3)
  })

  /**
   * §8.2.3: "Detection failure is `source_unavailable`, not an exception." A
   * refusal about the host applies to every path on it, so trying more paths would
   * only produce the same refusal more times.
   */
  it('stops on a preflight refusal instead of probing more paths', async () => {
    const company = await makeCompany({ canonicalDomain: 'blocked.example', website: null })
    const fetcher = new StubFetcher(
      {},
      { 'https://blocked.example': 'robots_disallowed' },
    )

    const outcome = await detectAtsForCompany(testDb(), fetcher, {
      ...company,
      careersUrl: null,
      website: null,
    })

    expect(outcome).toMatchObject({ found: false, reason: 'source_unavailable' })
    expect(fetcher.requested).toEqual(['https://blocked.example'])
    const audit = await testDb().auditLog.findMany({ where: { action: 'ats.detection_failed' } })
    expect(audit[0]?.reasonCode).toBe('source_unavailable')
  })
})
