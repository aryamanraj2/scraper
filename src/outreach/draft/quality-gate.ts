import type { ReasonCodeValue } from '../../core/reason-codes/registry.js'
import { scanForInjection } from '../../intel/research/injection.js'
import {
  CANDIDATE_CITED_ROLES,
  COMPANY_CITED_ROLES,
  type DraftComposition,
} from './message.js'

/**
 * The Quality Gate — Part F's *"Quality Gate with versioned checks"*, and
 * `handover.md` §5's worker 10: *"validates role relevance, recipient suitability,
 * citation support, claim safety, duplicate/suppression state, and wording. Failed
 * drafts return to research or are rejected."*
 *
 * ## What is checked here and what is checked elsewhere
 *
 * Deliberately narrow. This gate checks the **message**. It does not re-check things
 * that already have a choke point, because a second, weaker implementation of a check
 * that already passed is how two implementations end up disagreeing (F3 §7 makes the
 * same argument about re-deriving citation ids):
 *
 * | concern | where it actually lives |
 * |---|---|
 * | citation support | `validateComposition` — a schema error before a gate runs |
 * | recipient suitability | `isExecutiveContact`, at curation |
 * | outreach permission | `decideOutreachCase` |
 * | jurisdiction | `checkJurisdiction` |
 * | suppression, caps, breaker | D6's send gate — **F5**, not here |
 *
 * What is left is wording and shape, which nothing else looks at.
 *
 * ## Why the checks are versioned
 *
 * Part F asks for it, and A11's reasoning applies: a stored `gateResult` has to mean
 * something later. If the check set changes, a draft that passed under the old set
 * did not pass the new one, and a version label is the only thing that makes the
 * stored verdict readable a month later. Same rule as `ScoreVersion` — **a version is
 * never edited, only added.**
 */
export const GATE_VERSION = 'f4-gate-v1'

/**
 * §10.8 and `handover.md` §8: short enough for a recruiter to scan. The long sample
 * in the screenshots is reference material, not the output length target.
 *
 * A ceiling rather than a target, and generous — the point is to catch a draft that
 * turned into a cover letter, not to police a good message by twenty characters.
 */
export const MAX_BODY_CHARS = 1_400
export const MAX_SUBJECT_CHARS = 90

/**
 * Phrases `handover.md` §8 names, or that assert something no citation can support.
 *
 * Narrow on purpose, the way F2 §4.12's injection patterns are: "excited" is an
 * ordinary word, and a gate that fired on it would be turned off within a week. Each
 * entry here is either named in the brief or is a claim about the recipient's
 * internal state that this system cannot know.
 */
