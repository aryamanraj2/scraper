import type { Prisma } from '../../../generated/prisma/client.js'
import type { Db } from '../../core/audit/audit-log.js'
import { writeAudit } from '../../core/audit/audit-log.js'
import type { ReasonCodeValue } from '../../core/reason-codes/registry.js'
import { collectScoreInput, type CompanyForScoring } from './collect.js'
import { scoreCompany, type ScoreBreakdown } from './score.js'
import { SCORE_VERSION_V1, assertSumsTo100, type ScoreVersionSpec } from './score-version.js'
import { roleTrackIdsByKey } from '../taxonomy/seed-tracks.js'

/**
 * Scoring, persisted.
 *
 * The arithmetic lives in `score.ts` and stays pure; this module is the part that
 * touches rows. Three things get written and they are deliberately separate:
 *
 *   - `ScoreVersion` — the weight set, validated to sum to 100 before it is stored,
 *     so a row that could not have produced a valid score cannot exist (A1).
 *   - `Lead` — score, risk deduction, `score_components` JSON, and the version it
 *     was computed under, so any later threshold change replays against it (A11).
 *   - `AuditLog` — the reason codes the score raised, which is what A11 asks the
 *     operator to review qualitatively instead of tuning weights on 0-3 events.
 */

/**
 * The campaign cycle a lead belongs to. Month-grained.
 *
 * This is the unit A2's dedup indexes count in — one first touch per contact and
 * per company per cycle — so it must be coarse enough that a cycle boundary is not
 * a way to message someone twice in a fortnight.
 */
