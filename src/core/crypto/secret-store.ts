import { createHmac } from 'node:crypto'
import type { Db } from '../audit/audit-log.js'
import { writeAudit } from '../audit/audit-log.js'
import { registerSecretValue } from '../logging/redact.js'
import { open, seal, type SealedEnvelope } from './envelope.js'
import type { KeyProvider } from './key-provider.js'

/**
 * A5: no plaintext credential in the database, and no credential may ever enter
 * an LLM prompt or a log line.
 *
 * Every value that passes through here is registered with the redactor, so if it
 * later surfaces in an error message, a stack trace, or an audit metadata blob, it
 * is masked at the sink. That covers the case the naive design misses: the secret
 * leaking through code that never knew it was handling a secret.
 *
 * Audit rows record that a secret was read or written, and by whom — never the
 * value, and never a prefix of it.
 */
export class SecretStore {
  constructor(
    private readonly db: Db,
    private readonly keyProvider: KeyProvider,
  ) {}

  /**
   * Throws unless this store could seal a value right now.
   *
   * For callers whose next step consumes something single-use — an OAuth consent code
   * is the case that motivated it — so that a missing KEK is reported before the
   * resource is spent rather than after. Reads the key and discards it; it writes
   * nothing and touches no row.
   */
  async assertWritable(): Promise<void> {
    await this.keyProvider.getKek()
  }

  async put(name: string, plaintext: string, actorId = 'system'): Promise<void> {
    const kek = await this.keyProvider.getKek()
    const envelope = seal(kek, Buffer.from(plaintext, 'utf8'))
    registerSecretValue(plaintext)

    // Prisma's Bytes columns are Uint8Array<ArrayBuffer>; Node Buffers are
    // Buffer<ArrayBufferLike>. Uint8Array.from copies into a plain ArrayBuffer.
    const data = {
      alg: envelope.alg,
      keyVersion: this.keyProvider.getKeyVersion(),
      ciphertext: Uint8Array.from(envelope.ciphertext),
      iv: Uint8Array.from(envelope.iv),
      authTag: Uint8Array.from(envelope.authTag),
      dekCiphertext: Uint8Array.from(envelope.dekCiphertext),
      dekIv: Uint8Array.from(envelope.dekIv),
      dekAuthTag: Uint8Array.from(envelope.dekAuthTag),
    }

    await this.db.secretRecord.upsert({
      where: { name },
      create: { name, ...data },
      update: data,
    })

    await writeAudit(this.db, {
      actorType: 'system',
      actorId,
      action: 'secret.put',
      subjectType: 'SecretRecord',
      subjectId: name,
      metadata: { keyProvider: this.keyProvider.name, alg: envelope.alg },
    })
  }

  async get(name: string, actorId = 'system'): Promise<string | null> {
    const row = await this.db.secretRecord.findUnique({ where: { name } })
    if (!row) return null

    const kek = await this.keyProvider.getKek()
    const envelope: SealedEnvelope = {
      ciphertext: Buffer.from(row.ciphertext),
      iv: Buffer.from(row.iv),
      authTag: Buffer.from(row.authTag),
      dekCiphertext: Buffer.from(row.dekCiphertext),
      dekIv: Buffer.from(row.dekIv),
      dekAuthTag: Buffer.from(row.dekAuthTag),
      alg: row.alg,
    }
    const plaintext = open(kek, envelope).toString('utf8')
    registerSecretValue(plaintext)

    await writeAudit(this.db, {
      actorType: 'system',
      actorId,
      action: 'secret.get',
      subjectType: 'SecretRecord',
      subjectId: name,
      metadata: { keyProvider: this.keyProvider.name, keyVersion: row.keyVersion },
    })
    return plaintext
  }

  /**
   * Re-seals every record under the current KEK and key version. Used after a key
   * rotation in the keychain; the data keys are regenerated too, so a compromised
   * DEK does not survive rotation.
   */
  async rotate(actorId = 'system'): Promise<number> {
    const rows = await this.db.secretRecord.findMany({ select: { name: true } })
    for (const { name } of rows) {
      const plaintext = await this.get(name, actorId)
      if (plaintext !== null) await this.put(name, plaintext, actorId)
    }
    return rows.length
  }

  async delete(name: string, actorId = 'system'): Promise<void> {
    await this.db.secretRecord.deleteMany({ where: { name } })
    await writeAudit(this.db, {
      actorType: 'system',
      actorId,
      action: 'secret.delete',
      subjectType: 'SecretRecord',
      subjectId: name,
    })
  }
}

/**
 * A10: Suppression stores a salted HMAC of the normalized email, never plaintext,
 * and the row is retained after the Contact is erased. Deleting a person who asked
 * to be forgotten must not destroy the evidence that stops us contacting them next
 * cycle.
 *
 * Normalization is intentionally conservative — lowercase and trim only. Gmail-style
 * dot and +tag folding is NOT applied: collapsing two addresses that the recipient's
 * provider treats as distinct would suppress mail the recipient never asked us to
 * stop, and un-collapsing later is impossible once the plaintext is gone.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function emailHmac(email: string, salt: string): string {
  return createHmac('sha256', salt).update(normalizeEmail(email)).digest('hex')
}

export function domainOf(email: string): string {
  const at = normalizeEmail(email).lastIndexOf('@')
  return at === -1 ? '' : normalizeEmail(email).slice(at + 1)
}
