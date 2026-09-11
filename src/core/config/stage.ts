/**
 * Build-stage guard.
 *
 * Part F ships in milestone order and sending stays hard-disabled until F5. The
 * plan's verification note requires that "live sending requires an explicit env
 * flag that F0-F4 cannot set" — so the env flag alone must not be sufficient.
 * This constant is the second factor: it is a source-level value that changes
 * only in a reviewed commit, not an environment variable an operator can flip.
 *
 * Raising this to 'F5' is a deliberate act with its own review. Until then,
 * `resolveSendingEnabled` returns false with reason `sending_disabled` no matter
 * what the environment says.
 */
export const MILESTONE_ORDER = ['F0', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7'] as const

export type Milestone = (typeof MILESTONE_ORDER)[number]

/**
 * The milestone this build has shipped.
 *
 * **Raised to 'F5' in the F5 session, and it is the single most consequential line in
 * this repository.** It unlocks sending — but only sending, and only one factor of it:
 *
 *   - `SENDING_ENABLED` must still be set. `resolveSendingEnabled` needs both, and
 *     `test/unit/stage-guard.test.ts` pins that neither alone is enough.
 *   - The send gate's owned-inbox condition still refuses every recipient that is not
 *     on `OWNED_INBOXES`, at every stage below F6 and at F6 unless
 *     `SEND_EXTERNAL_RECIPIENTS_ENABLED` is also set
 *     (`src/outreach/send/recipient-policy.ts`). Part F's F5 deliverable is "verified
 *     sends to owned inboxes only"; F6 is "enable sending", and they are two acts.
 *
 * So this constant reaching F5 means the machinery is built and proven against owned
 * inboxes. It does not mean the pilot has started.
 */
export const MILESTONE_STAGE: Milestone = 'F5'

/** The first milestone at which external sending may be enabled at all (Part F). */
export const SENDING_UNLOCKED_AT: Milestone = 'F5'

export function milestoneRank(m: Milestone): number {
  return MILESTONE_ORDER.indexOf(m)
}

export function isAtOrAfter(a: Milestone, b: Milestone): boolean {
  return milestoneRank(a) >= milestoneRank(b)
}

/** True only when the build itself has reached the sending milestone. */
export function stageAllowsSending(stage: Milestone = MILESTONE_STAGE): boolean {
  return isAtOrAfter(stage, SENDING_UNLOCKED_AT)
}
