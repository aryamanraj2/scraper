import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeTestDb, testDb, truncateAll } from '../helpers/db.js'
import { SignalGraphService, type CompanyForSignalGraph } from '../../src/intel/signal-graph.js'
import { RESEARCH_ACTIONS } from '../../src/intel/research/actions.js'
import { writeAudit } from '../../src/core/audit/audit-log.js'
import { currentPeriodMonth } from '../../src/core/policy/budget.js'

const NOW = new Date('2026-09-09T12:00:00Z')

beforeEach(async () => truncateAll())
afterAll(async () => closeTestDb())

async function makeCompany(overrides: Record<string, unknown> = {}): Promise<CompanyForSignalGraph> {
  return testDb().company.create({
    data: {
      canonicalDomain: `c${Math.random().toString(36).slice(2, 10)}.example`,
      displayName: 'Test Co',
      countries: [],
      locations: [],
      tags: [],
      ...overrides,
    },
    select: { id: true, canonicalDomain: true, careersUrl: true, atsSlug: true, atsBoardToken: true },
  })
}

async function addBoardRead(companyId: string, observedAt: Date): Promise<void> {
  const evidence = await testDb().evidence.create({
    data: {
      companyId,
      sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs',
      sourceType: 'ats',
      excerpt: '{"openPostings":4}',
      contentHash: Math.random().toString(36).slice(2),
      observedAt,
      confidence: 0.95,
      fetchedVia: 'structured_feed',
    },
    select: { id: true },
  })
  await testDb().companySignal.create({
    data: {
      companyId,
      evidenceId: evidence.id,
      signalType: 'job_posting',
      observedAt,
      confidence: 0.95,
      numericValue: 4,
    },
  })
}

const graph = (opts = {}) => new SignalGraphService(testDb(), { now: NOW, ...opts })

/**
 * D4: "the ordering is a HARD FLOOR, not a heuristic: a browser task can never be
 * chosen while an unread ATS feed exists. Cost and expected value are inputs
 * WITHIN a tier, never a way around the ordering."
 *
 * This file is the proving test for the F2 exit criterion "source precedence is a
 * hard floor — a cheaper unread source is always chosen first".
 */