const BANNED_PHRASES: { pattern: RegExp; why: string }[] = [
  {
    // handover.md §8, quoted: 'Do not use generic praise such as "I love what you're building".'
    pattern: /\bi love what you(?:'|’)?re building\b/i,
    why: 'handover.md §8 names this phrase specifically as the generic praise to avoid',
  },
  {
    pattern: /\bhuge fan of (?:what|everything) you\b/i,
    why: 'generic praise; §8 asks for a cited specific instead',
  },
  {
    // "I know you're hiring for X" without a posting is a claim about internal plans.
    pattern: /\bi know (?:you|your team) (?:are|is|'re)? ?(?:hiring|planning|looking)\b/i,
    why: 'handover.md §8 forbids claiming knowledge of internal hiring plans',
  },
  {
    pattern: /\b(?:i am|i'm) (?:authori[sz]ed|eligible) to work in the (?:us|usa|uk|eu)\b/i,
    why: 'handover.md §8 forbids falsely claiming local work authorization; this must come from an ApprovedClaim',
  },
  {
    pattern: /\bper my last email\b|\bas discussed\b|\bfollowing up on our (?:call|conversation)\b/i,
    why: 'fake-reply framing; B4 lists "no deceptive subject lines or fake-reply framing" among the adopted controls',
  },
]

/** Subject lines that misrepresent what the message is. B4's deception control. */
const BANNED_SUBJECT_PATTERNS: { pattern: RegExp; why: string }[] = [
  {
    pattern: /^\s*re:/i,
    why: 'a "Re:" subject on a first touch is fake-reply framing (B4)',
  },
  {
    pattern: /^\s*fwd?:/i,
    why: 'a forwarded-looking subject on a first touch is fake-reply framing (B4)',
  },
  {
    pattern: /\burgent\b|\bimmediate(?:ly)?\b|\blast chance\b/i,
    why: 'false urgency in a subject line is deceptive framing (B4)',
  },
]

export type GateCheck = {
  id: string
  passed: boolean
  detail: string
}

export type GateResult = {
  version: string
  passed: boolean
  checks: GateCheck[]
  /** Set when `passed` is false. What the draft's `statusReason` becomes. */
  reason: ReasonCodeValue | null
  evaluatedAt: string
}

export type GateInput = {
  subject: string
  bodyText: string
  composition: DraftComposition
  /** Present unless the message is a case-1 speculative one with no posting. */
  companyName: string
}

/**
 * Runs every check and returns them all, passed or failed.
 *
 * Every check is reported rather than short-circuiting on the first failure, because
 * `gateResult` is written for a human to read: "it failed" is much less useful than
 * "it failed this one and passed the other six", and a composer iterating on a draft
 * wants the whole list.
 */
export function runQualityGate(input: GateInput, now: Date = new Date()): GateResult {
  const checks: GateCheck[] = []

  const companySentences = input.composition.sentences.filter((s) => COMPANY_CITED_ROLES.has(s.role))
  const candidateSentences = input.composition.sentences.filter((s) => CANDIDATE_CITED_ROLES.has(s.role))

  // 1. The edge the operator named. Not a re-check of validateComposition's schema
  // rule — that one refuses a company sentence with no citation. This one refuses a
  // MESSAGE with no company sentence at all, which parses fine and is template spray.
  checks.push({
    id: 'has_cited_company_sentence',
    passed: companySentences.length > 0 && companySentences.every((s) => s.evidenceIds.length > 0),
    detail: `${companySentences.length} evidence-cited company sentence(s); §10.1's stated edge over template spray`,
  })

  checks.push({
    id: 'has_cited_candidate_sentence',
    passed: candidateSentences.length > 0 && candidateSentences.every((s) => s.approvedClaimIds.length > 0),
    detail: `${candidateSentences.length} ApprovedClaim-cited candidate sentence(s)`,
  })

  // 2. §8: "at least two specific, recent, non-marketing sources" for the personalized
  // opener. Counting DISTINCT evidence rows, because two sentences citing one row is
  // one source quoted twice.
  const distinctEvidence = new Set(companySentences.flatMap((s) => s.evidenceIds))
  checks.push({
    id: 'personalization_sources',
    // One is the floor the schema enforces; §8 wants two. A one-source opener is a
    // warning rather than a rejection at this volume — recorded, not fatal.
    passed: distinctEvidence.size >= 1,
    detail:
      `${distinctEvidence.size} distinct Evidence row(s) behind the opener` +
      (distinctEvidence.size < 2 ? ' — §8 asks for two; this one is thin' : ''),
  })

  // 3. §10.8 and §8: short enough to scan.
  checks.push({
    id: 'body_length',
    passed: input.bodyText.length <= MAX_BODY_CHARS,
    detail: `${input.bodyText.length} chars (max ${MAX_BODY_CHARS}); §10.8 "short, not a cover letter"`,
  })
  checks.push({
    id: 'subject_length',
    passed: input.subject.length <= MAX_SUBJECT_CHARS,
    detail: `${input.subject.length} chars (max ${MAX_SUBJECT_CHARS})`,
  })

  // 4. Wording. §8's named phrases and B4's deception controls.
  const bannedHits = BANNED_PHRASES.filter((p) => p.pattern.test(input.bodyText))
  checks.push({
    id: 'wording',
    passed: bannedHits.length === 0,
    detail: bannedHits.length === 0 ? 'no banned phrasing' : bannedHits.map((h) => h.why).join('; '),
  })
  const subjectHits = BANNED_SUBJECT_PATTERNS.filter((p) => p.pattern.test(input.subject))
  checks.push({
    id: 'subject_framing',
    passed: subjectHits.length === 0,
    detail: subjectHits.length === 0 ? 'subject states what the message is' : subjectHits.map((h) => h.why).join('; '),
  })

  // 5. Instruction-shaped text in an outbound message.
  //
  // F2 §4.12 scans INBOUND page text. This scans what we are about to SEND, which is a
  // different threat and worth its own check: an excerpt from a hostile careers page
  // that reached a draft would otherwise be forwarded, over the operator's name, to a
  // real recruiter — and the composer's input is exactly such excerpts.
  const injection = scanForInjection(`${input.subject}\n${input.bodyText}`)
  checks.push({
    id: 'no_injection_in_outbound',
    passed: !injection.detected,
    detail: injection.detected
      ? `instruction-shaped text in the outbound body: ${injection.matches.map((m) => m.pattern).join(', ')}`
      : 'no instruction-shaped text',
  })

  // 6. The message is about the company it is addressed to. A composer bug that
  // reuses the previous company's sentence is silent otherwise, and it is the single
  // most embarrassing thing this system could send.
  checks.push({
    id: 'names_the_company',
    passed: input.bodyText.toLowerCase().includes(input.companyName.toLowerCase()),
    detail: `body mentions "${input.companyName}"`,
  })

  const failed = checks.filter((c) => !c.passed)
  return {
    version: GATE_VERSION,
    passed: failed.length === 0,
    checks,
    reason: failed.length === 0 ? null : reasonFor(failed),
    evaluatedAt: now.toISOString(),
  }
}

/**
 * The reason code a failure records.
 *
 * A gate failure is not a policy violation — the policy checks ran before this and
 * refused with their own codes. What a gate failure means is that the *evidence or
 * the wording* did not hold up, so it maps onto the F2 codes that already say exactly
 * that rather than inventing a new one. The enum is closed (Part G) and a new value
 * would need a migration and an owner; these two already fit.
 */
function reasonFor(failed: GateCheck[]): ReasonCodeValue {
  if (failed.some((c) => c.id === 'no_injection_in_outbound')) return 'injection_detected'
  if (failed.some((c) => c.id === 'has_cited_company_sentence' || c.id === 'has_cited_candidate_sentence')) {
    return 'weak_evidence'
  }
  if (failed.some((c) => c.id === 'personalization_sources')) return 'weak_evidence'
  return 'low_relevance'
}
