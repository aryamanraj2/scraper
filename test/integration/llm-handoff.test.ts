import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeTestDb, testDb, truncateAll } from '../helpers/db.js'
import {
  HandoffLlmGateway,
  LlmDisabledError,
  LlmTaskPendingError,
  NullLlmGateway,
  claimNextTask,
  fulfilTask,
  rejectTask,
} from '../../src/core/llm/handoff-gateway.js'
import { LLM_TASK_KINDS, collectCitedEvidenceIds } from '../../src/core/llm/tasks.js'
import { queueResearchBrief, RESEARCH_BRIEF_PROMPT_VERSION } from '../../src/intel/brief/queue-brief.js'
import { scoreCompanyAndPersist } from '../../src/intel/scoring/run.js'
import { COMPANY_SCORING_SELECT } from '../../src/intel/scoring/collect.js'
import { registerSecretValue, clearRegisteredSecrets } from '../../src/core/logging/redact.js'
import { z } from 'zod'

const NOW = new Date('2026-09-09T12:00:00Z')

beforeEach(async () => {
  await truncateAll()
  clearRegisteredSecrets()
})
afterAll(async () => closeTestDb())

async function seedQualifiedLead(): Promise<{ leadId: string; companyId: string; evidenceIds: string[] }> {
  const company = await testDb().company.create({
    data: {
      canonicalDomain: 'acme.example',
      displayName: 'Acme',
      countries: ['India'],
      locations: ['Bengaluru, India'],
      tags: [],
      teamSize: 30,
      ycIsHiring: true,
      ycStatus: 'Active',
      atsBoardToken: 'acme',
      atsSlug: 'greenhouse',
      careersUrl: 'https://acme.example/careers',
      ycOneLiner: 'We ship SwiftUI on iOS with on-device Core ML inference.',
      ycLongDescription: 'Our mobile team writes Swift and Kotlin; the internship programme runs twice a year.',
    },
    select: COMPANY_SCORING_SELECT,
  })
  await testDb().opportunity.create({
    data: {
      companyId: company.id, kind: 'published_role', status: 'open', title: 'iOS Engineer Intern',
      roleUrl: 'https://job-boards.greenhouse.io/acme/jobs/1', externalId: 'j1', lastSeenAt: NOW,
    },
  })
  const evidenceIds: string[] = []
  for (const [type, excerpt] of [
    ['ats', '{"title":"iOS Engineer Intern","location":"Bengaluru"}'],
    ['company_page', 'We are a distributed team writing Swift and SwiftUI, hiring interns each spring.'],
  ] as const) {
    const row = await testDb().evidence.create({
      data: {
        companyId: company.id, sourceUrl: `https://acme.example/${type}`, sourceType: type,
        excerpt, contentHash: Math.random().toString(36).slice(2), observedAt: NOW, confidence: 0.9,
        fetchedVia: type === 'ats' ? 'structured_feed' : 'static_fetch',
      },
      select: { id: true },
    })
    evidenceIds.push(row.id)
  }
  const outcome = await scoreCompanyAndPersist(testDb(), company, { now: NOW })
  if (!outcome.scored) throw new Error('fixture company failed to score')
  await testDb().lead.update({ where: { id: outcome.leadId }, data: { status: 'qualified' } })
  return { leadId: outcome.leadId, companyId: company.id, evidenceIds }
}

function validBrief(evidenceIds: string[]): unknown {
  return {
    facts: [
      { fact: 'Acme runs an internship programme twice a year.', citations: [{ evidenceId: evidenceIds[1]!, claim: 'internship programme' }] },
      { fact: 'Acme is hiring an iOS Engineer Intern in Bengaluru.', citations: [{ evidenceId: evidenceIds[0]!, claim: 'open role' }] },
    ],
    relevanceNote: 'Mobile-first company with an open intern role in the priority market.',
    suggestedTrack: 'ios_android',
  }
}

