import { describe, expect, it } from 'vitest'
import {
  checkRecipient,
  isOwnedInbox,
  resolveRecipientPolicy,
} from '../../src/outreach/send/recipient-policy.js'
import { MILESTONE_STAGE } from '../../src/core/config/stage.js'

/**
 * The owned-inbox condition, as red-team attempts.
 *
 * Part F's F5 deliverable is "verified sends to owned inboxes ONLY" and F6's is
 * "enable sending". D6's nine conditions do not encode that difference — every one of
 * them passes for the approved draft in `outreach_dev`, whose recipient is a real
 * third party. This file is the difference.
 */

const OWNED = ['aryamanj250@gmail.com']

describe('resolveRecipientPolicy — lifting the restriction takes two independent acts', () => {
  it('is owned_only at the shipped stage regardless of the flag', () => {
    const withFlag = resolveRecipientPolicy({
      externalRecipientsEnabled: true,
      ownedInboxes: OWNED,
    })
    expect(withFlag.mode).toBe('owned_only')
  })

  it('is owned_only at F5 even with the flag set', () => {
    const policy = resolveRecipientPolicy({
      stage: 'F5',
      externalRecipientsEnabled: true,
      ownedInboxes: OWNED,
    })
    expect(policy.mode).toBe('owned_only')
  })

  it('is owned_only at F6 when the flag is unset', () => {
    const policy = resolveRecipientPolicy({
      stage: 'F6',
      externalRecipientsEnabled: false,
      ownedInboxes: OWNED,
    })
    expect(policy.mode).toBe('owned_only')
  })

  it('lifts only when the stage has reached F6 AND the flag is set', () => {
    const policy = resolveRecipientPolicy({
      stage: 'F6',
      externalRecipientsEnabled: true,
      ownedInboxes: OWNED,
    })
    expect(policy.mode).toBe('any')
  })

  it('the build we ship cannot reach an external recipient by config alone', () => {
    // The whole point, stated as an assertion rather than as prose: no value of the
    // env flag changes the answer at the stage this build actually carries.
    for (const flag of [true, false]) {
      const policy = resolveRecipientPolicy({
        stage: MILESTONE_STAGE,
        externalRecipientsEnabled: flag,
        ownedInboxes: OWNED,
      })
      expect(policy.mode).toBe('owned_only')
    }
  })
})

describe('checkRecipient — fails closed', () => {
  const policy = resolveRecipientPolicy({
    stage: 'F5',
    externalRecipientsEnabled: false,
    ownedInboxes: OWNED,
  })

  it('refuses the real contact sitting in the live corpus', () => {
    // Not a hypothetical address: this is the recipient of the one approved draft.
    const verdict = checkRecipient('info@nanonets.com', policy)
    expect(verdict.allowed).toBe(false)
    if (verdict.allowed) throw new Error('unreachable')
    expect(verdict.reason).toBe('recipient_not_owned')
  })

  it('refuses every recipient when the allowlist is empty', () => {
    const empty = resolveRecipientPolicy({
      stage: 'F5',
      externalRecipientsEnabled: false,
      ownedInboxes: [],
    })
    const verdict = checkRecipient('aryamanj250@gmail.com', empty)
    expect(verdict.allowed).toBe(false)
    if (verdict.allowed) throw new Error('unreachable')
    expect(verdict.detail).toMatch(/empty/)
  })

  it('admits the owned address and its plus-tagged variants', () => {
    for (const owned of [
      'aryamanj250@gmail.com',
      'aryamanj250+f5a@gmail.com',
      'aryamanj250+f5b@gmail.com',
      'aryamanj250+f5c@gmail.com',
      '  ARYAMANJ250+F5A@Gmail.com ',
    ]) {
      expect(checkRecipient(owned, policy).allowed, owned).toBe(true)
    }
  })

  it('does not let a plus tag smuggle in a different mailbox', () => {
    // The tag is in the LOCAL part; changing the base or the domain is a different
    // inbox no matter what follows the plus.
    for (const hostile of [
      'someoneelse+aryamanj250@gmail.com',
      'aryamanj250@gmail.com.evil.test',
      'aryamanj250@notgmail.com',
      'aryamanj2501@gmail.com',
      'info@nanonets.com+aryamanj250@gmail.com',
    ]) {
      expect(checkRecipient(hostile, policy).allowed, hostile).toBe(false)
    }
  })

  it('does not fold Gmail dots, because that rule is provider trivia', () => {
    // Deliberate non-feature, pinned so nobody "fixes" it later: normalizeEmail's
    // own reasoning is that collapsing addresses a provider treats as distinct is
    // unrecoverable, and it applies with more force to a matching rule.
    expect(checkRecipient('aryamanj.250@gmail.com', policy).allowed).toBe(false)
  })

  it('refuses an unparseable address rather than handing it to the provider', () => {
    for (const junk of ['', '   ', 'not-an-address', '@gmail.com', 'aryamanj250@']) {
      expect(checkRecipient(junk, policy).allowed, JSON.stringify(junk)).toBe(false)
    }
  })

  it('a tagged allowlist entry does not admit the untagged base', () => {
    const tagged = resolveRecipientPolicy({
      stage: 'F5',
      externalRecipientsEnabled: false,
      ownedInboxes: ['ops+alerts@example.com'],
    })
    expect(checkRecipient('ops+alerts@example.com', tagged).allowed).toBe(true)
    expect(checkRecipient('ops@example.com', tagged).allowed).toBe(false)
    expect(checkRecipient('ops+other@example.com', tagged).allowed).toBe(false)
  })

  it('isOwnedInbox is the same answer without the policy wrapper', () => {
    expect(isOwnedInbox('aryamanj250+x@gmail.com', OWNED)).toBe(true)
    expect(isOwnedInbox('info@nanonets.com', OWNED)).toBe(false)
    expect(isOwnedInbox('anything@anywhere.test', [])).toBe(false)
  })
})
