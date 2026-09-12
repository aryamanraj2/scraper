import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeTestDb, testDb, truncateAll } from '../helpers/db.js'
import { COMPANY_SCORING_SELECT, type CompanyForScoring } from '../../src/intel/scoring/collect.js'
import { ensureScoreVersion, scoreCompanyAndPersist } from '../../src/intel/scoring/run.js'
import { reconstructTotal } from '../../src/intel/scoring/score.js'
import { SCORE_VERSION_V1 } from '../../src/intel/scoring/score-version.js'
import { computeJobCountDelta, latestJobCountDelta } from '../../src/intel/signals/job-count-delta.js'
import { seedRoleTracks } from '../../src/intel/taxonomy/seed-tracks.js'

const NOW = new Date('2026-09-09T12:00:00Z')

beforeEach(async () => truncateAll())
afterAll(async () => closeTestDb())

async function makeCompany(overrides: Record<string, unknown> = {}): Promise<CompanyForScoring> {
  return testDb().company.create({
    data: {
      canonicalDomain: `c${Math.random().toString(36).slice(2, 10)}.example`,
      displayName: 'Test Co',
      countries: ['India'],
      locations: ['Bengaluru, India'],
      tags: [],
      ycOneLiner: 'We ship SwiftUI on iOS with on-device Core ML inference.',
      ycLongDescription: 'Our mobile team writes Swift and Kotlin. Internship programme runs twice a year.',
      ycIsHiring: true,
      ycStatus: 'Active',
      teamSize: 25,
      ...overrides,
    },
    select: COMPANY_SCORING_SELECT,
  })
}

async function addEvidence(
  companyId: string,
  sourceType: 'ats' | 'company_page' | 'yc',
  excerpt: string,
  observedAt = NOW,
): Promise<string> {
  const row = await testDb().evidence.create({
    data: {
      companyId,
      sourceUrl: `https://example.invalid/${Math.random().toString(36).slice(2)}`,
      sourceType,
      excerpt,
      contentHash: Math.random().toString(36).slice(2),
      observedAt,
      confidence: 0.9,
      fetchedVia: sourceType === 'ats' ? 'structured_feed' : 'static_fetch',
    },
    select: { id: true },
  })
  return row.id
}

async function addBoardCount(companyId: string, count: number, observedAt: Date): Promise<void> {
  const evidenceId = await addEvidence(companyId, 'ats', JSON.stringify({ openPostings: count }), observedAt)
  await testDb().companySignal.create({
    data: {
      companyId,
      evidenceId,
      signalType: 'job_posting',
      observedAt,
      confidence: 0.95,
      numericValue: count,
    },
  })
}

