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
 */
describe('sending stays hard-disabled until F5', () => {
  it('is currently building at a pre-send milestone', () => {
    expect(isAtOrAfter(MILESTONE_STAGE, SENDING_UNLOCKED_AT)).toBe(false)
  })

  it('refuses even when the env flag is explicitly true', () => {
    const decision = resolveSendingEnabled({ envFlag: true })
    expect(decision).toEqual({ enabled: false, reason: 'sending_disabled' })
  })

  it('still refuses at F4, the last milestone before send readiness', () => {
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