describe('H10: the pipeline works with the LLM off', () => {
  it('NullLlmGateway reports disabled and throws a typed error the caller can handle', async () => {
    const gateway = new NullLlmGateway()
    expect(gateway.enabled).toBe(false)
    await expect(
      gateway.complete({ promptVersion: RESEARCH_BRIEF_PROMPT_VERSION, schema: z.unknown(), input: {}, maxTokens: 10 }),
    ).rejects.toBeInstanceOf(LlmDisabledError)
  })

  it('scores and qualifies a lead without any LLM task existing', async () => {
    const { leadId } = await seedQualifiedLead()
    expect(await testDb().llmTask.count()).toBe(0)
    const lead = await testDb().lead.findUniqueOrThrow({ where: { id: leadId } })
    expect(lead.score).toBeGreaterThan(0)
  })
})

describe('the app never calls a model: it writes a row and moves on', () => {
  it('queues a research brief for a qualified lead with the evidence quoted inline', async () => {
    const { leadId, evidenceIds } = await seedQualifiedLead()
    const outcome = await queueResearchBrief(testDb(), leadId)
    expect(outcome).toMatchObject({ queued: true, created: true })

    const task = await testDb().llmTask.findFirstOrThrow()
    expect(task.kind).toBe(LLM_TASK_KINDS.researchBrief)
    expect(task.status).toBe('pending')
    expect(task.allowedEvidenceIds.sort()).toEqual([...evidenceIds].sort())

    const input = task.input as { evidence: { evidenceId: string; excerpt: string }[] }
    expect(input.evidence.length).toBe(evidenceIds.length)
    // The excerpts travel with the task: the session has no reason, and no way, to fetch.
    expect(input.evidence.every((e) => e.excerpt.length > 0)).toBe(true)
    expect(JSON.stringify(task.input)).not.toContain('http://')
  })

  it('is idempotent, so a weekly refresh does not pile up identical asks', async () => {
    const { leadId } = await seedQualifiedLead()
    const first = await queueResearchBrief(testDb(), leadId)
    const second = await queueResearchBrief(testDb(), leadId)
    expect(second).toMatchObject({ queued: true, created: false })
    if (!first.queued || !second.queued) throw new Error('expected both to queue')
    expect(second.taskId).toBe(first.taskId)
    expect(await testDb().llmTask.count()).toBe(1)
  })

  it('does not queue a brief for a lead that did not qualify', async () => {
    const company = await testDb().company.create({
      data: {
        canonicalDomain: 'weak.example', displayName: 'Weak', countries: [], locations: [], tags: [],
        ycOneLiner: 'We build backend services in golang.',
      },
      select: COMPANY_SCORING_SELECT,
    })
    const outcome = await scoreCompanyAndPersist(testDb(), company, { now: NOW })
    if (!outcome.scored) throw new Error('expected a score')
    expect(await queueResearchBrief(testDb(), outcome.leadId)).toMatchObject({ queued: false })
    expect(await testDb().llmTask.count()).toBe(0)
  })

  it('complete() queues and then refuses to invent a value', async () => {
    const gateway = new HandoffLlmGateway(testDb())
    expect(gateway.enabled).toBe(true)
    await expect(
      gateway.complete({ promptVersion: RESEARCH_BRIEF_PROMPT_VERSION, schema: z.unknown(), input: {}, maxTokens: 10 }),
    ).rejects.toBeInstanceOf(LlmTaskPendingError)
    expect(await testDb().llmTask.count()).toBe(1)
  })
})

