import type { RoleTrackKey } from '../../../generated/prisma/enums.js'
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
  /** Employer-published ATS feed: the posting's title and location. */
  posting: 'posting:',
  /** Employer-published ATS feed: the posting's body (F5a's `Opportunity.description`). */
  postingBody: 'posting-body:',
  /** Employer's own page, via static fetch or Firecrawl escalation. */
  page: 'page:',
} as const

/** Both ATS-tier prefixes, for the `fromAts` test. */
function isAtsField(field: string): boolean {
  return field.startsWith(FIELD_PREFIX.posting) || field.startsWith(FIELD_PREFIX.postingBody)
}

/**
 * What one distinct vocabulary phrase in a posting BODY is worth, against the
 * same phrase in that posting's title.
 *
 * The title is the employer's own one-line statement of what the role is, and it
 * is dense: every word in "Senior iOS Engineer" is about the job. The body of the
 * same posting has a median length of 6,152 characters in this corpus and a 90th
 * percentile of 10,374, most of which is a company overview, a benefits list and
 * an EEO statement — text about the employer, repeated verbatim across every
 * posting on the board, saying nothing about this role. Counting a phrase from
 * that at parity with a phrase from the title lets the company's dominant
 * technology outvote the job's actual title on every posting it publishes.
 *
 * 0.3 was chosen by measuring it against the corpus rather than by taste. Of the
 * 265 postings whose title alone already produces a label, 246 keep exactly that
 * label once the body is added and 19 move — all of them across the swe/sde
 * boundary, which shares one resume. **No posting labelled `ios_android` by its
 * title is moved off it at this weight**, which is the property the operator's
 * Android-vs-iOS resume rule depends on. Meanwhile 611 postings whose title says
 * only "Software Engineer II" gain a label they could not otherwise have.
 *
 * At 0.4 the flips rise to 27 and at 1.0 the body simply wins, which is the
 * failure the separate weight exists to prevent.
 */
export const POSTING_BODY_WEIGHT = 0.3

/**
 * How many posting bodies reach the COMPANY-level match.
 *
 * Bounded because one company in this corpus has 211 postings and 1.8 MB of body
 * text, and a company-level match is a claim about the company, not a census of
 * its job board. It costs almost nothing in accuracy: confidence is saturating
 * and `matchTrack` credits each distinct phrase once at its best field's weight,
 * so the 26th body can only restate phrases the first 25 already carried.
 * Measured over the 53 companies that hold bodies, capping at 25 changes the
 * primary track for 3 of them against no cap at all.
 *
 * Open postings first and newest first: a closed posting is not evidence of what
 * the company is hiring for now.
 */
export const COMPANY_BODY_FIELD_LIMIT = 25

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

type OpportunityForScoring = {
  id: string
  title: string | null
  location: string | null
  description: string | null
  status: string
  lastSeenAt: Date
}

/** The posting bodies the company-level match is allowed to see. See `COMPANY_BODY_FIELD_LIMIT`. */
function bodyFieldsFor<T extends OpportunityForScoring>(opportunities: readonly T[]): T[] {
  return opportunities
    .filter((o) => o.description !== null && o.description !== '')
    .sort(
      (a, b) =>
        Number(b.status === 'open') - Number(a.status === 'open') ||
        b.lastSeenAt.getTime() - a.lastSeenAt.getTime(),
    )
    .slice(0, COMPANY_BODY_FIELD_LIMIT)
}

/**
 * The fields ONE posting is classified from: its title, and its body at the body
 * weight. Used both here and by anything that needs to re-derive a single
 * posting's track without re-reading the company.
 */
export function postingFields(opportunity: OpportunityForScoring): TextField[] {
  const out: TextField[] = []
  const title = [opportunity.title, opportunity.location].filter(Boolean).join(' — ')
  const name = opportunity.title ?? opportunity.id
  if (title) out.push({ field: `${FIELD_PREFIX.posting}${name}`, text: title })
  if (opportunity.description) {
    out.push({
      field: `${FIELD_PREFIX.postingBody}${name}`,
      text: opportunity.description,
      weight: POSTING_BODY_WEIGHT,
    })
  }
  return out
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
  opportunityTracks: Omit<PostingTrackMatch, 'tracks'>[]
}

