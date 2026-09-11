import { normalizeEmail } from '../../core/crypto/secret-store.js'
import { isAtOrAfter, MILESTONE_STAGE, type Milestone } from '../../core/config/stage.js'
import type { ReasonCodeValue } from '../../core/reason-codes/registry.js'

/**
 * The owned-inbox condition — D6's tenth, and the only thing standing between a
 * one-line stage bump and a live email to a stranger.
 *
 * ## Why this exists as its own condition
 *
 * Part F's F5 deliverable is *"Verified sends to owned inboxes **only**"*; F6 is
 * *"Enable sending"*. D6 enumerates nine conditions and none of them says that,
 * because D6 describes the steady state after the pilot has started. Every one of
 * those nine passes for the approved draft sitting in `outreach_dev` right now —
 * its recipient is `info@nanonets.com`, a real third party at a real company.
 *
 * So at F5 the difference between "send readiness" and "the pilot has begun" is
 * exactly this function. Without it, raising `MILESTONE_STAGE` *is* starting the
 * pilot, and the two independent factors that F0 built (a reviewed source constant
 * plus an env flag) would both be satisfied by the act of finishing the milestone.
 *
 * ## Lifting it is deliberately two acts, not one
 *
 * `resolveRecipientPolicy` returns `any` only when the build has reached F6 **and**
 * `SEND_EXTERNAL_RECIPIENTS_ENABLED` is set. Neither alone is enough, and neither
 * happens by accident: the stage is a source constant that only a reviewed commit
 * changes, and the flag is an operator action taken with the pilot in front of them.
 * This mirrors `resolveSendingEnabled` on purpose — the same two-factor shape, one
 * level in.
 *
 * A stage that has not reached F6 ignores the flag entirely. Setting
 * `SEND_EXTERNAL_RECIPIENTS_ENABLED=true` today does nothing at all, which is the
 * property that makes it safe for the variable to exist before it is wanted.
 */

export type RecipientPolicy =
  | { mode: 'owned_only'; ownedInboxes: string[] }
  | { mode: 'any' }

export function resolveRecipientPolicy(opts: {
  stage?: Milestone
  externalRecipientsEnabled: boolean
  ownedInboxes: string[]
}): RecipientPolicy {
  const stage = opts.stage ?? MILESTONE_STAGE
  if (isAtOrAfter(stage, 'F6') && opts.externalRecipientsEnabled) return { mode: 'any' }
  return { mode: 'owned_only', ownedInboxes: opts.ownedInboxes }
}

export type RecipientVerdict =
  | { allowed: true }
  | { allowed: false; reason: ReasonCodeValue; detail: string }

/**
 * Splits a normalized address into the part before any `+` tag and its domain.
 *
 * Plus-tagging is the only folding applied here, and only in one direction: an
 * allowlist entry written WITHOUT a tag matches any tagged variant of itself, because
 * `aryamanj250+f5a@gmail.com` and `aryamanj250+f5b@gmail.com` are delivered to the
 * mailbox `aryamanj250@gmail.com` — they are not merely similar addresses, they are
 * the same inbox, which is precisely what "owned" means here. It also means adding a
 * `+f5d` test recipient is not a config change, so nobody is tempted to widen the
 * allowlist to get a test to run.
 *
 * Gmail's dot folding (`a.b@` == `ab@`) is deliberately NOT applied. It is
 * provider-specific trivia rather than a convention, and `normalizeEmail`'s own
 * reasoning — that collapsing addresses a provider treats as distinct is
 * unrecoverable once done — applies with more force to a rule that would let
 * `in.fo@company.com` match an entry for `info@company.com`.
 *
 * The folding is one-directional by construction: an entry that HAS a tag is matched
 * literally, so `ops+alerts@example.com` on the list never admits `ops@example.com`.
 */
function baseAddress(normalized: string): { base: string; domain: string } | null {
  const at = normalized.lastIndexOf('@')
  if (at <= 0 || at === normalized.length - 1) return null
  const local = normalized.slice(0, at)
  const domain = normalized.slice(at + 1)
  const plus = local.indexOf('+')
  return { base: plus === -1 ? local : local.slice(0, plus), domain }
}

export function isOwnedInbox(email: string, ownedInboxes: string[]): boolean {
  const candidate = normalizeEmail(email)
  if (candidate === '') return false
  const parts = baseAddress(candidate)

  for (const raw of ownedInboxes) {
    const entry = normalizeEmail(raw)
    if (entry === '') continue
    if (candidate === entry) return true

    // An untagged entry admits tagged variants of itself; a tagged entry does not.
    if (entry.includes('+')) continue
    const entryParts = baseAddress(entry)
    if (!parts || !entryParts) continue
    if (parts.base === entryParts.base && parts.domain === entryParts.domain) return true
  }
  return false
}

/**
 * The check the send gate runs, inside the same transaction as the other nine.
 *
 * Fails closed in every direction that matters: an empty allowlist refuses every
 * recipient rather than admitting all of them, and an unparseable address is refused
 * rather than passed through to the provider to interpret.
 */
export function checkRecipient(email: string, policy: RecipientPolicy): RecipientVerdict {
  if (policy.mode === 'any') return { allowed: true }

  if (policy.ownedInboxes.length === 0) {
    return {
      allowed: false,
      reason: 'recipient_not_owned',
      detail: 'OWNED_INBOXES is empty: at this stage there is no address this build may send to',
    }
  }
  if (isOwnedInbox(email, policy.ownedInboxes)) return { allowed: true }
  return {
    allowed: false,
    reason: 'recipient_not_owned',
    // The address itself is deliberately recorded here: unlike the executive filter
    // (F4 §11.2), where keeping the address would be keeping exactly what §1.1 says
    // not to keep, this refusal is about a recipient the operator already curated and
    // can see in `contact`. Knowing WHICH draft was stopped is the point of the row.
    detail: `${normalizeEmail(email)} is not an owned inbox`,
  }
}