describe('validation lives in the CLI, because the session is what is being validated', () => {
  it('accepts a well-formed, fully-cited response', async () => {
    const { leadId, evidenceIds } = await seedQualifiedLead()
    await queueResearchBrief(testDb(), leadId)
    const task = await testDb().llmTask.findFirstOrThrow()

    expect(await fulfilTask(testDb(), task.id, validBrief(evidenceIds))).toMatchObject({ ok: true })

    const after = await testDb().llmTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(after.status).toBe('fulfilled')
    expect(after.fulfilledBy).toBe('claude-code-session')
    expect(Number(after.costUsd)).toBe(0)
  })

  it('rejects a citation outside allowedEvidenceIds (handover.md §11’s golden test)', async () => {
    const { leadId, evidenceIds } = await seedQualifiedLead()
    await queueResearchBrief(testDb(), leadId)
    const task = await testDb().llmTask.findFirstOrThrow()

    const forged = validBrief(evidenceIds) as { facts: { citations: { evidenceId: string }[] }[] }
    forged.facts[0]!.citations[0]!.evidenceId = '01a00000-0000-7000-8000-000000000000'

    const result = await fulfilTask(testDb(), task.id, forged)
    expect(result).toMatchObject({ ok: false, problem: 'uncited_evidence' })
    expect((await testDb().llmTask.findUniqueOrThrow({ where: { id: task.id } })).status).not.toBe('fulfilled')
  })

  it('rejects output that does not match the stored schema', async () => {
    const { leadId } = await seedQualifiedLead()
    await queueResearchBrief(testDb(), leadId)
    const task = await testDb().llmTask.findFirstOrThrow()

    // One fact: the schema requires two to four, per handover.md §4's ResearchBrief.
    const result = await fulfilTask(testDb(), task.id, {
      facts: [{ fact: 'Acme exists.', citations: [{ evidenceId: task.allowedEvidenceIds[0]!, claim: 'x' }] }],
      relevanceNote: 'thin',
      suggestedTrack: null,
    })
    expect(result).toMatchObject({ ok: false, problem: 'schema_mismatch' })
  })

  it('refuses output carrying a registered secret', async () => {
    const { leadId, evidenceIds } = await seedQualifiedLead()
    await queueResearchBrief(testDb(), leadId)
    const task = await testDb().llmTask.findFirstOrThrow()

    registerSecretValue('super-secret-refresh-token')
    const leaky = validBrief(evidenceIds) as { relevanceNote: string }
    leaky.relevanceNote = 'Their careers page mentioned super-secret-refresh-token in a script tag.'

    expect(await fulfilTask(testDb(), task.id, leaky)).toMatchObject({ ok: false, problem: 'redaction' })
    expect((await testDb().llmTask.findFirstOrThrow()).output).toBeNull()
  })

  it('refuses a task whose schema is no longer registered, rather than storing it unvalidated', async () => {
    const { leadId } = await seedQualifiedLead()
    await queueResearchBrief(testDb(), leadId)
    const task = await testDb().llmTask.findFirstOrThrow()
    await testDb().llmTask.update({ where: { id: task.id }, data: { promptVersion: 'research_brief@99' } })

    expect(await fulfilTask(testDb(), task.id, { anything: true })).toMatchObject({ ok: false, problem: 'no_schema' })
  })

  it('counts attempts, so a session that keeps failing is visible', async () => {
    const { leadId } = await seedQualifiedLead()
    await queueResearchBrief(testDb(), leadId)
    const task = await testDb().llmTask.findFirstOrThrow()
    await fulfilTask(testDb(), task.id, { nope: true })
    await fulfilTask(testDb(), task.id, { nope: true })
    expect((await testDb().llmTask.findUniqueOrThrow({ where: { id: task.id } })).attempts).toBe(2)
  })
})

describe('claiming and rejecting', () => {
  it('claims a pending task exactly once', async () => {
    const { leadId } = await seedQualifiedLead()
    await queueResearchBrief(testDb(), leadId)
    const first = await claimNextTask(testDb())
    const second = await claimNextTask(testDb())
    expect(first).not.toBeNull()
    expect(second).toBeNull()
  })

  it('rejects with a closed reason code and records it', async () => {
    const { leadId } = await seedQualifiedLead()
    await queueResearchBrief(testDb(), leadId)
    const task = await testDb().llmTask.findFirstOrThrow()

    expect(await rejectTask(testDb(), task.id, 'weak_evidence', 'excerpts do not support two facts')).toEqual({ ok: true })
    const after = await testDb().llmTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(after.status).toBe('rejected')
    expect(after.statusReason).toBe('weak_evidence')

    const audit = await testDb().auditLog.findFirstOrThrow({ where: { action: 'llm.task_rejected' } })
    expect(audit.reasonCode).toBe('weak_evidence')
  })
})

describe('citation collection walks the whole response', () => {
  it('finds evidence ids at any depth and under either spelling', () => {
    const found = collectCitedEvidenceIds({
      a: { b: [{ evidenceId: 'one' }, { nested: { evidence_id: 'two' } }] },
      citedEvidenceIds: ['three'],
    })
    expect([...found].sort()).toEqual(['one', 'three', 'two'])
  })
})
