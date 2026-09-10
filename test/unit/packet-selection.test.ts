import { describe, expect, it } from 'vitest'
import { looksEarlyCareer, looksSenior, rankCandidates, type PacketCandidate } from '../../src/apply/packet/select.js'
import { computePacketHash } from '../../src/apply/packet/hash.js'
import type { PrefilledAnswers } from '../../src/apply/packet/answers.js'

function candidate(over: Partial<PacketCandidate> = {}): PacketCandidate {
  return {
    opportunityId: 'o1',
    companyId: 'c1',
    companyName: 'Acme',
    leadId: 'l1',
    leadScore: 80,
    primaryTrack: 'sde',
    trackKey: 'sde',
    title: 'Backend Engineer',
    roleUrl: 'https://example.invalid/jobs/1',
    postedAt: new Date('2026-09-01T00:00:00Z'),
    earlyCareer: false,
    seniorityMismatch: false,
    ...over,
  }
}

describe('early-career detection', () => {
  it('recognises the shapes an internship posting actually uses', () => {
    for (const title of [
      'Software Engineering Intern',
      'Backend Internship (Summer 2027)',
      'New Grad Software Engineer',
      'University Recruiting - SWE',
      'Early-Career Android Developer',
      'Engineering Co-op',
      'Student Software Developer',
    ]) {
      expect(looksEarlyCareer(title), title).toBe(true)
    }
  })

  it('does not fire on ordinary senior postings', () => {
    for (const title of [
      'Staff Software Engineer',
      'Senior Backend Engineer',
      'Engineering Manager, Platform',
      'Internal Tools Engineer',
      'International Operations Lead',
    ]) {
      expect(looksEarlyCareer(title), title).toBe(false)
    }
  })

  it('treats a missing title as not early-career rather than throwing', () => {
    expect(looksEarlyCareer(null)).toBe(false)
  })
})

describe('seniority detection', () => {
  it('recognises titles beyond an intern\u2019s reach', () => {
    for (const title of [
      'Senior Software Engineer',
      'Staff Fullstack Engineer, Core Analytics',
      'Lead Machine Learning Engineer',
      'Senior Engineering Manager, ML Platform',
      'Principal Architect',
      'Director of Engineering',
      'Head of Platform',
      'Software Engineer III',
    ]) {
      expect(looksSenior(title), title).toBe(true)
    }
  })

  it('does not fire on roles an intern can actually apply to', () => {
    for (const title of [
      'Software Engineer',
      'Backend Engineer',
      'Frontend Web Developer',
      'Full Stack Engineer - Customer Experience',
      'Android Mobile Software Engineer',
    ]) {
      expect(looksSenior(title), title).toBe(false)
    }
  })

  it('never calls an early-career posting senior', () => {
    // A "New Grad" req that happens to mention a lead engineer is still a new-grad
    // req, and an internship is never out of reach for an intern.
    expect(looksSenior('Senior Thesis Intern')).toBe(false)
    expect(looksSenior('New Grad Engineer, Platform Leadership Track')).toBe(false)
  })
})

