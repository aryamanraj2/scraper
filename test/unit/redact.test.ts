import { afterEach, describe, expect, it } from 'vitest'
import {
  clearRegisteredSecrets,
  redact,
  registerSecretValue,
  REDACTION_PLACEHOLDER,
} from '../../src/core/logging/redact.js'
import { Logger, type LogRecord } from '../../src/core/logging/logger.js'

afterEach(() => clearRegisteredSecrets())

describe('redaction', () => {
  it('masks a registered secret wherever it appears', () => {
    const secret = 'super-secret-refresh-token-value'
    registerSecretValue(secret)
    const out = JSON.stringify(
      redact({ note: `token is ${secret}`, nested: { list: [secret] } }),
    )
    expect(out).not.toContain(secret)
    expect(out).toContain(REDACTION_PLACEHOLDER)
  })

  it('masks credential shapes that never passed through our own code', () => {
    const cases = [
      'Authorization: Bearer abcdef1234567890abcdef',
      'refresh 1//0abcdefghijklmnopqrstuvwxyz123456',
      'AIzaSyA1234567890123456789012345678901234',
      'sk-ant-api03-abcdefghijklmnop',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    ]
    for (const value of cases) {
      const out = String(redact(value))
      expect(out, `not masked: ${value}`).toContain(REDACTION_PLACEHOLDER)
    }
  })

  it('keeps a DSN diagnosable while removing the password', () => {
    const out = String(redact('postgresql://app:hunter2secret@db.internal:5432/outreach'))
    expect(out).not.toContain('hunter2secret')
    expect(out).toContain('postgresql://app:')
  })

  it('masks by key name regardless of value shape', () => {
    const out = redact({ refreshToken: 'plainlooking', apiKey: 'x', nested: { password: 'y' } }) as Record<string, unknown>
    expect(out.refreshToken).toBe(REDACTION_PLACEHOLDER)
    expect(out.apiKey).toBe(REDACTION_PLACEHOLDER)
    expect((out.nested as Record<string, unknown>).password).toBe(REDACTION_PLACEHOLDER)
  })

  it('redacts Error messages and stacks, which is how secrets usually escape', () => {
    const secret = 'kek-material-should-never-print'
    registerSecretValue(secret)
    const err = new Error(`failed to unseal with ${secret}`)
    const out = JSON.stringify(redact(err))
    expect(out).not.toContain(secret)
  })

  it('never prints raw bytes — sealed material is summarized, not serialized', () => {
    // Ciphertext is not itself a secret, but printing key material or IVs as text
    // is how a "harmless" debug line becomes a leak. Buffers become a length.
    expect(redact(Buffer.from('deadbeef', 'hex'))).toBe('[bytes:4]')
    const out = redact({ ciphertext: Buffer.from('deadbeef', 'hex'), dekCiphertext: Buffer.from('00', 'hex') }) as Record<string, unknown>
    expect(out.ciphertext).toBe('[bytes:4]')
    // Key-material names are masked outright, ahead of any shape check.
    expect(out.dekCiphertext).toBe(REDACTION_PLACEHOLDER)
  })

  it('survives circular structures', () => {
    const a: Record<string, unknown> = { name: 'a' }
    a.self = a
    expect(() => redact(a)).not.toThrow()
  })

  it('applies at the log sink, so a call site cannot forget', () => {
    const secret = 'another-registered-secret-value'
    registerSecretValue(secret)
    const records: LogRecord[] = []
    const log = new Logger((r) => records.push(r))
    log.info(`leaking ${secret}`, { extra: secret })
    const serialized = JSON.stringify(records)
    expect(serialized).not.toContain(secret)
  })
})
