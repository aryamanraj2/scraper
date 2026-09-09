import type { Db } from '../../core/audit/audit-log.js'
import { resolveCountries } from '../country/normalize.js'
import { matchTracks, type TextField } from '../taxonomy/matcher.js'
import { latestJobCountDelta } from '../signals/job-count-delta.js'
import { EVIDENCE_FRESH_DAYS, POSTING_STALE_DAYS, type ScoreInput } from './score.js'

/**
 * Gathers everything the scorer needs from rows we already hold.
 *
 * Deliberately read-only and network-free. The scorer is pure (A11 replayability),
 * so all the impurity lives here, in one place, where it can be pointed at a
 * fixture database in a test.
 *
 * ## Which text is allowed to support which claim
 *
 * Text arrives tagged with the tier that produced it, because H7 makes the
 * distinction load-bearing: yc-oss has no LICENSE and is a seed index, so a claim
 * resting only on `company:` fields has no employer-published corroboration. The
 * matcher records which field each snippet came from, and `seedIndexOnly` is
 * computed from the snippets that actually matched — not from what was available.
 */

/** Field-name prefixes, so the tier of a matched snippet is readable downstream. */
export const FIELD_PREFIX = {
  /** yc-oss seed index (H7). */
  seed: 'company:',
  /** Employer-published ATS feed. */
  posting: 'posting:',
  /** Employer's own page, via static fetch or Firecrawl escalation. */
  page: 'page:',
} as const

const INTERNSHIP_TERMS = ['intern', 'internship', 'new grad', 'new-grad', 'graduate programme', 'graduate program', 'apprentice']
const REMOTE_TERMS = ['remote', 'distributed team', 'work from anywhere', 'hybrid']

export type CompanyForScoring = {
  id: string
  canonicalDomain: string
  displayName: string
  countries: string[]
  teamSize: number | null
  tags: string[]
  ycOneLiner: string | null
  ycLongDescription: string | null
  ycIsHiring: boolean | null
  ycStatus: string | null
  atsBoardToken: string | null
  careersUrl: string | null
}

export const COMPANY_SCORING_SELECT = {
  id: true,
  canonicalDomain: true,
  displayName: true,
  countries: true,
  teamSize: true,
  tags: true,
  ycOneLiner: true,
  ycLongDescription: true,
  ycIsHiring: true,
  ycStatus: true,
  atsBoardToken: true,
  careersUrl: true,
} as const

function ageInDays(from: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - from.getTime()) / 86_400_000))
}

function countTerms(text: string, terms: readonly string[]): number {
  const lower = text.toLowerCase()
  return terms.reduce((n, term) => (lower.includes(term) ? n + 1 : n), 0)
}

export type CollectedScoreInput = {
  input: ScoreInput
  /** The text the matcher saw, kept so a score can be explained without a refetch. */
  fields: TextField[]
  /** Evidence rows that support the personalization component, for citation. */
  citedEvidenceIds: string[]
  /**
   * Per-posting track assignment, so `Opportunity.roleTrackId` can be filled from
   * the same match that produced the score. F3 selects a resume by track, and a
   * posting whose track is only implied by its company would get the wrong one.
   */
  opportunityTracks: { opportunityId: string; track: string | null; confidence: number }[]
}

