import { Prisma } from '../../../generated/prisma/client.js'
import type { Db } from '../../core/audit/audit-log.js'
import { writeAudit } from '../../core/audit/audit-log.js'
import { checkProfileComplete, REQUIRED_PROFILE_FIELDS } from '../../core/config/profile-fields.js'

/**
 * Builds the single `CandidateProfile` row from `ApprovedClaim`, and from nothing else.
 *
 * D6 condition 3 gates every send on this row, and the table has been empty since F0.
 * The obvious way to fill it is to type the operator's details into a seed file — and
 * that would create a second, unchecked source of candidate facts, three milestones
 * after F3 §4.1 established that `ApprovedClaim` is *the* provenance table for what
 * may be said about the candidate. The F4 handover's instruction on this was explicit:
 * *"`ApprovedClaim` is the only source of candidate facts. Do not add a parallel
 * source."*
 *
 * So every field here is derived from an active claim, each claim named by key, and a
 * missing claim leaves its field null rather than guessing. `profile_incomplete` then
 * fires at the send gate, which is the correct behaviour for a fact the operator has
 * not supplied — F3 §4.3's rule, one table over.
 *
 * ## The one composed value, stated plainly
 *
 * `senderIdentity` is `"<identity.full_name> <<identity.email>>"` — two approved
 * claims joined into RFC 5322's display-name form. That is composition of the
 * operator's own words, not a new assertion: both halves are quoted verbatim and the
 * only added characters are the angle brackets the format requires. It is called out
 * because it is the one field that is not a straight copy, and because it is the
 * field A7 hashes.
 *
 * ## What is deliberately left null
 *
 * `availabilityFrom` / `availabilityTo`. The operator's window is two disjoint ranges
 * — December 2026 to January 2027, **or** June to August 2027 — and two columns cannot
 * hold that. Parsing the claim's prose into one pair would store a window the operator
 * never stated. The message says it in their own words instead, from
 * `eligibility.internship_window`, and `profile-fields.ts` does not require these.
 */

/** Which claim key fills which profile field. The whole mapping, in one table. */
export const PROFILE_CLAIM_KEYS = {
  fullName: 'identity.full_name',
  email: 'identity.email',
  location: 'identity.location',
  workAuthorization: 'eligibility.work_authorization_india',
  github: 'identity.github',
  linkedin: 'identity.linkedin',
  portfolio: 'identity.portfolio',
} as const

export type SeedProfileOutcome = {
  created: boolean
  updated: boolean
  missingClaimKeys: string[]
  missingFields: string[]
  complete: boolean
}

export async function seedCandidateProfile(
  db: Db,
  opts: { sendingAccount?: string | undefined } = {},
): Promise<SeedProfileOutcome> {
  const claims = await db.approvedClaim.findMany({
    where: { key: { in: Object.values(PROFILE_CLAIM_KEYS) }, isActive: true },
    select: { key: true, text: true },
  })
  const byKey = new Map(claims.map((c) => [c.key, c.text.trim()]))
  const missingClaimKeys = Object.values(PROFILE_CLAIM_KEYS).filter((k) => !byKey.has(k))

  const fullName = byKey.get(PROFILE_CLAIM_KEYS.fullName) ?? null
  const email = byKey.get(PROFILE_CLAIM_KEYS.email) ?? null

  // Both halves or neither: a display name with no address is not an identity, and a
  // bare address discards the name the recipient sees.
  const senderIdentity = fullName && email ? `${fullName} <${email}>` : null

  const links: Record<string, string> = {}
  for (const key of ['github', 'linkedin', 'portfolio'] as const) {
    const value = byKey.get(PROFILE_CLAIM_KEYS[key])
    if (value) links[key] = value
  }

  const data = {
    fullName: fullName ?? '',
    location: byKey.get(PROFILE_CLAIM_KEYS.location) ?? null,
    workAuthorization: byKey.get(PROFILE_CLAIM_KEYS.workAuthorization) ?? null,
    // `Prisma.DbNull` rather than `null`: a nullable Json column distinguishes "the
    // column is NULL" from "the JSON value is null", and only the first is what a
    // withdrawn set of link claims means.
    links: Object.keys(links).length > 0 ? links : Prisma.DbNull,
    senderIdentity,
    // The reply-to is the sending mailbox itself, which the operator monitors. B4 asks
    // for "a real reply-to"; a monitored inbox someone actually reads is that, and an
    // address on a domain nobody checks would not be.
    replyToEmail: email,
    // Deliberately null — see the header. Not a gap in the data, a gap in the column.
    availabilityFrom: null,
    availabilityTo: null,
    // `signature` stays null: no sentence template reads it (signoff.plain@1 renders
    // the name and the opt-out line), and a column nothing consumes is not a fact.
    signature: null,
  }

  const verdict = checkProfileComplete(
    { fullName: data.fullName, senderIdentity: data.senderIdentity, replyToEmail: data.replyToEmail },
    opts,
  )

  // One profile, by construction. There is one operator; a second row would make
  // "the candidate profile" ambiguous at the send gate, which is the last place
  // ambiguity belongs.
  const existing = await db.candidateProfile.findFirst({ select: { id: true } })
  if (existing) {
    await db.candidateProfile.update({
      where: { id: existing.id },
      data: { ...data, isComplete: verdict.complete },
    })
  } else {
    await db.candidateProfile.create({ data: { ...data, isComplete: verdict.complete } })
  }

  await writeAudit(db, {
    actorType: 'user',
    actorId: 'operator',
    action: 'candidate_profile.seeded',
    subjectType: 'CandidateProfile',
    metadata: {
      derivedFrom: 'ApprovedClaim',
      complete: verdict.complete,
      missingClaimKeys,
      // The values themselves are the operator's own approved claims and are already
      // in the database; what is worth recording is which ones were absent.
      ...(verdict.complete ? {} : { detail: verdict.detail }),
    },
  })

  return {
    created: !existing,
    updated: Boolean(existing),
    missingClaimKeys,
    missingFields: verdict.complete ? [] : verdict.missing,
    complete: verdict.complete,
  }
}

export { REQUIRED_PROFILE_FIELDS }
