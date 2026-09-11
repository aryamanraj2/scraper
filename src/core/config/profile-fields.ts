import type { ReasonCodeValue } from '../reason-codes/registry.js'

/**
 * D6 condition 3 — "candidate profile complete against the enumerated field list".
 *
 * A12 lists *"send-enable field list unenumerated"* among the remaining gaps in the
 * handover. `schema.prisma` has promised since F0 that the list lives in this file.
 * It did not exist until F5; `CandidateProfile` has no rows at all, which is why
 * `profile_incomplete` is an F5 code.
 *
 * ## What belongs on the list, and the discipline that decides it
 *
 * A field is required **only if a sent message actually consumes it**. That is a
 * narrow rule and it is deliberate. The tempting version of this list is "everything
 * a profile could hold" — location, work authorization, availability dates, a
 * signature block — which reads thorough and is not: every one of those is either
 * already bounded by `ApprovedClaim` or is not in the message at all, so requiring it
 * would block sends on data no recipient will ever see. `handover.md` §8's ban on
 * falsely claiming work authorization, remote availability or a graduation date is
 * enforced where those statements are made — on the claim side, per sentence — not by
 * a column existing here.
 *
 * So three fields, each traced to the thing that consumes it:
 *
 * | Field | Consumed by |
 * |---|---|
 * | `fullName` | the sign-off template `signoff.plain@1`, which renders the operator's name |
 * | `senderIdentity` | the `From` header, and A7's hash — this is whose name is on the message |
 * | `replyToEmail` | the `Reply-To` header. B4's voluntarily-adopted controls require *"accurate sender identity and a real reply-to"*, and §8.5 makes a monitored reply-to a precondition for the milestone |
 *
 * ## What is deliberately NOT required, and why each
 *
 * - **`availabilityFrom` / `availabilityTo`.** The availability sentence in a message
 *   is an `ApprovedClaim` quoted in the operator's own words. The operator's actual
 *   window is *"December 2026 through January 2027, or June 2027 through August
 *   2027"* — two disjoint ranges, which two columns cannot express. Parsing that prose
 *   into a single from/to pair would store a window the operator never stated, in the
 *   table whose job is to be the checked one. F3 §4.3's rule applies: a missing fact
 *   is a blank with a reason, never a guess.
 * - **`location`, `workAuthorization`, `links`.** Real facts, all present as
 *   `ApprovedClaim` rows, none of which appears in an outbound message. They are
 *   populated for completeness and are not gates.
 * - **`signature`.** No template reads it; `signoff.plain@1` renders the name and the
 *   opt-out line. Requiring an unused column is a gate on nothing.
 *
 * ## `isComplete` is a cache, never the authority
 *
 * The column exists and is maintained, but the send gate re-derives completeness from
 * the fields on every call. A7's reasoning generalises: a stored boolean asserting
 * that some earlier check passed proves nothing about the row as it stands now, and a
 * field cleared after the flag was set would send anyway.
 */

export const REQUIRED_PROFILE_FIELDS = ['fullName', 'senderIdentity', 'replyToEmail'] as const

export type RequiredProfileField = (typeof REQUIRED_PROFILE_FIELDS)[number]

/** The subset of `CandidateProfile` this check reads. */
export type ProfileCompletenessInput = {
  fullName?: string | null
  senderIdentity?: string | null
  replyToEmail?: string | null
} | null

export type ProfileVerdict =
  | { complete: true; senderIdentity: string; replyToEmail: string; fullName: string }
  | { complete: false; reason: ReasonCodeValue; missing: string[]; detail: string }

/** `Display Name <local@domain>` or a bare address; returns the address part. */
export function addressOf(identity: string): string | null {
  const angled = /<([^<>]+)>\s*$/.exec(identity.trim())
  const candidate = (angled?.[1] ?? identity).trim().toLowerCase()
  // Deliberately shallow. This is not an RFC 5322 parser and must not pretend to be:
  // its only job is to answer "does the identity name the account we authenticated
  // as", and anything it cannot confidently read is a mismatch rather than a pass.
  return /^[^\s@<>,;]+@[^\s@<>,;.]+(\.[^\s@<>,;.]+)+$/.test(candidate) ? candidate : null
}

/**
 * D6 condition 3, plus the one consistency check that belongs with it.
 *
 * `sendingAccount` is the mailbox the transport authenticates as. If the profile's
 * sender identity names a different address, the `From` header would claim an account
 * this build does not hold — and Gmail would rewrite it, so the message the recipient
 * reads would silently disagree with the message the operator approved and A7 hashed.
 * That is a completeness failure about the profile, not a transport error, so it is
 * reported here with the same code.
 */
export function checkProfileComplete(
  profile: ProfileCompletenessInput,
  opts: { sendingAccount?: string | undefined } = {},
): ProfileVerdict {
  if (!profile) {
    return {
      complete: false,
      reason: 'profile_incomplete',
      missing: [...REQUIRED_PROFILE_FIELDS],
      detail: 'no CandidateProfile row exists',
    }
  }

  const missing = REQUIRED_PROFILE_FIELDS.filter((f) => {
    const value = profile[f]
    return value === null || value === undefined || value.trim() === ''
  })
  if (missing.length > 0) {
    return {
      complete: false,
      reason: 'profile_incomplete',
      missing: [...missing],
      detail: `CandidateProfile is missing: ${missing.join(', ')}`,
    }
  }

  const senderIdentity = profile.senderIdentity!.trim()
  const replyToEmail = profile.replyToEmail!.trim()
  const fullName = profile.fullName!.trim()

  const identityAddress = addressOf(senderIdentity)
  if (identityAddress === null) {
    return {
      complete: false,
      reason: 'profile_incomplete',
      missing: ['senderIdentity'],
      detail: `senderIdentity "${senderIdentity}" carries no readable address`,
    }
  }
  if (opts.sendingAccount && identityAddress !== opts.sendingAccount.trim().toLowerCase()) {
    return {
      complete: false,
      reason: 'profile_incomplete',
      missing: ['senderIdentity'],
      detail:
        `senderIdentity resolves to ${identityAddress}, but the transport authenticates as ` +
        `${opts.sendingAccount.trim().toLowerCase()}`,
    }
  }
  if (addressOf(replyToEmail) === null) {
    return {
      complete: false,
      reason: 'profile_incomplete',
      missing: ['replyToEmail'],
      detail: `replyToEmail "${replyToEmail}" is not a readable address`,
    }
  }

  return { complete: true, senderIdentity, replyToEmail, fullName }
}
