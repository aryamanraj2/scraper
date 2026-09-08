import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ENVELOPE_ALG, open, seal } from '../../src/core/crypto/envelope.js'

describe('envelope encryption', () => {
  const kek = randomBytes(32)

  it('round-trips a value', () => {
    const plaintext = 'a-refresh-token-that-must-never-be-stored-in-plaintext'
    const sealed = seal(kek, Buffer.from(plaintext, 'utf8'))
    expect(open(kek, sealed).toString('utf8')).toBe(plaintext)
    expect(sealed.alg).toBe(ENVELOPE_ALG)
  })

  it('never leaves the plaintext recoverable from the ciphertext alone', () => {
    const plaintext = 'sentinel-plaintext-value'
    const sealed = seal(kek, Buffer.from(plaintext, 'utf8'))
    expect(sealed.ciphertext.toString('utf8')).not.toContain('sentinel')
    expect(sealed.ciphertext.toString('hex')).not.toContain(
      Buffer.from(plaintext).toString('hex'),
    )
  })

  it('uses a fresh data key per record, so two identical values differ on disk', () => {
    const a = seal(kek, Buffer.from('same'))
    const b = seal(kek, Buffer.from('same'))
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false)
    expect(a.dekCiphertext.equals(b.dekCiphertext)).toBe(false)
  })

  it('refuses a wrong key rather than returning a wrong answer', () => {
    const sealed = seal(kek, Buffer.from('value'))
    expect(() => open(randomBytes(32), sealed)).toThrow()
  })

  it('detects tampering with stored ciphertext', () => {
    const sealed = seal(kek, Buffer.from('value'))
    const tampered = { ...sealed, ciphertext: Buffer.from(sealed.ciphertext) }
    tampered.ciphertext[0] = (tampered.ciphertext[0] ?? 0) ^ 0xff
    expect(() => open(kek, tampered)).toThrow()
  })

  it('detects tampering with the wrapped data key', () => {
    const sealed = seal(kek, Buffer.from('value'))
    const tampered = { ...sealed, dekCiphertext: Buffer.from(sealed.dekCiphertext) }
    tampered.dekCiphertext[0] = (tampered.dekCiphertext[0] ?? 0) ^ 0xff
    expect(() => open(kek, tampered)).toThrow()
  })
})
