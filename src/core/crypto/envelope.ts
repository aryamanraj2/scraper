import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * Envelope encryption (A5).
 *
 * The plaintext is sealed under a per-record data key; the data key is itself
 * sealed under the key-encryption key. Only ciphertext, IVs, auth tags and a key
 * version reach Postgres, so a database dump — or a Postgres backup that leaves
 * the machine — contains nothing usable without the keychain.
 *
 * AES-256-GCM throughout: the auth tag makes tampering with stored ciphertext a
 * decryption failure rather than a silent wrong answer.
 */
export const ENVELOPE_ALG = 'aes-256-gcm'
const IV_BYTES = 12
const DEK_BYTES = 32

export type Sealed = {
  ciphertext: Buffer
  iv: Buffer
  authTag: Buffer
}

export type SealedEnvelope = Sealed & {
  dekCiphertext: Buffer
  dekIv: Buffer
  dekAuthTag: Buffer
  alg: string
}

function sealWith(key: Buffer, plaintext: Buffer): Sealed {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ENVELOPE_ALG, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return { ciphertext, iv, authTag: cipher.getAuthTag() }
}

function openWith(key: Buffer, sealed: Sealed): Buffer {
  const decipher = createDecipheriv(ENVELOPE_ALG, key, sealed.iv)
  decipher.setAuthTag(sealed.authTag)
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()])
}

export function seal(kek: Buffer, plaintext: Buffer): SealedEnvelope {
  const dek = randomBytes(DEK_BYTES)
  try {
    const payload = sealWith(dek, plaintext)
    const wrappedDek = sealWith(kek, dek)
    return {
      ...payload,
      dekCiphertext: wrappedDek.ciphertext,
      dekIv: wrappedDek.iv,
      dekAuthTag: wrappedDek.authTag,
      alg: ENVELOPE_ALG,
    }
  } finally {
    // The data key has no reason to outlive this call.
    dek.fill(0)
  }
}

export function open(kek: Buffer, envelope: SealedEnvelope): Buffer {
  const dek = openWith(kek, {
    ciphertext: envelope.dekCiphertext,
    iv: envelope.dekIv,
    authTag: envelope.dekAuthTag,
  })
  try {
    return openWith(dek, {
      ciphertext: envelope.ciphertext,
      iv: envelope.iv,
      authTag: envelope.authTag,
    })
  } finally {
    dek.fill(0)
  }
}