export async function collectScoreInput(
  db: Db,
  company: CompanyForScoring,
  now = new Date(),
): Promise<CollectedScoreInput> {
  const [opportunities, evidence, boardFailure] = await Promise.all([
    db.opportunity.findMany({
      where: { companyId: company.id },
      select: { id: true, title: true, location: true, roleUrl: true, status: true, lastSeenAt: true, postedAt: true },
    }),
    db.evidence.findMany({
      where: { companyId: company.id },
      orderBy: { observedAt: 'desc' },
      select: { id: true, sourceType: true, excerpt: true, sourceUrl: true, observedAt: true },
    }),
    db.auditLog.findFirst({
      where: { subjectId: company.id, action: 'ats.board_failed' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
  ])

  // --- the text the matcher is allowed to see ------------------------------
  const fields: TextField[] = []
  if (company.ycOneLiner) fields.push({ field: `${FIELD_PREFIX.seed}one_liner`, text: company.ycOneLiner })
  if (company.ycLongDescription) {
    fields.push({ field: `${FIELD_PREFIX.seed}long_description`, text: company.ycLongDescription })
  }
  if (company.tags.length > 0) fields.push({ field: `${FIELD_PREFIX.seed}tags`, text: company.tags.join(', ') })

  for (const opportunity of opportunities) {
    // F1 stores a posting's title, location and URL, not its body: the Evidence
    // excerpt is a 500-char JSON fragment of those three fields. So the matcher
    // sees titles from the ATS tier, and page text (below) is what carries the
    // richer employer vocabulary.
    const text = [opportunity.title, opportunity.location].filter(Boolean).join(' — ')
    if (text) fields.push({ field: `${FIELD_PREFIX.posting}${opportunity.title ?? opportunity.id}`, text })
  }

  for (const row of evidence) {
    if (row.sourceType !== 'company_page') continue
    fields.push({ field: `${FIELD_PREFIX.page}${row.sourceUrl}`, text: row.excerpt })
  }

  const match = matchTracks(fields)
  const matchedFields = new Set(match.matches.flatMap((m) => m.snippets.map((s) => s.field)))
  const matchedNonSeed = [...matchedFields].some((f) => !f.startsWith(FIELD_PREFIX.seed))

  // --- hiring --------------------------------------------------------------
  const openOpportunities = opportunities.filter((o) => o.status === 'open')
  const primaryTrack = match.primary?.track ?? null

  // Matched once per posting and reused: the same computation answers "how many
  // open roles match the primary track" and "which track is this posting".
  const opportunityTracks = opportunities.map((o) => {
    const text = [o.title, o.location].filter(Boolean).join(' — ')
    if (!text) return { opportunityId: o.id, track: null, confidence: 0 }
    const perPosting = matchTracks([{ field: `${FIELD_PREFIX.posting}${o.title ?? o.id}`, text }])
    const best = perPosting.matches[0]
    return {
      opportunityId: o.id,
      track: best?.track ?? null,
      confidence: best?.confidence ?? 0,
      tracks: perPosting.matches.map((m) => m.track),
    }
  })
  const trackByOpportunity = new Map(opportunityTracks.map((t) => [t.opportunityId, t]))
  const relevantOpenRoles = primaryTrack
    ? openOpportunities.filter((o) => (trackByOpportunity.get(o.id)?.tracks ?? []).includes(primaryTrack)).length
    : 0

  const latestCountSignal = await db.companySignal.findFirst({
    where: { companyId: company.id, signalType: 'job_posting', numericValue: { not: null } },
    orderBy: { observedAt: 'desc' },
    select: { numericValue: true },
  })

  // --- personalization: recent, employer-published sources (§8) ------------
  const recentEmployerEvidence = evidence.filter(
    (e) =>
      (e.sourceType === 'ats' || e.sourceType === 'company_page') &&
      ageInDays(e.observedAt, now) <= EVIDENCE_FRESH_DAYS,
  )
  const distinctSourceTypes = new Set(recentEmployerEvidence.map((e) => e.sourceType)).size

  // --- freshness -----------------------------------------------------------
  const newestEvidence = evidence[0]
  const newestPosting = openOpportunities
    .map((o) => o.lastSeenAt)
    .sort((a, b) => b.getTime() - a.getTime())[0]

  const allText = fields.map((f) => f.text).join('\n')

  const input: ScoreInput = {
    now,
    match,
    matchSources: {
      seedIndexOnly: match.matches.length > 0 && !matchedNonSeed,
      fromAts: [...matchedFields].some((f) => f.startsWith(FIELD_PREFIX.posting)),
      fromCompanyPage: [...matchedFields].some((f) => f.startsWith(FIELD_PREFIX.page)),
    },
    hiring: {
      openPostings: latestCountSignal ? (latestCountSignal.numericValue as number) : null,
      jobCountDelta: await latestJobCountDelta(db, company.id),
      relevantOpenRoles,
      ycIsHiring: company.ycIsHiring,
    },
    applicationRoute: {
      hasBoardToken: company.atsBoardToken !== null,
      hasRoleUrl: opportunities.some((o) => o.roleUrl !== null),
      hasCareersUrl: company.careersUrl !== null,
      // A board the employer links and the vendor 404s is a dead board, not an
      // absent ATS (F1 §8.3). It costs points; it does not remove the route.
      boardDead: company.atsBoardToken !== null && boardFailure !== null && openOpportunities.length === 0,
    },
    feasibility: {
      teamSize: company.teamSize,
      internshipMentions: countTerms(allText, INTERNSHIP_TERMS),
    },
    geography: {
      countries: resolveCountries(company.countries),
      remoteEvidence: countTerms(allText, REMOTE_TERMS) > 0,
    },
    personalization: {
      specificSourceCount: recentEmployerEvidence.length,
      distinctSourceTypes,
    },
    freshness: {
      newestEvidenceAgeDays: newestEvidence ? ageInDays(newestEvidence.observedAt, now) : null,
      newestPostingAgeDays: newestPosting ? ageInDays(newestPosting, now) : null,
    },
    risks: {
      allPostingsStale:
        openOpportunities.length > 0 &&
        openOpportunities.every((o) => ageInDays(o.lastSeenAt, now) > POSTING_STALE_DAYS),
      lifecycleStatus: company.ycStatus,
    },
  }

  return {
    input,
    fields,
    // Capped: a Lead cites the sources behind its score, not every row we hold.
    citedEvidenceIds: recentEmployerEvidence.slice(0, 20).map((e) => e.id),
    opportunityTracks: opportunityTracks.map(({ opportunityId, track, confidence }) => ({
      opportunityId,
      track,
      confidence,
    })),
  }
}
