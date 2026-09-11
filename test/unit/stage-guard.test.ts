import { describe, expect, it } from 'vitest'
import {
  MILESTONE_STAGE,
  SENDING_UNLOCKED_AT,
  isAtOrAfter,
  stageAllowsSending,
} from '../../src/core/config/stage.js'
import { resolveSendingEnabled } from '../../src/core/config/config.js'

/**
 * Part F: "Live sending requires an explicit env flag that F0-F4 cannot set."
 *
 * An env-only guard does not satisfy that sentence — an operator, a stray .env, or
 * a mis-set CI variable can flip an env var. The build stage is the second factor,
 * and it changes only in a reviewed commit.
 *
 * ## What changed at F5, and what did not
 *
 * Two of these tests used to assert that the SHIPPED stage was below F5. That is no
 * longer true and the assertions were rewritten rather than deleted — F5 is the
 * milestone that unlocks sending, so a test asserting it cannot send was always going
 * to have to change here, and the honest replacement is the property that still holds:
 * **both factors are still required**, and the stage alone still sends nothing.
 *
 * The guard that replaces the stage guard is not in this file. At F5 the send gate
 * refuses every recipient that is not on `OWNED_INBOXES`, and lifting that needs the
 * F6 stage AND a second env flag — see `test/policy/owned-inbox.test.ts`. Part F's F5
 * deliverable is "verified sends to owned inboxes only"; F6 is "enable sending".
 */
describe('sending needs two independent factors', () => {
  it('has reached the sending milestone', () => {
    expect(isAtOrAfter(MILESTONE_STAGE, SENDING_UNLOCKED_AT)).toBe(true)
  })

  it('still refuses when the env flag is unset, whatever the stage says', () => {
    // The factor the stage bump did NOT remove. An operator has to say yes as well.
    const decision = resolveSendingEnabled({ envFlag: false })
    expect(decision).toEqual({ enabled: false, reason: 'sending_disabled' })
  })

  it('refuses at F4, the last milestone before send readiness', () => {
    expect(resolveSendingEnabled({ envFlag: true, stage: 'F4' })).toEqual({
      enabled: false,
      reason: 'sending_disabled',
    })
  })

  it('requires BOTH factors once the build reaches F5', () => {
    expect(resolveSendingEnabled({ envFlag: false, stage: 'F5' })).toEqual({
      enabled: false,
      reason: 'sending_disabled',
    })
    expect(resolveSendingEnabled({ envFlag: true, stage: 'F5' })).toEqual({ enabled: true })
  })

  it('agrees with the stage predicate', () => {
    expect(stageAllowsSending('F4')).toBe(false)
    expect(stageAllowsSending('F5')).toBe(true)
    expect(stageAllowsSending('F6')).toBe(true)
  })
})
