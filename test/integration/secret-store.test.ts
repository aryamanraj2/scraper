import { randomBytes } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EnvKeyProvider } from '../../src/core/crypto/env-key-provider.js'
import { KeychainKeyProvider } from '../../src/core/crypto/keychain-key-provider.js'
import { SecretStore, emailHmac, normalizeEmail } from '../../src/core/crypto/secret-store.js'
import { clearRegisteredSecrets } from '../../src/core/logging/redact.js'
import { closeTestDb, testDb, truncateAll } from '../helpers/db.js'

const KEK_B64 = randomBytes(32).toString('base64')

beforeEach(async () => {
  await truncateAll()
  clearRegisteredSecrets()
})
afterAll(async () => closeTestDb())

/**
 * F0 exit criterion: "secrets round-trip without touching logs."
 *
 * A5 as restated by the plan: no plaintext credential in the database, and no
 * credential may ever enter an LLM prompt or a log line.
 */
describe('secret store (A5)', () => {
  const db = () => testDb()
  const store = () => new SecretStore(db(), new EnvKeyProvider(KEK_B64))

  it('round-trips a credential', async () => {
    const secret = 'ya29.a0AfB_refresh_token_material_example'
    await store().put('gmail.refresh_token', secret)
    expect(await store().get('gmail.refresh_token')).toBe(secret)
  })

  it('stores no plaintext — the row contains ciphertext only', async () => {
    const secret = 'sentinel-refresh-token-plaintext'
    await store().put('gmail.refresh_token', secret)

    const row = await db().secretRecord.findUniqueOrThrow({ where: { name: 'gmail.refresh_token' } })
    const asText = Buffer.from(row.ciphertext).toString('utf8')
    const asHex = Buffer.from(row.ciphertext).toString('hex')
    expect(asText).not.toContain('sentinel')
    expect(asHex).not.toContain(Buffer.from(secret).toString('hex'))

    // The model has no plaintext column at all, so there is nothing to write one to.
    expect(Object.keys(row)).not.toContain('value')
    expect(Object.keys(row)).not.toContain('plaintext')
  })

  it('leaves the secret absent from every sink: stdout, stderr, and the audit log', async () => {
    const secret = 'sentinel-secret-for-log-scanning-0xdeadbeef'
    const captured: string[] = []
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      captured.push(String(chunk)); return true
    })
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      captured.push(String(chunk)); return true
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      captured.push(args.map(String).join(' '))
    })

    try {
      await store().put('probe', secret)
      await store().get('probe')
      // A thrown error carrying the secret is the usual leak path.
      try {
        throw new Error(`unseal failed for ${secret}`)
      } catch (err) {
        const { redact } = await import('../../src/core/logging/redact.js')
        captured.push(JSON.stringify(redact(err)))
      }
    } finally {
      outSpy.mockRestore(); errSpy.mockRestore(); logSpy.mockRestore()
    }

    expect(captured.join('\n')).not.toContain(secret)

    const audits = await db().auditLog.findMany()
    expect(audits.length).toBeGreaterThan(0)
    expect(JSON.stringify(audits)).not.toContain(secret)
    expect(audits.map((a) => a.action)).toContain('secret.put')
    expect(audits.map((a) => a.action)).toContain('secret.get')
  })

  it('rotation re-seals every record and the values still read back', async () => {
    await store().put('a', 'value-a')
    await store().put('b', 'value-b')
    const before = await db().secretRecord.findUniqueOrThrow({ where: { name: 'a' } })

    const rotated = await store().rotate()
    expect(rotated).toBe(2)

    const after = await db().secretRecord.findUniqueOrThrow({ where: { name: 'a' } })
    expect(Buffer.from(after.ciphertext).equals(Buffer.from(before.ciphertext))).toBe(false)
    expect(await store().get('a')).toBe('value-a')
    expect(await store().get('b')).toBe('value-b')
  })

  it('returns null for an unknown name rather than inventing one', async () => {
    expect(await store().get('missing')).toBeNull()
  })

  it('refuses the env key provider outside NODE_ENV=test', () => {
    expect(() => new EnvKeyProvider(KEK_B64, 1, 'production')).toThrow(/refused outside NODE_ENV=test/)
  })

  it('the keychain provider is what production uses, and it is not consulted here', () => {
    // Constructing it is inert; the suite must never read the operator's keychain.
    const provider = new KeychainKeyProvider('outreach-intelligence-nonexistent', 'kek')
    expect(provider.name).toBe('keychain')
  })
})

/**
 * A10: suppression must survive PII deletion, so it stores a salted HMAC of the
 * normalized address rather than the address.
 */
describe('suppression hashing (A10)', () => {
  const salt = 'test-salt'

  it('is deterministic and salt-dependent', () => {
    expect(emailHmac('Careers@Example.com', salt)).toBe(emailHmac('careers@example.com', salt))
    expect(emailHmac('careers@example.com', salt)).not.toBe(emailHmac('careers@example.com', 'other'))
  })

  it('does not fold gmail dots or +tags', () => {
    // Collapsing addresses the recipient's provider treats as distinct would
    // suppress mail nobody asked us to stop, and it is irreversible once the
    // plaintext is gone.
    expect(normalizeEmail('a.b+tag@example.com')).toBe('a.b+tag@example.com')
    expect(emailHmac('a.b@example.com', salt)).not.toBe(emailHmac('ab@example.com', salt))
  })

  it('survives deletion of the contact it refers to', async () => {
    await truncateAll()
    const db2 = testDb()
    const company = await db2.company.create({
      data: { canonicalDomain: 'example.com', displayName: 'Example' },
    })
    const evidence = await db2.evidence.create({
      data: {
        companyId: company.id,
        sourceUrl: 'https://example.com/careers',
        sourceType: 'company_page',
        excerpt: 'Email careers@example.com to apply.',
        contentHash: 'hash',
        observedAt: new Date(),
        confidence: 1,
        fetchedVia: 'static_fetch',
      },
    })
    const contact = await db2.contact.create({
      data: {
        companyId: company.id,
        emailNormalized: 'careers@example.com',
        contactType: 'careers_alias',
          discoveryMethod: 'page_published',
          verified: true,
        evidenceId: evidence.id,
        capturedAt: new Date(),
      },
    })
    await db2.suppression.create({
      data: {
        emailHmac: emailHmac('careers@example.com', salt),
        scope: 'contact',
        reasonCode: 'opt_out',
      },
    })

    await db2.contact.delete({ where: { id: contact.id } })

    const survived = await db2.suppression.findFirst({
      where: { emailHmac: emailHmac('careers@example.com', salt) },
    })
    expect(survived).not.toBeNull()
    // And the plaintext address is nowhere in the surviving row.
    expect(JSON.stringify(survived)).not.toContain('careers@example.com')
  })
})
