import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeTestDb, testDb, truncateAll } from '../helpers/db.js'
import { seedApprovedClaims } from '../../src/apply/claims/seed-claims.js'
import { generateApplicationPackets } from '../../src/apply/packet/generate.js'
import { acceptPacket, markPacketSubmitted } from '../../src/apply/packet/lifecycle.js'
import { validateAnswers, buildDeterministicAnswers, loadActiveClaims } from '../../src/apply/packet/answers.js'
import { PrefilledAnswers } from '../../src/apply/packet/answers.js'
import { EVIDENCE_VIEW_KEYS, projectEvidence } from '../../src/apply/viewer/projection.js'
import { FETCHED_VIA } from '../../src/core/evidence/write-evidence.js'
import { loadPacketRow } from '../../src/apply/viewer/queues.js'

/**
 * F3's exit criteria, as policy tests: each one is a red-team attempt that must fail
 * closed, per Part G's test layers.
 */

beforeEach(async () => truncateAll())
afterAll(async () => closeTestDb())

const ROLE_URL = 'https://job-boards.greenhouse.io/acme/jobs/4242'

async function seedPacketWorld(opts: { postings?: number; track?: string } = {}) {
  const db = testDb()
  await seedApprovedClaims(db)
  const resume = await db.resumeVersion.create({
    data: {
      label: 'SDE — backend / systems',
      trackKey: 'sde',
      linkUrl: 'file:///resumes/backend.pdf',
      filePath: '/resumes/backend.pdf',
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
    data: {
      canonicalDomain: 'acme.example',
      displayName: 'Acme',
      countries: ['India'],
      locations: [],
      tags: [],
    },
    select: { id: true },
  })
  const count = opts.postings ?? 1
  const opportunities = []
  for (let i = 0; i < count; i += 1) {
    opportunities.push(
      await db.opportunity.create({
        data: {
          companyId: company.id,
          roleTrackId: track.id,
          kind: 'published_role',
          status: 'open',
          title: `Backend Engineer ${i}`,
          roleUrl: `${ROLE_URL}${i === 0 ? '' : `-${i}`}`,
          lastSeenAt: new Date(),
          externalId: String(i),
        },
        select: { id: true },
      }),
    )
  }
  const lead = await db.lead.create({
    data: {
      companyId: company.id,
      opportunityId: opportunities[0]!.id,
      leadKind: 'posted_role',
      status: 'qualified',
      primaryTrack: 'sde',
      primaryTrackReason: 'fixture',
      campaignCycle: '2026-09',
      score: 84,
    },
    select: { id: true },
  })
  return { db, company, lead, resume, track, opportunities }
}

// ---------------------------------------------------------------------------

describe('prefilled answers come only from ApprovedClaim', () => {
  it('refuses an answer that cites no approved claim', async () => {
    const db = testDb()
    await seedApprovedClaims(db)
    const result = await validateAnswers(db, {
      answers: [
        {
          questionKey: 'why_company',
          question: 'Why do you want to work at Acme?',
          answer: 'I have five years of Rust experience and a PhD.',
          approvedClaimIds: [],
          citedEvidenceIds: [],
          source: 'llm',
        },
      ],
      unanswered: [],
      generatedAt: new Date().toISOString(),
      promptVersion: null,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    // A schema error, not a review finding. That is the whole mechanism.
    expect(result.problem).toBe('uncited_claim')
  })

  it('refuses an answer citing a claim id that does not exist', async () => {
    const db = testDb()
    await seedApprovedClaims(db)
    const result = await validateAnswers(db, {
      answers: [
        {
          questionKey: 'full_name',
          question: 'Full name',
          answer: 'Someone',
          approvedClaimIds: ['00000000-0000-0000-0000-000000000000'],
          citedEvidenceIds: [],
          source: 'operator',
        },
      ],
      unanswered: [],
      generatedAt: new Date().toISOString(),
      promptVersion: null,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.problem).toBe('unknown_claim')
  })

  it('refuses an answer citing a claim the operator has since withdrawn', async () => {
    // The CLI checked the allow-set when the task was fulfilled. This checks TIME:
    // a claim withdrawn after that must not walk into a packet.
    const db = testDb()
    await seedApprovedClaims(db)
    const claim = await db.approvedClaim.findFirstOrThrow({ where: { key: 'skill.backend' } })
    await db.approvedClaim.update({ where: { id: claim.id }, data: { isActive: false } })

    const result = await validateAnswers(db, {
      answers: [
        {
          questionKey: 'relevant_experience',
          question: 'What is relevant?',
          answer: 'Backend work.',
          approvedClaimIds: [claim.id],
          citedEvidenceIds: [],
          source: 'llm',
        },
      ],
      unanswered: [],
      generatedAt: new Date().toISOString(),
      promptVersion: null,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.problem).toBe('unknown_claim')
  })

  it('refuses an answer to a question that is not in the registry', async () => {
    const db = testDb()
    await seedApprovedClaims(db)
    const claim = await db.approvedClaim.findFirstOrThrow({ where: { key: 'identity.full_name' } })
    const result = await validateAnswers(db, {
      answers: [
        {
          questionKey: 'salary_expectation',
          question: 'What salary do you expect?',
          answer: 'Negotiable.',
          approvedClaimIds: [claim.id],
          citedEvidenceIds: [],
          source: 'operator',
        },
      ],
      unanswered: [],
      generatedAt: new Date().toISOString(),
      promptVersion: null,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.problem).toBe('unknown_question')
  })

  it('leaves a question blank when its claim is missing, rather than guessing', async () => {
    // The mechanism, tested by withdrawing a claim rather than by relying on one
    // being permanently absent — the operator has since supplied both facts that were
    // missing in the first F3 run, and a test that depended on that gap would have
    // silently stopped testing anything.
    const db = testDb()
    await seedApprovedClaims(db)
    const claim = await db.approvedClaim.findFirstOrThrow({
      where: { key: 'education.expected_graduation' },
    })
    await db.approvedClaim.update({ where: { id: claim.id }, data: { isActive: false } })

    const built = buildDeterministicAnswers(await loadActiveClaims(db), 'Acme')
    const blank = built.unanswered.find((u) => u.questionKey === 'expected_graduation')
    expect(blank, 'a question whose claim was withdrawn must go blank').toBeDefined()
    // The reason is stated, so the operator knows it was left rather than missed.
    expect(blank!.reason).toBeTruthy()
    expect(built.answers.some((a) => a.questionKey === 'expected_graduation')).toBe(false)
  })

  it('leaves a multi-claim question blank when only SOME of its claims are present', async () => {
    // A partial answer to "will you require sponsorship" is worse than a blank one,
    // because the operator would not know it was partial.
    const db = testDb()
    await seedApprovedClaims(db)
    const claim = await db.approvedClaim.findFirstOrThrow({
      where: { key: 'eligibility.sponsorship_required_abroad' },
    })
    await db.approvedClaim.update({ where: { id: claim.id }, data: { isActive: false } })

    const built = buildDeterministicAnswers(await loadActiveClaims(db), 'Acme')
    expect(built.unanswered.map((u) => u.questionKey)).toContain('work_authorization')
    expect(built.answers.some((a) => a.questionKey === 'work_authorization')).toBe(false)
  })

  it('answers every deterministic question once the operator has supplied every claim', async () => {
    const db = testDb()
    await seedApprovedClaims(db)
    const built = buildDeterministicAnswers(await loadActiveClaims(db), 'Acme')
    expect(built.unanswered).toHaveLength(0)
    for (const answer of built.answers) {
      expect(answer.approvedClaimIds.length).toBeGreaterThan(0)
    }
  })

  it('builds every answer as the verbatim text of the claims it cites', async () => {
    // Nothing is reworded, so "traces to an ApprovedClaim" is checkable by
    // containment rather than by a human reading for smuggled facts.
    const db = testDb()
    await seedApprovedClaims(db)
    const claims = await loadActiveClaims(db)
    const byId = new Map([...claims.values()].map((c) => [c.id, c.text]))
    const built = buildDeterministicAnswers(claims, 'Acme')
    for (const answer of built.answers) {
      for (const id of answer.approvedClaimIds) {
        expect(answer.answer).toContain(byId.get(id)!)
      }
      const rebuilt = answer.approvedClaimIds.map((id) => byId.get(id)!).join(' ')
      expect(answer.answer).toBe(rebuilt)
    }
  })
})

// ---------------------------------------------------------------------------

describe('every packet is reconstructible from its provenance', () => {
  it('traces every cited id to a live ApprovedClaim or Evidence row', async () => {
    const { db } = await seedPacketWorld()
    const outcome = await generateApplicationPackets(db)
    expect(outcome.packets.length).toBe(1)

    const packet = await db.applicationPacket.findFirstOrThrow()
    const answers = PrefilledAnswers.parse(packet.prefilledAnswers)
    expect(answers.answers.length).toBeGreaterThan(0)

    for (const answer of answers.answers) {
      expect(answer.approvedClaimIds.length).toBeGreaterThan(0)
      const claims = await db.approvedClaim.findMany({
        where: { id: { in: answer.approvedClaimIds }, isActive: true },
      })
      expect(claims.length).toBe(answer.approvedClaimIds.length)
      for (const claim of claims) {
        // Candidate provenance: every claim names the document it came from.
        expect(claim.sourceRef).toBeTruthy()
      }
      const evidence = await db.evidence.findMany({ where: { id: { in: answer.citedEvidenceIds } } })
      expect(evidence.length).toBe(answer.citedEvidenceIds.length)
    }

    // The row-level arrays agree with what the answers actually cite.
    const fromAnswers = [...new Set(answers.answers.flatMap((a) => a.approvedClaimIds))].sort()
    expect([...packet.approvedClaimIds].sort()).toEqual(fromAnswers)
  })

  it('records the resume and its file hash, so a packet names the exact document', async () => {
    const { db } = await seedPacketWorld()
    await generateApplicationPackets(db)
    const row = await loadPacketRow(db, (await db.applicationPacket.findFirstOrThrow()).id)
    expect(row).not.toBeNull()
    expect(row!.resumeLabel).toBe('SDE — backend / systems')
    expect(row!.resumeSha256).toBe('a'.repeat(64))
    expect(row!.packetHash).toMatch(/^[0-9a-f]{64}$/)
  })
})

// ---------------------------------------------------------------------------

describe('Opportunity.roleUrl is the official application URL', () => {
  it('copies the employer-published URL onto the packet unchanged', async () => {
    const { db } = await seedPacketWorld()
    await generateApplicationPackets(db)
    const packet = await db.applicationPacket.findFirstOrThrow()
    const opportunity = await db.opportunity.findFirstOrThrow()
    expect(packet.officialUrl).toBe(opportunity.roleUrl)
    expect(packet.officialUrl).toBe(ROLE_URL)
  })

  it('never generates a packet for a posting with no application URL', async () => {
    const { db, opportunities } = await seedPacketWorld()
    await db.opportunity.update({ where: { id: opportunities[0]!.id }, data: { roleUrl: null } })
    const outcome = await generateApplicationPackets(db)
    expect(outcome.packets).toHaveLength(0)
    expect(await db.applicationPacket.count()).toBe(0)
  })
})

// ---------------------------------------------------------------------------

describe('the per-company cap', () => {
  it('caps packets per company and records what it withheld', async () => {
    const { db } = await seedPacketWorld({ postings: 7 })
    const outcome = await generateApplicationPackets(db, { cap: 3 })
    expect(outcome.packets).toHaveLength(3)
    expect(outcome.cappedOut).toBe(4)

    // Withheld, not discarded: the audit row says which postings and why.
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'packet.capped' } })
    expect((audit.metadata as { withheld: number }).withheld).toBe(4)
  })

  it('is idempotent — regenerating updates rather than forking a second packet', async () => {
    const { db } = await seedPacketWorld({ postings: 3 })
    await generateApplicationPackets(db, { cap: 3 })
    const first = await db.applicationPacket.findMany({ select: { id: true }, orderBy: { id: 'asc' } })
    await generateApplicationPackets(db, { cap: 3 })
    const second = await db.applicationPacket.findMany({ select: { id: true }, orderBy: { id: 'asc' } })
    expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id))
  })
})

// ---------------------------------------------------------------------------

describe('an accepted packet is immutable', () => {
  it('is not rewritten by a later regeneration', async () => {
    const { db } = await seedPacketWorld()
    await generateApplicationPackets(db)
    const packet = await db.applicationPacket.findFirstOrThrow()
    await acceptPacket(db, packet.id)
    const accepted = await db.applicationPacket.findUniqueOrThrow({ where: { id: packet.id } })

    const again = await generateApplicationPackets(db)
    expect(again.packets).toHaveLength(0)
    expect(again.skipped[0]?.reason).toContain('immutable')

    const after = await db.applicationPacket.findUniqueOrThrow({ where: { id: packet.id } })
    expect(after.packetHash).toBe(accepted.packetHash)
    expect(after.acceptedAt?.toISOString()).toBe(accepted.acceptedAt?.toISOString())
  })

  it('refuses to record a submission for a packet nobody approved', async () => {
    const { db } = await seedPacketWorld()
    await generateApplicationPackets(db)
    const packet = await db.applicationPacket.findFirstOrThrow()
    const result = await markPacketSubmitted(db, packet.id)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.problem).toBe('not_accepted')
    expect(await db.applicationPacket.count({ where: { status: 'submitted' } })).toBe(0)
  })
})