describe('ScoreVersion rows (A1, A11)', () => {
  it('stores a weight set that sums to 100 and keeps exactly one active', async () => {
    const id = await ensureScoreVersion(testDb())
    const row = await testDb().scoreVersion.findUniqueOrThrow({ where: { id } })
    expect(Object.values(row.weights as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(100)
    expect(row.isActive).toBe(true)
    expect(row.frozenUntilSends).toBe(100)
  })

  it('is idempotent, and never rewrites a stored version', async () => {
    const first = await ensureScoreVersion(testDb())
    const second = await ensureScoreVersion(testDb())
    expect(second).toBe(first)
    expect(await testDb().scoreVersion.count()).toBe(1)
  })
})

describe('scoring a company end to end', () => {
  it('writes a Lead whose score replays from score_components alone', async () => {
    const company = await makeCompany()
    await addEvidence(company.id, 'ats', '{"title":"iOS Engineer Intern"}')
    await addEvidence(company.id, 'company_page', 'We are a distributed team hiring Swift engineers.')

    const outcome = await scoreCompanyAndPersist(testDb(), company, { now: NOW })
    expect(outcome.scored).toBe(true)

    const lead = await testDb().lead.findFirstOrThrow({ where: { companyId: company.id } })
    const stored = lead.scoreComponents as unknown as Parameters<typeof reconstructTotal>[0]
    const replayed = reconstructTotal(stored, SCORE_VERSION_V1)

    expect(replayed.total).toBe(lead.score)
    expect(replayed.riskDeduction).toBe(lead.riskDeduction)
    expect(lead.scoreVersionId).not.toBeNull()
  })

  it('records the matched snippets, not just the numbers (F3 needs the reasons)', async () => {
    const company = await makeCompany()
    const outcome = await scoreCompanyAndPersist(testDb(), company, { now: NOW })
    expect(outcome.scored).toBe(true)
    const lead = await testDb().lead.findFirstOrThrow({ where: { companyId: company.id } })
    const stored = lead.scoreComponents as unknown as {
      tracks: { track: string; snippets: { term: string; snippet: string }[] }[]
      components: { reason: string }[]
    }
    expect(stored.tracks[0]!.snippets.length).toBeGreaterThan(0)
    expect(stored.components.every((c) => c.reason.length > 0)).toBe(true)
  })

  it('rescoring the same cycle updates the lead rather than creating a second one', async () => {
    const company = await makeCompany()
    await scoreCompanyAndPersist(testDb(), company, { now: NOW })
    await scoreCompanyAndPersist(testDb(), company, { now: NOW })
    expect(await testDb().lead.count({ where: { companyId: company.id } })).toBe(1)
  })

  it('refuses with insufficient_evidence when no track is supported by text', async () => {
    const company = await makeCompany({
      ycOneLiner: 'We sell artisanal candles.',
      ycLongDescription: null,
      tags: [],
    })
    const outcome = await scoreCompanyAndPersist(testDb(), company, { now: NOW })
    expect(outcome).toMatchObject({ scored: false, reason: 'insufficient_evidence' })

    const row = await testDb().company.findUniqueOrThrow({ where: { id: company.id } })
    expect(row.status).toBe('insufficient_evidence')
    expect(row.statusReason).toBe('insufficient_evidence')
    expect(await testDb().lead.count()).toBe(0)
  })

  it('marks a lead with no open posting as speculative (A3)', async () => {
    const company = await makeCompany()
    await scoreCompanyAndPersist(testDb(), company, { now: NOW })
    const lead = await testDb().lead.findFirstOrThrow({ where: { companyId: company.id } })
    expect(lead.leadKind).toBe('speculative')
    expect(lead.opportunityId).toBeNull()
  })

  it('marks a lead with an open posting as posted_role and attaches it', async () => {
    const company = await makeCompany()
    const opportunity = await testDb().opportunity.create({
      data: {
        companyId: company.id,
        kind: 'published_role',
        status: 'open',
        title: 'iOS Engineer Intern',
        roleUrl: 'https://boards.example/jobs/1',
        externalId: 'job-1',
        lastSeenAt: NOW,
      },
      select: { id: true },
    })
    await scoreCompanyAndPersist(testDb(), company, { now: NOW })
    const lead = await testDb().lead.findFirstOrThrow({ where: { companyId: company.id } })
    expect(lead.leadKind).toBe('posted_role')
    expect(lead.opportunityId).toBe(opportunity.id)
  })

  it('leaves Opportunity.roleUrl untouched, which F3 applies through', async () => {
    const company = await makeCompany()
    const url = 'https://job-boards.greenhouse.io/acme/jobs/4242'
    await testDb().opportunity.create({
      data: {
        companyId: company.id, kind: 'published_role', status: 'open', title: 'Android Engineer',
        roleUrl: url, externalId: 'job-2', lastSeenAt: NOW,
      },
    })
    await scoreCompanyAndPersist(testDb(), company, { now: NOW })
    const after = await testDb().opportunity.findFirstOrThrow({ where: { companyId: company.id } })
    expect(after.roleUrl).toBe(url)
  })

  it('writes an audit row per reason code the score raised', async () => {
    const company = await makeCompany({ ycLongDescription: null })
    await scoreCompanyAndPersist(testDb(), company, { now: NOW })
    const reasons = await testDb().auditLog.findMany({
      where: { action: 'score.reason' },
      select: { reasonCode: true },
    })
    // Seed-index-only support plus fewer than two employer sources: both weak_evidence.
    expect(reasons.map((r) => r.reasonCode)).toContain('weak_evidence')
  })
})

describe('ATS job-count delta (B2)', () => {
  it('is null until a second observation exists, and never treated as zero', async () => {
    const company = await makeCompany()
    await addBoardCount(company.id, 12, new Date('2026-09-01T00:00:00Z'))

    expect(await computeJobCountDelta(testDb(), company.id)).toEqual({
      computed: false,
      reason: 'insufficient_observations',
    })
    expect(await latestJobCountDelta(testDb(), company.id)).toBeNull()
  })

  it('computes the week-over-week change from two stored observations, with no refetch', async () => {
    const company = await makeCompany()
    await addBoardCount(company.id, 12, new Date('2026-09-01T00:00:00Z'))
    await addBoardCount(company.id, 17, new Date('2026-09-08T00:00:00Z'))

    const outcome = await computeJobCountDelta(testDb(), company.id)
    expect(outcome).toMatchObject({ computed: true, delta: 5 })
    expect(await latestJobCountDelta(testDb(), company.id)).toBe(5)
  })

  it('records a falling count as a negative delta', async () => {
    const company = await makeCompany()
    await addBoardCount(company.id, 20, new Date('2026-09-01T00:00:00Z'))
    await addBoardCount(company.id, 14, new Date('2026-09-08T00:00:00Z'))
    expect(await computeJobCountDelta(testDb(), company.id)).toMatchObject({ delta: -6 })
  })

  it('cites the newer observation and records both in the audit trail', async () => {
    const company = await makeCompany()
    await addBoardCount(company.id, 3, new Date('2026-09-01T00:00:00Z'))
    await addBoardCount(company.id, 4, new Date('2026-09-08T00:00:00Z'))
    const outcome = await computeJobCountDelta(testDb(), company.id)
    if (!outcome.computed) throw new Error('expected a delta')

    const signal = await testDb().companySignal.findFirstOrThrow({
      where: { companyId: company.id, signalType: 'ats_job_count_delta' },
    })
    expect(signal.evidenceId).toBe(outcome.latest.evidenceId)

    const audit = await testDb().auditLog.findFirstOrThrow({ where: { action: 'signal.job_count_delta' } })
    const metadata = audit.metadata as { latest: { count: number }; previous: { count: number } }
    expect(metadata.latest.count).toBe(4)
    expect(metadata.previous.count).toBe(3)
  })

  it('does not write a second delta row for the same observation', async () => {
    const company = await makeCompany()
    await addBoardCount(company.id, 3, new Date('2026-09-01T00:00:00Z'))
    await addBoardCount(company.id, 9, new Date('2026-09-08T00:00:00Z'))
    await computeJobCountDelta(testDb(), company.id)
    expect(await computeJobCountDelta(testDb(), company.id)).toEqual({
      computed: false,
      reason: 'already_recorded',
    })
    expect(
      await testDb().companySignal.count({ where: { companyId: company.id, signalType: 'ats_job_count_delta' } }),
    ).toBe(1)
  })

  it('feeds the scorer: a rising count scores above a falling one', async () => {
    const rising = await makeCompany()
    await addBoardCount(rising.id, 5, new Date('2026-09-01T00:00:00Z'))
    await addBoardCount(rising.id, 15, new Date('2026-09-08T00:00:00Z'))
    await computeJobCountDelta(testDb(), rising.id)

    const falling = await makeCompany()
    await addBoardCount(falling.id, 15, new Date('2026-09-01T00:00:00Z'))
    await addBoardCount(falling.id, 5, new Date('2026-09-08T00:00:00Z'))
    await computeJobCountDelta(testDb(), falling.id)

    const a = await scoreCompanyAndPersist(testDb(), rising, { now: NOW })
    const b = await scoreCompanyAndPersist(testDb(), falling, { now: NOW })
    if (!a.scored || !b.scored) throw new Error('expected both to score')
    const hiring = (o: typeof a) => o.breakdown.components.find((c) => c.key === 'hiring_signal')!.points
    expect(hiring(a)).toBeGreaterThan(hiring(b))
  })
})

/**
 * F5b: `Opportunity.description` reaches the matcher as its own weighted field.
 *
 * The rule under test is `matchOnePosting`'s: the TITLE nominates which track a
 * posting carries, the body corroborates. F3 picks a resume off
 * `Opportunity.roleTrackId`, so a body that could take the primary slot would be
 * `ORCHESTRATOR-HANDOVER.md` §2's "16 packets handing an iOS resume to generalist
 * roles", with the arrow pointing the other way.
 */
describe('posting bodies (F5b)', () => {
  // `truncateAll` clears RoleTrack, and `roleTrackIdsByKey` is what turns a matched
  // track into the FK F3 reads. Without the rows the assignment is silently null.
  beforeEach(async () => { await seedRoleTracks(testDb()) })

  // Shaped like a real one: a company overview about the employer's stack, then a
  // short section about the role itself.
  const BACKEND_BOILERPLATE = `
    COMPANY OVERVIEW. We run distributed systems on Kubernetes and Docker across
    AWS and GCP. Postgres, Kafka, Redis, gRPC and a REST API in Java, built as
    microservices with an eye on scalability.
  `

  async function trackKeyOf(title: string, description: string | null): Promise<string | null> {
    const company = await makeCompany({ ycOneLiner: null, ycLongDescription: null })
    await testDb().opportunity.create({
      data: {
        companyId: company.id, kind: 'published_role', status: 'open', title, description,
        roleUrl: 'https://boards.example/jobs/9', externalId: `job-${Math.random()}`, lastSeenAt: NOW,
      },
    })
    await scoreCompanyAndPersist(testDb(), company, { now: NOW })
    const row = await testDb().opportunity.findFirstOrThrow({
      where: { companyId: company.id },
      select: { roleTrack: { select: { key: true } } },
    })
    return row.roleTrack?.key ?? null
  }

  it('keeps the track the title names when the body is about the employer', async () => {
    expect(await trackKeyOf('Senior iOS Engineer', null)).toBe('ios_android')
    expect(
      await trackKeyOf('Senior iOS Engineer', `${BACKEND_BOILERPLATE}\nYou will own our iOS app in Swift.`),
    ).toBe('ios_android')
  })

  it('labels a posting whose title says nothing, from its body alone', async () => {
    expect(await trackKeyOf('Software Engineer II', null)).toBeNull()
    expect(await trackKeyOf('Software Engineer II', BACKEND_BOILERPLATE)).toBe('sde')
  })

  it('counts a body-matched posting towards the primary track\'s open roles', async () => {
    const company = await makeCompany()
    await testDb().opportunity.create({
      data: {
        companyId: company.id, kind: 'published_role', status: 'open', title: 'Engineer, Growth',
        description: 'You will ship our Android app in Kotlin with Jetpack Compose.',
        roleUrl: 'https://boards.example/jobs/11', externalId: 'job-body-1', lastSeenAt: NOW,
      },
    })
    const outcome = await scoreCompanyAndPersist(testDb(), company, { now: NOW })
    if (!outcome.scored) throw new Error('expected a score')
    expect(outcome.breakdown.primaryTrack).toBe('ios_android')
    const hiring = outcome.breakdown.components.find((c) => c.key === 'hiring_signal')!
    expect(hiring.reason).toMatch(/1 open role\(s\) matching the primary track/)
  })
})
