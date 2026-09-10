import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeTestDb, testDb, truncateAll } from '../helpers/db.js'
import { seedApprovedClaims } from '../../src/apply/claims/seed-claims.js'
import { generateApplicationPackets } from '../../src/apply/packet/generate.js'
import { queuePacketAnswers } from '../../src/apply/packet/queue-answers.js'
import { applyPacketAnswers } from '../../src/apply/packet/apply-answers.js'
import { acceptPacket } from '../../src/apply/packet/lifecycle.js'
import { PrefilledAnswers } from '../../src/apply/packet/answers.js'
import { fulfilTask } from '../../src/core/llm/handoff-gateway.js'
import { persistResearchBrief } from '../../src/apply/brief/persist-brief.js'
import { queueResearchBrief } from '../../src/intel/brief/queue-brief.js'

beforeEach(async () => truncateAll())
afterAll(async () => closeTestDb())

async function world() {
  const db = testDb()
  await seedApprovedClaims(db)
  const resume = await db.resumeVersion.create({
    data: {
      label: 'SDE — backend / systems',
      trackKey: 'sde',
      linkUrl: 'file:///r.pdf',
      filePath: '/r.pdf',
      fileSha256: 'a'.repeat(64),
    },
    select: { id: true },
  })
  const track = await db.roleTrack.create({
    data: {
      key: 'sde',
      displayName: 'SDE',
      positiveKeywords: ['backend'],
      negativeKeywords: [],
      defaultResumeVersionId: resume.id,
    },
    select: { id: true },
  })
  const company = await db.company.create({
    data: { canonicalDomain: 'acme.example', displayName: 'Acme', countries: ['India'], locations: [], tags: [] },
    select: { id: true },
  })
  const evidence = await db.evidence.create({
    data: {
      companyId: company.id,
      sourceUrl: 'https://acme.example/careers',
      sourceType: 'company_page',
      excerpt: 'Our platform team writes Go and runs Postgres at scale in Bengaluru.',
      contentHash: 'h1',
      observedAt: new Date('2026-09-01T00:00:00Z'),
      confidence: 0.8,
      fetchedVia: 'static_fetch',
    },
    select: { id: true },
  })
  const opportunity = await db.opportunity.create({
    data: {
      companyId: company.id,
      roleTrackId: track.id,
      kind: 'published_role',
      status: 'open',
      title: 'Backend Engineering Intern',
      roleUrl: 'https://job-boards.greenhouse.io/acme/jobs/1',
      lastSeenAt: new Date(),
      externalId: '1',
    },
    select: { id: true },
  })
  const lead = await db.lead.create({
    data: {
      companyId: company.id,
      opportunityId: opportunity.id,
      leadKind: 'posted_role',
      status: 'qualified',
      primaryTrack: 'sde',
      primaryTrackReason: 'fixture',
      campaignCycle: '2026-09',
      score: 84,
      citedEvidenceIds: [evidence.id],
    },
    select: { id: true },
  })
  await generateApplicationPackets(db)
  const packet = await db.applicationPacket.findFirstOrThrow()
  return { db, company, lead, packet, evidence }
}