// ---------------------------------------------------------------------------

describe('browser- and API-derived facts display identically (handover.md §16)', () => {
  const tiers = Object.values(FETCHED_VIA)

  it('projects the identical key set, in the identical order, for every tier', async () => {
    const db = testDb()
    const company = await db.company.create({
      data: { canonicalDomain: 'viewer.example', displayName: 'Viewer Co', countries: [], locations: [], tags: [] },
      select: { id: true },
    })
    const projections = []
    for (const via of tiers) {
      const row = await db.evidence.create({
        data: {
          companyId: company.id,
          sourceUrl: `https://viewer.example/${via}`,
          sourceType: 'company_page',
          excerpt: `We are hiring engineers. Observed via ${via}.`,
          contentHash: `hash-${via}`,
          observedAt: new Date('2026-09-01T00:00:00Z'),
          confidence: 0.7,
          fetchedVia: via,
        },
      })
      projections.push(projectEvidence(row))
    }

    const keySets = projections.map((p) => Object.keys(p))
    for (const keys of keySets) {
      expect(keys).toEqual([...EVIDENCE_VIEW_KEYS])
    }

    // No field is populated for one tier and blank for another.
    for (const p of projections) {
      expect(p.sourceUrl).toBeTruthy()
      expect(p.sourceType).toBeTruthy()
      expect(p.excerpt).toBeTruthy()
      expect(p.fetchedViaLabel).toBeTruthy()
      expect(p.observedAt).toBe('2026-09-01T00:00:00.000Z')
      expect(p.confidence).toBe(0.7)
    }

    // Every tier gets a real label; none falls back to the raw enum value.
    expect(new Set(projections.map((p) => p.fetchedViaLabel)).size).toBe(tiers.length)
  })

  it('exposes no field a UI could use to rank or caveat one tier over another', () => {
    // There is deliberately no isTrusted / tierRank / warning: the moment one exists,
    // someone renders it, and a reviewer starts discounting an escalated fact whose
    // excerpt is just as verbatim as a feed's.
    for (const key of ['isTrusted', 'tierRank', 'warning', 'reliability', 'degraded']) {
      expect(EVIDENCE_VIEW_KEYS).not.toContain(key as never)
    }
  })
})