export type PostingTrackMatch = {
  opportunityId: string
  /** The one track this posting carries. Drives F3's resume selection. */
  track: RoleTrackKey | null
  confidence: number
  /** Every track the posting's text supports, for "does this match the company's primary track". */
  tracks: RoleTrackKey[]
}

/**
 * The track ONE posting carries.
 *
 * ## The title nominates; the body only corroborates
 *
 * `track` is chosen from the tracks the TITLE supports, at the confidence the
 * title and body together produce. The body can raise that confidence, and it can
 * add tracks to `tracks`, but it cannot take the primary slot from a track the
 * title named.
 *
 * The rule is here rather than in `matchTracks` because it is a fact about
 * postings, not about text: a posting title is the employer's own one-sentence
 * answer to "what is this job", and the body underneath it is shared boilerplate
 * plus a requirements section. Without the rule, a mobile role at a backend-heavy
 * company loses its track to the company overview printed above it — measured on
 * this corpus, an adversarially dense body flips "Senior iOS Engineer" to `sde`
 * even at `POSTING_BODY_WEIGHT`. That posting is what F3 hands a resume against
 * (`ORCHESTRATOR-HANDOVER.md` §2: 16 packets once handed an iOS resume to
 * generalist roles), so the guarantee is worth more here than the extra recall.
 *
 * A title with no specific vocabulary — "Software Engineer II", "Engineer, Growth"
 * — nominates nothing, and there the body decides alone. That is the case F5b
 * exists to unlock, and it is 611 of this corpus's postings.
 */
function matchOnePosting(opportunity: OpportunityForScoring): PostingTrackMatch {
  const fields = postingFields(opportunity)
  if (fields.length === 0) return { opportunityId: opportunity.id, track: null, confidence: 0, tracks: [] }

  const full = matchTracks(fields)
  const titleFields = fields.filter((f) => f.field.startsWith(FIELD_PREFIX.posting))
  const titleSupported = new Set(matchTracks(titleFields).matches.map((m) => m.track))

  const best =
    full.matches.find((m) => titleSupported.has(m.track)) ??
    // The title named nothing the floor accepted. The body is all we have.
    full.matches[0]

  return {
    opportunityId: opportunity.id,
    track: best?.track ?? null,
    confidence: best?.confidence ?? 0,
    tracks: full.matches.map((m) => m.track),
  }
}

export async function collectScoreInput(
  db: Db,
  company: CompanyForScoring,
  now = new Date(),
): Promise<CollectedScoreInput> {
  const [opportunities, evidence, boardFailure] = await Promise.all([
    db.opportunity.findMany({
      where: { companyId: company.id },
      select: {
        id: true,
        title: true,
        location: true,
        description: true,
        roleUrl: true,
        status: true,
        lastSeenAt: true,
        postedAt: true,
      },
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
    const text = [opportunity.title, opportunity.location].filter(Boolean).join(' — ')
    if (text) fields.push({ field: `${FIELD_PREFIX.posting}${opportunity.title ?? opportunity.id}`, text })
  }

  // F5a added `Opportunity.description` and 2,528 rows carry one. It is a separate
  // field rather than text appended to the title, and it is weighted: see
  // `POSTING_BODY_WEIGHT`. Concatenating it onto the title would erase the
  // distinction the weight depends on and would also mislabel every snippet's
  // provenance, since `MatchedSnippet.field` is what the F3 evidence viewer shows
  // the operator as the source of a claim.
  for (const opportunity of bodyFieldsFor(opportunities)) {
    fields.push({
      field: `${FIELD_PREFIX.postingBody}${opportunity.title ?? opportunity.id}`,
      text: opportunity.description!,
      weight: POSTING_BODY_WEIGHT,
    })
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
  const opportunityTracks = opportunities.map((o) => matchOnePosting(o))
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
        fromAts: [...matchedFields].some(isAtsField),
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