describe('packet answers through the handoff gateway', () => {
  it('queues a task carrying both allow-sets and nothing to fetch', async () => {
    const { db, packet } = await world()
    const result = await queuePacketAnswers(db, packet.id)
    expect(result.queued).toBe(true)

    const task = await db.llmTask.findFirstOrThrow({ where: { kind: 'packet_answers' } })
    expect(task.subjectType).toBe('ApplicationPacket')
    expect(task.subjectId).toBe(packet.id)
    expect(task.allowedEvidenceIds.length).toBeGreaterThan(0)
    expect(task.allowedApprovedClaimIds.length).toBeGreaterThan(0)

    // The payload quotes evidence; it does not tell the session to go and get any.
    const input = task.input as { evidence: { excerpt: string }[]; approvedClaims: unknown[] }
    expect(input.evidence[0]!.excerpt).toContain('platform team writes Go')
    expect(input.approvedClaims.length).toBeGreaterThan(0)
    expect(JSON.stringify(input)).not.toMatch(/\bfetch\b|\bvisit\b|\bbrowse\b/i)
  })

  it('is idempotent, so a refresh does not pile up identical asks', async () => {
    const { db, packet } = await world()
    const first = await queuePacketAnswers(db, packet.id)
    const second = await queuePacketAnswers(db, packet.id)
    expect(first.queued && second.queued).toBe(true)
    if (!first.queued || !second.queued) throw new Error('unreachable')
    expect(second.taskId).toBe(first.taskId)
    expect(second.created).toBe(false)
    expect(await db.llmTask.count({ where: { kind: 'packet_answers' } })).toBe(1)
  })

  it('refuses output citing an ApprovedClaim outside the allow-set', async () => {
    // handover.md §11's golden test, pointed at the candidate rather than the
    // employer: an unsupported claim about the applicant is a schema error, not
    // something a reviewer is expected to catch.
    const { db, packet, evidence } = await world()
    await queuePacketAnswers(db, packet.id)
    const task = await db.llmTask.findFirstOrThrow({ where: { kind: 'packet_answers' } })

    const forged = await db.approvedClaim.create({
      data: { key: 'forged.claim', text: 'I hold a PhD in distributed systems.', category: 'education' },
      select: { id: true },
    })

    const result = await fulfilTask(db, task.id, {
      answers: [
        {
          questionKey: 'why_company',
          answer: 'I hold a PhD and your platform team writes Go.',
          approvedClaimIds: [forged.id],
          citedEvidenceIds: [evidence.id],
        },
      ],
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.problem).toBe('uncited_claim')
    expect(result.detail).toContain(forged.id)

    // Nothing was stored.
    const after = await db.llmTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(after.output).toBeNull()
    expect(after.status).not.toBe('fulfilled')
  })

  it('still refuses output citing Evidence outside the allow-set', async () => {
    const { db, packet } = await world()
    await queuePacketAnswers(db, packet.id)
    const task = await db.llmTask.findFirstOrThrow({ where: { kind: 'packet_answers' } })
    const claimId = task.allowedApprovedClaimIds[0]!

    const result = await fulfilTask(db, task.id, {
      answers: [
        {
          questionKey: 'why_company',
          answer: 'Something about the company.',
          approvedClaimIds: [claimId],
          citedEvidenceIds: ['00000000-0000-0000-0000-000000000000'],
        },
      ],
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.problem).toBe('uncited_evidence')
  })

  it('merges an accepted answer into the packet and clears it from unanswered', async () => {
    const { db, packet, evidence } = await world()
    await queuePacketAnswers(db, packet.id)
    const task = await db.llmTask.findFirstOrThrow({ where: { kind: 'packet_answers' } })
    const claimId = task.allowedApprovedClaimIds[0]!

    const before = PrefilledAnswers.parse(
      (await db.applicationPacket.findUniqueOrThrow({ where: { id: packet.id } })).prefilledAnswers,
    )
    expect(before.unanswered.map((u) => u.questionKey)).toContain('why_company')

    const fulfilled = await fulfilTask(db, task.id, {
      answers: [
        {
          questionKey: 'why_company',
          answer: 'Your platform team writes Go, which is where my backend work sits.',
          approvedClaimIds: [claimId],
          citedEvidenceIds: [evidence.id],
        },
      ],
    })
    expect(fulfilled.ok).toBe(true)

    const applied = await applyPacketAnswers(db, task.id)
    expect(applied.ok).toBe(true)
    if (!applied.ok) throw new Error('unreachable')
    expect(applied.merged).toBe(1)

    const after = PrefilledAnswers.parse(
      (await db.applicationPacket.findUniqueOrThrow({ where: { id: packet.id } })).prefilledAnswers,
    )
    expect(after.unanswered.map((u) => u.questionKey)).not.toContain('why_company')
    const merged = after.answers.find((a) => a.questionKey === 'why_company')!
    expect(merged.source).toBe('llm')
    expect(merged.approvedClaimIds).toEqual([claimId])
    expect(after.promptVersion).toBe('packet_answers@1')

    // The evidence the answer leans on is now on the packet row too.
    const row = await db.applicationPacket.findUniqueOrThrow({ where: { id: packet.id } })
    expect(row.citedEvidenceIds).toContain(evidence.id)
  })

  it('refuses to merge into a packet the operator already approved', async () => {
    const { db, packet, evidence } = await world()
    await queuePacketAnswers(db, packet.id)
    const task = await db.llmTask.findFirstOrThrow({ where: { kind: 'packet_answers' } })
    const claimId = task.allowedApprovedClaimIds[0]!
    await fulfilTask(db, task.id, {
      answers: [
        {
          questionKey: 'why_company',
          answer: 'Late arrival.',
          approvedClaimIds: [claimId],
          citedEvidenceIds: [evidence.id],
        },
      ],
    })
    await acceptPacket(db, packet.id)

    const applied = await applyPacketAnswers(db, task.id)
    expect(applied.ok).toBe(false)
    if (applied.ok) throw new Error('unreachable')
    expect(applied.problem).toBe('accepted')
  })

  it('produces a complete, usable packet with the LLM backlog untouched (H10)', async () => {
    const { db, packet } = await world()
    // No task queued, nothing fulfilled — and the packet still stands.
    expect(await db.llmTask.count()).toBe(0)
    const answers = PrefilledAnswers.parse(
      (await db.applicationPacket.findUniqueOrThrow({ where: { id: packet.id } })).prefilledAnswers,
    )
    expect(answers.answers.length).toBeGreaterThanOrEqual(6)
    expect(packet.officialUrl).toBeTruthy()
    // The judgment questions are listed as unanswered with a reason, not missing.
    for (const key of ['why_company', 'relevant_experience']) {
      const entry = answers.unanswered.find((u) => u.questionKey === key)
      expect(entry, key).toBeDefined()
      expect(entry!.reason).toBeTruthy()
    }
  })
})

describe('ResearchBrief persistence (the F2 output nothing consumed)', () => {
  it('writes a fulfilled brief and copies its citations verbatim', async () => {
    const { db, lead, company, evidence } = await world()
    const queued = await queueResearchBrief(db, lead.id)
    expect(queued.queued).toBe(true)

    const task = await db.llmTask.findFirstOrThrow({ where: { kind: 'research_brief' } })
    await fulfilTask(db, task.id, {
      facts: [
        { fact: 'Acme runs Postgres at scale.', citations: [{ evidenceId: evidence.id, claim: 'runs Postgres' }] },
        { fact: 'Acme has a platform team in Bengaluru.', citations: [{ evidenceId: evidence.id, claim: 'Bengaluru' }] },
      ],
      relevanceNote: 'Backend track fit, India-based team.',
      suggestedTrack: 'sde',
    })

    const persisted = await persistResearchBrief(db, task.id)
    expect(persisted.ok).toBe(true)
    if (!persisted.ok) throw new Error('unreachable')
    expect(persisted.facts).toBe(2)

    const brief = await db.researchBrief.findFirstOrThrow()
    expect(brief.companyId).toBe(company.id)
    expect(brief.promptVersion).toBe('research_brief@1')
    expect(brief.relevanceNote).toBe('Backend track fit, India-based team.')
    // Copied straight from the validated output, not re-derived.
    expect(brief.citedEvidenceIds).toEqual([evidence.id])
  })

  it('refreshes rather than stacking a second brief for the same prompt version', async () => {
    const { db, lead, evidence } = await world()
    await queueResearchBrief(db, lead.id)
    const task = await db.llmTask.findFirstOrThrow({ where: { kind: 'research_brief' } })
    const output = {
      facts: [
        { fact: 'One.', citations: [{ evidenceId: evidence.id, claim: 'a' }] },
        { fact: 'Two.', citations: [{ evidenceId: evidence.id, claim: 'b' }] },
      ],
      relevanceNote: 'note',
      suggestedTrack: null,
    }
    await fulfilTask(db, task.id, output)
    const first = await persistResearchBrief(db, task.id)
    const second = await persistResearchBrief(db, task.id)
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) throw new Error('unreachable')
    expect(second.created).toBe(false)
    expect(await db.researchBrief.count()).toBe(1)
  })

  it('refuses a task that was never fulfilled', async () => {
    const { db, lead } = await world()
    await queueResearchBrief(db, lead.id)
    const task = await db.llmTask.findFirstOrThrow({ where: { kind: 'research_brief' } })
    const result = await persistResearchBrief(db, task.id)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.problem).toBe('not_fulfilled')
    expect(await db.researchBrief.count()).toBe(0)
  })
})