// ---------------------------------------------------------------------------

describe('nothing auto-submits (H8, irreversible in Part H)', () => {
  function walk(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'generated' || entry.startsWith('.')) continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) out.push(...walk(full))
      else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full)
    }
    return out
  }

  /**
   * The two files that must contain these patterns in order to forbid them: this
   * test and the F3 verifier, which scans for the same list. F0 set the precedent by
   * exempting `raw-client.ts` from its own no-raw-HTTP scanner — the checker cannot
   * be its own violation.
   */
  const SCANNER_FILES = new Set([join('tools', 'verify-f3.ts')])

  const sourceFiles = ['src', 'tools']
    .flatMap((d) => walk(join(process.cwd(), d)))
    .filter((f) => !SCANNER_FILES.has(f.slice(process.cwd().length + 1)))

  it('has no ATS application-submission endpoint anywhere in the source', () => {
    // Greenhouse exposes an authenticated application-submission endpoint. We do not
    // use it, ever. Auto-applying is the volume-over-quality failure handover.md
    // exists to reject, and it would breach ATS terms.
    const forbidden = [
      /harvest\.greenhouse\.io/i,
      /boards-api\.greenhouse\.io\/v1\/boards\/[^'"`]*\/jobs\/[^'"`]*\/?['"`]\s*,\s*\{?\s*method:\s*['"`]POST/i,
      /\/applications?\b[^'"`\n]*['"`]\s*,\s*\{[^}]*method:\s*['"`]POST/i,
      /api\.lever\.co\/v0\/postings\/[^'"`]*\/apply/i,
      /api\.ashbyhq\.com\/posting-api\/[^'"`]*\/apply/i,
      // Verbs only, word-anchored. `applicationSubmitted` is a STATE — Part C's
      // outreach predicate reads it to decide whether case 3 applies — and matching
      // it here would make this test fire on the very field F4 depends on.
      /\b(submitApplication|autoApply|applyToJob|postApplication|sendApplication|submitToAts)\b/i,
    ]
    const hits: string[] = []
    for (const file of sourceFiles) {
      const text = readFileSync(file, 'utf8')
      for (const pattern of forbidden) {
        if (pattern.test(text)) hits.push(`${file}: ${pattern}`)
      }
    }
    expect(hits).toEqual([])
  })

  it('calls gate.postJson from a reviewed allowlist of modules, and nowhere else', () => {
    // The gate's POST path exists for named callers only. Its own comment set the
    // rule: "If a second caller ever appears, it must be reviewed rather than
    // discovered — a POST is how an application would be submitted."
    //
    // F5 is that review. The second caller is the Gmail adapter, and the assertion
    // below is deliberately not loosened to "any file under outreach/" — each entry is
    // one module, listed by hand, so a third caller still fails this test.
    const ALLOWED_POST_JSON_CALLERS = [
      // F2 §4.5 — Firecrawl's v2 scrape endpoint, the only vendor API with no GET form.
      'intel/research/firecrawl.ts',
      // F5 — users.messages.send. A mail send is a POST to a Google host with an
      // OAuth bearer; it cannot reach an ATS, and the endpoint check below pins that.
      'outreach/mail/gmail.ts',
    ]
    const callers = sourceFiles.filter((file) => {
      if (file.endsWith(join('policy', 'fetch-policy-gate.ts'))) return false
      return /\.postJson\s*\(/.test(readFileSync(file, 'utf8'))
    })
    expect(callers.map((f) => f.split('/src/')[1] ?? f).sort()).toEqual([...ALLOWED_POST_JSON_CALLERS].sort())
  })

  it('the mail adapter posts only to the Gmail API host', () => {
    // The reason the allowlist entry above is safe, asserted rather than asserted-by-
    // comment: every URL the adapter can construct is built from one base constant,
    // and that constant is on gmail.googleapis.com.
    const text = readFileSync(join(process.cwd(), 'src/outreach/mail/gmail.ts'), 'utf8')
    const urls = text.match(/https?:\/\/[^'"`\s]+/g) ?? []
    const hosts = new Set(urls.map((u) => new URL(u).host))
    // Only the API host and the two documentation hosts cited in the comments. An ATS
    // host appearing anywhere in this file — even in a comment — fails here.
    expect([...hosts].sort()).toEqual([
      'developers.google.com',
      'gmail.googleapis.com',
      'support.google.com',
    ])
  })

  it('records a submission as a human act, never as a request this system issued', async () => {
    const { db } = await seedPacketWorld()
    await generateApplicationPackets(db)
    const packet = await db.applicationPacket.findFirstOrThrow()
    await acceptPacket(db, packet.id)
    await markPacketSubmitted(db, packet.id)

    const audit = await db.auditLog.findFirstOrThrow({
      where: { action: 'packet.submitted', subjectId: packet.id },
    })
    expect(audit.actorType).toBe('user')
    expect(audit.reasonCode).toBe('application_submitted')
    expect((audit.metadata as { submittedBy: string }).submittedBy).toContain('human')
  })
})