describe('source precedence is a hard floor (D4)', () => {
  it('chooses an unread ATS board over page research, even when a page has never been fetched', async () => {
    const company = await makeCompany({
      atsSlug: 'greenhouse',
      atsBoardToken: 'acme',
      careersUrl: 'https://acme.example/careers',
    })
    const action = await graph().nextAction(company)
    expect(action).toMatchObject({ kind: 'read_ats_board', tier: 1, boardToken: 'acme' })
  })

  it('chooses ATS detection over page research when no board token exists', async () => {
    const company = await makeCompany({ careersUrl: 'https://acme.example/careers' })
    const action = await graph().nextAction(company)
    expect(action).toMatchObject({ kind: 'detect_ats', tier: 1 })
  })

  it('keeps returning detection while no board token exists and none has been tried', async () => {
    const company = await makeCompany()
    expect(await graph().nextAction(company)).toMatchObject({ kind: 'detect_ats', tier: 1 })
  })

  /**
   * "Unread" and "absent" are different. A company whose detection was attempted
   * and found nothing has no feed to read, so tier 1 is exhausted rather than
   * permanently pending — otherwise the 107 of 150 companies with no board link
   * would never receive the page research that is their only remaining source.
   */
  it('falls through to tier 2 once detection has been attempted and failed', async () => {
    const company = await makeCompany({ careersUrl: 'https://acme.example/careers' })
    await writeAudit(testDb(), {
      actorType: 'system', actorId: 'ats-detect', action: 'ats.detection_failed',
      subjectType: 'Company', subjectId: company.id, reasonCode: 'source_unavailable',
    })
    expect(await graph().nextAction(company)).toMatchObject({ kind: 'static_fetch', tier: 2 })
  })

  it('re-attempts detection once the failure is old enough to be worth retrying', async () => {
    const company = await makeCompany()
    await writeAudit(testDb(), {
      actorType: 'system', actorId: 'ats-detect', action: 'ats.detection_failed',
      subjectType: 'Company', subjectId: company.id, reasonCode: 'source_unavailable',
    })
    // The failure above is "now"; a graph whose clock is 60 days later sees it as stale.
    const later = new SignalGraphService(testDb(), { now: new Date('2026-11-15T00:00:00Z') })
    expect(await later.nextAction(company)).toMatchObject({ kind: 'detect_ats', tier: 1 })
  })

  it('only reaches tier 2 once the tier-1 feed is current', async () => {
    const company = await makeCompany({ atsSlug: 'greenhouse', atsBoardToken: 'acme' })
    await addBoardRead(company.id, new Date('2026-09-08T00:00:00Z'))
    const action = await graph().nextAction(company)
    expect(action).toMatchObject({ kind: 'static_fetch', tier: 2 })
  })

  it('treats a board read older than the refresh window as unread again', async () => {
    const company = await makeCompany({ atsSlug: 'ashby', atsBoardToken: 'acme' })
    await addBoardRead(company.id, new Date('2026-08-01T00:00:00Z'))
    expect(await graph().nextAction(company)).toMatchObject({ kind: 'read_ats_board', tier: 1 })
  })

  it('only reaches tier 3 for a page tier 2 could not read, and never otherwise', async () => {
    const company = await makeCompany({ atsSlug: 'lever', atsBoardToken: 'acme' })
    await addBoardRead(company.id, NOW)

    await writeAudit(testDb(), {
      actorType: 'system', actorId: 'researcher', action: RESEARCH_ACTIONS.pageFetched,
      subjectType: 'Company', subjectId: company.id,
    })
    expect(await graph({ firecrawlEnabled: true }).nextAction(company)).toMatchObject({ kind: 'none' })

    await testDb().auditLog.deleteMany({ where: { action: RESEARCH_ACTIONS.pageFetched } })
    await writeAudit(testDb(), {
      actorType: 'system', actorId: 'researcher', action: RESEARCH_ACTIONS.pageUnusable,
      subjectType: 'Company', subjectId: company.id,
    })
    expect(await graph({ firecrawlEnabled: true }).nextAction(company)).toMatchObject({
      kind: 'firecrawl_escalate',
      tier: 3,
    })
  })

  it('never returns a browser task: D4 defers that layer to F7', async () => {
    const company = await makeCompany({ atsSlug: 'lever', atsBoardToken: 'acme' })
    await addBoardRead(company.id, NOW)
    await writeAudit(testDb(), {
      actorType: 'system', actorId: 'researcher', action: RESEARCH_ACTIONS.pageUnusable,
      subjectType: 'Company', subjectId: company.id,
    })
    await writeAudit(testDb(), {
      actorType: 'system', actorId: 'researcher', action: RESEARCH_ACTIONS.escalated,
      subjectType: 'Company', subjectId: company.id,
    })
    const action = await graph({ firecrawlEnabled: true }).nextAction(company)
    expect(action.kind).not.toBe('browser_task')
    expect(action).toMatchObject({ kind: 'none' })
  })

  it('leaves Firecrawl unreachable while the flag is off, even for an unusable page', async () => {
    const company = await makeCompany({ atsSlug: 'lever', atsBoardToken: 'acme' })
    await addBoardRead(company.id, NOW)
    await writeAudit(testDb(), {
      actorType: 'system', actorId: 'researcher', action: RESEARCH_ACTIONS.pageUnusable,
      subjectType: 'Company', subjectId: company.id,
    })
    expect(await graph().nextAction(company)).toMatchObject({ kind: 'none' })
  })
})

describe('refusals are recorded, not retried around (D4, F2 exit criterion)', () => {
  it('does not re-issue a fetch against a host that refused inside the window', async () => {
    const company = await makeCompany({ atsSlug: 'greenhouse', atsBoardToken: 'acme' })
    await addBoardRead(company.id, NOW)
    await writeAudit(testDb(), {
      actorType: 'system', actorId: 'researcher', action: RESEARCH_ACTIONS.pageRefused,
      subjectType: 'Company', subjectId: company.id, reasonCode: 'robots_disallowed',
    })
    const action = await graph().nextAction(company)
    expect(action.kind).toBe('none')
    expect(action.reason).toMatch(/robots_disallowed/)
  })
})

describe('budget is a precondition, not a tier (Part G)', () => {
  it('no-ops with budget_exhausted when the company envelope is spent', async () => {
    const company = await makeCompany({ atsSlug: 'greenhouse', atsBoardToken: 'acme' })
    await testDb().researchBudget.create({
      data: {
        companyId: company.id,
        periodMonth: currentPeriodMonth(NOW),
        creditsCap: 0,
        billedUsdCap: 0,
      },
    })
    expect(await graph().nextAction(company)).toMatchObject({
      kind: 'none',
      reasonCode: 'budget_exhausted',
    })
  })

  it('no-ops with budget_exhausted when the global envelope is spent', async () => {
    const company = await makeCompany({ atsSlug: 'greenhouse', atsBoardToken: 'acme' })
    await testDb().researchBudget.create({
      data: { companyId: null, periodMonth: currentPeriodMonth(NOW), creditsCap: 0, billedUsdCap: 0 },
    })
    const action = await graph().nextAction(company)
    expect(action).toMatchObject({ kind: 'none', reasonCode: 'budget_exhausted' })
    expect(action.reason).toMatch(/global/)
  })
})