export function currentCampaignCycle(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * Writes (or finds) the row for a weight set.
 *
 * The spec is re-validated here rather than trusted, because a `ScoreVersion` row
 * is the thing a historical score is replayed against: a row whose weights do not
 * sum to 100 would make every score that cites it unexplainable.
 *
 * An existing row is never rewritten. A11 freezes weights, and silently updating a
 * stored version would change the meaning of every score already computed under
 * it — the exact failure `ScoreVersion` exists to prevent. Changing weights means
 * a new label.
 */
export async function ensureScoreVersion(db: Db, spec: ScoreVersionSpec = SCORE_VERSION_V1): Promise<string> {
  assertSumsTo100(spec)
  const existing = await db.scoreVersion.findUnique({ where: { label: spec.label }, select: { id: true } })
  if (existing) return existing.id

  const created = await db.scoreVersion.create({
    data: {
      label: spec.label,
      weights: spec.weights as unknown as Prisma.InputJsonValue,
      thresholds: spec.thresholds as unknown as Prisma.InputJsonValue,
      maxRiskDeduction: spec.maxRiskDeduction,
      frozenUntilSends: spec.frozenUntilSends,
      isActive: true,
    },
    select: { id: true },
  })
  // Exactly one active version at a time: "the active weight set" has to be a
  // single answer, or two leads scored on the same day are not comparable.
  await db.scoreVersion.updateMany({ where: { id: { not: created.id } }, data: { isActive: false } })
  return created.id
}

export type ScoreCompanyOutcome =
  | { scored: true; leadId: string; breakdown: ScoreBreakdown }
  | { scored: false; reason: Extract<ReasonCodeValue, 'insufficient_evidence'>; detail: string }

export type ScoreCompanyOptions = {
  now?: Date
  spec?: ScoreVersionSpec
  campaignCycle?: string
}

/**
 * Scores one company and records the result.
 *
 * Refuses rather than guesses when there is nothing to score on: no track cleared
 * the confidence floor with a specific term means we have no supported claim about
 * what this company builds, and `handover.md` §5.3 forbids applying a label anyway.
 * That is `insufficient_evidence` — D1 makes it re-entrant, a budget decision
 * rather than a verdict, so the company stays eligible for more research.
 */
export async function scoreCompanyAndPersist(
  db: Db,
  company: CompanyForScoring,
  opts: ScoreCompanyOptions = {},
): Promise<ScoreCompanyOutcome> {
  const now = opts.now ?? new Date()
  const spec = opts.spec ?? SCORE_VERSION_V1
  const campaignCycle = opts.campaignCycle ?? currentCampaignCycle(now)

  const collected = await collectScoreInput(db, company, now)

  if (collected.input.match.matches.length === 0) {
    const detail =
      collected.fields.length === 0
        ? 'no source text held for this company'
        : `no track cleared the confidence floor across ${collected.fields.length} source field(s)`
    await db.company.update({
      where: { id: company.id },
      data: { status: 'insufficient_evidence', statusReason: 'insufficient_evidence', lastRefreshedAt: now },
    })
    await writeAudit(db, {
      actorType: 'system',
      actorId: 'scorer',
      action: 'score.refused',
      subjectType: 'Company',
      subjectId: company.id,
      reasonCode: 'insufficient_evidence',
      metadata: { detail, fields: collected.fields.length },
    })
    return { scored: false, reason: 'insufficient_evidence', detail }
  }

  const breakdown = scoreCompany(collected.input, spec)
  const scoreVersionId = await ensureScoreVersion(db, spec)

  // F3 selects a track-tailored resume per posting, so the track belongs on the
  // Opportunity rather than being re-derived from the company later. Only rows
  // whose own title supports a track are labelled: a posting inherits nothing.
  const trackIds = await roleTrackIdsByKey(db)
  for (const assignment of collected.opportunityTracks) {
    const roleTrackId = assignment.track === null ? null : (trackIds.get(assignment.track) ?? null)
    await db.opportunity.update({
      where: { id: assignment.opportunityId },
      data: { roleTrackId },
    })
  }

  // A3: a lead with no Opportunity is speculative by definition, and the old state
  // machine could not represent it. Posted-role wins whenever an open posting
  // exists — Part C routes the two kinds to different terminal actions.
  const openOpportunity = await db.opportunity.findFirst({
    where: { companyId: company.id, status: 'open' },
    orderBy: { lastSeenAt: 'desc' },
    select: { id: true },
  })
  const leadKind = openOpportunity ? ('posted_role' as const) : ('speculative' as const)

  const status =
    breakdown.band === 'queue' ? ('qualified' as const)
    : breakdown.band === 'research' ? ('qualifying' as const)
    : ('rejected' as const)

  // The stored JSON carries the matched snippets as well as the numbers: F3's
  // evidence viewer needs the reasons to be readable, and a score whose only
  // artefact is an integer cannot be reviewed.
  const componentsJson = {
    ...breakdown,
    tracks: collected.input.match.matches.map((m) => ({
      track: m.track,
      confidence: m.confidence,
      specificTerms: m.specificTerms,
      negativeTerms: m.negativeTerms,
      snippets: m.snippets.slice(0, 8),
    })),
  } as unknown as Prisma.InputJsonValue

  const data = {
    opportunityId: openOpportunity?.id ?? null,
    leadKind,
    status,
    statusReason: breakdown.band === 'reject' ? ('low_relevance' as const) : null,
    primaryTrack: breakdown.primaryTrack!,
    primaryTrackReason: breakdown.primaryTrackReason,
    score: breakdown.total,
    riskDeduction: breakdown.riskDeduction,
    scoreComponents: componentsJson,
    scoreVersionId,
    citedEvidenceIds: collected.citedEvidenceIds,
  }

  // One lead per company per cycle. There is no unique index for this (D3's
  // indexes are on send_attempt, where the invariant actually matters), so the
  // rescore path looks first rather than creating a second row each run.
  const existing = await db.lead.findFirst({
    where: { companyId: company.id, campaignCycle },
    select: { id: true },
  })
  const lead = existing
    ? await db.lead.update({ where: { id: existing.id }, data, select: { id: true } })
    : await db.lead.create({ data: { companyId: company.id, campaignCycle, ...data }, select: { id: true } })

  await db.company.update({
    where: { id: company.id },
    data: { status: 'researched', statusReason: null, lastRefreshedAt: now },
  })

  await writeAudit(db, {
    actorType: 'system',
    actorId: 'scorer',
    action: 'score.computed',
    subjectType: 'Lead',
    subjectId: lead.id,
    // The band's own code, so the refusal counters read the way Part G intends.
    reasonCode: breakdown.band === 'reject' ? 'low_relevance' : undefined,
    metadata: {
      companyId: company.id,
      scoreVersion: breakdown.scoreVersion,
      total: breakdown.total,
      subtotal: breakdown.subtotal,
      riskDeduction: breakdown.riskDeduction,
      band: breakdown.band,
      primaryTrack: breakdown.primaryTrack,
      reasonCodes: breakdown.reasonCodes,
      countryMapVersion: breakdown.countryMapVersion,
    },
  })

  // Every reason the score raised gets its own row, so Part G's counters can be
  // read by reason rather than by parsing a metadata blob.
  for (const code of breakdown.reasonCodes) {
    if (code === 'low_relevance') continue
    await writeAudit(db, {
      actorType: 'system',
      actorId: 'scorer',
      action: 'score.reason',
      subjectType: 'Lead',
      subjectId: lead.id,
      reasonCode: code,
      metadata: { companyId: company.id, scoreVersion: breakdown.scoreVersion },
    })
  }

  return { scored: true, leadId: lead.id, breakdown }
}