describe('candidate ranking', () => {
  it('puts an internship ahead of a senior role even when the senior one is fresher', () => {
    const intern = candidate({
      opportunityId: 'intern',
      earlyCareer: true,
      postedAt: new Date('2026-01-01T00:00:00Z'),
    })
    const senior = candidate({
      opportunityId: 'senior',
      earlyCareer: false,
      postedAt: new Date('2026-09-09T00:00:00Z'),
    })
    expect([senior, intern].sort(rankCandidates)[0]!.opportunityId).toBe('intern')
  })

  it('ranks a senior title below a reachable one, even on the primary track', () => {
    // For an intern a "Software Engineer" one track over is a better application than
    // a "Senior Backend Engineer" dead on track: the second is not an application
    // they can make.
    const senior = candidate({ opportunityId: 'senior', seniorityMismatch: true, trackKey: 'sde', primaryTrack: 'sde' })
    const reachable = candidate({ opportunityId: 'reachable', seniorityMismatch: false, trackKey: 'swe', primaryTrack: 'sde' })
    expect([senior, reachable].sort(rankCandidates)[0]!.opportunityId).toBe('reachable')
  })

  it('still puts an internship first even against a reachable mid-level role', () => {
    const intern = candidate({ opportunityId: 'intern', earlyCareer: true, seniorityMismatch: false })
    const mid = candidate({ opportunityId: 'mid', earlyCareer: false, seniorityMismatch: false })
    expect([mid, intern].sort(rankCandidates)[0]!.opportunityId).toBe('intern')
  })

  it('prefers a posting on the lead primary track when neither is early-career', () => {
    const onTrack = candidate({ opportunityId: 'on', trackKey: 'sde', primaryTrack: 'sde' })
    const offTrack = candidate({ opportunityId: 'off', trackKey: 'swe', primaryTrack: 'sde' })
    expect([offTrack, onTrack].sort(rankCandidates)[0]!.opportunityId).toBe('on')
  })

  it('prefers the fresher posting when the first two keys tie', () => {
    const older = candidate({ opportunityId: 'older', postedAt: new Date('2026-01-01T00:00:00Z') })
    const newer = candidate({ opportunityId: 'newer', postedAt: new Date('2026-09-01T00:00:00Z') })
    expect([older, newer].sort(rankCandidates)[0]!.opportunityId).toBe('newer')
  })

  it('sorts a posting with no date last rather than first', () => {
    // A null postedAt is unknown, not "posted at the epoch". Sorting it first would
    // put every undated posting ahead of every dated one.
    const dated = candidate({ opportunityId: 'dated', postedAt: new Date('2020-01-01T00:00:00Z') })
    const undated = candidate({ opportunityId: 'undated', postedAt: null })
    expect([undated, dated].sort(rankCandidates)[0]!.opportunityId).toBe('dated')
  })

  it('is deterministic when everything else ties, so a re-run picks the same packets', () => {
    const a = candidate({ opportunityId: 'aaa' })
    const b = candidate({ opportunityId: 'bbb' })
    expect([b, a].sort(rankCandidates).map((c) => c.opportunityId)).toEqual(['aaa', 'bbb'])
    expect([a, b].sort(rankCandidates).map((c) => c.opportunityId)).toEqual(['aaa', 'bbb'])
  })
})

describe('packetHash (A7 rehearsal)', () => {
  const answers: PrefilledAnswers = {
    answers: [
      {
        questionKey: 'full_name',
        question: 'Full name',
        answer: 'Ada Lovelace',
        approvedClaimIds: ['claim-b', 'claim-a'],
        citedEvidenceIds: [],
        source: 'deterministic',
      },
    ],
    unanswered: [{ questionKey: 'availability', question: 'When can you start?', reason: 'not supplied' }],
    generatedAt: '2026-09-10T00:00:00.000Z',
    promptVersion: null,
  }
  const base = {
    companyId: 'c1',
    opportunityId: 'o1',
    officialUrl: 'https://example.invalid/jobs/1',
    resumeVersionId: 'r1',
    resumeSha256: 'a'.repeat(64),
    prefilledAnswers: answers,
    citedEvidenceIds: ['e2', 'e1'],
    approvedClaimIds: ['claim-b', 'claim-a'],
  }

  it('is stable across citation reordering, because a citation list is a set', () => {
    expect(computePacketHash(base)).toBe(
      computePacketHash({ ...base, citedEvidenceIds: ['e1', 'e2'], approvedClaimIds: ['claim-a', 'claim-b'] }),
    )
  })

  it('changes when the resume FILE changes, not only its row id', () => {
    // A7 hashes attachment_sha256[] rather than an attachment id for exactly this
    // reason: the operator edits a resume in place, so the row id is stable across a
    // document that changed. An approval must not survive that.
    expect(computePacketHash({ ...base, resumeSha256: 'b'.repeat(64) })).not.toBe(computePacketHash(base))
  })

  it('changes when an answer changes', () => {
    const edited = structuredClone(answers)
    edited.answers[0]!.answer = 'Someone Else'
    expect(computePacketHash({ ...base, prefilledAnswers: edited })).not.toBe(computePacketHash(base))
  })

  it('changes when a blank question is filled in', () => {
    // Approving a packet with "availability" unanswered is not the same act as
    // approving one where it has since been answered.
    const filled = structuredClone(answers)
    filled.unanswered = []
    expect(computePacketHash({ ...base, prefilledAnswers: filled })).not.toBe(computePacketHash(base))
  })

  it('changes when the application URL changes', () => {
    expect(computePacketHash({ ...base, officialUrl: 'https://elsewhere.invalid/jobs/9' })).not.toBe(
      computePacketHash(base),
    )
  })
})
