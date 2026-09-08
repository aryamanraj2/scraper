import { KEK_BYTE_LENGTH, type KeyProvider } from './key-provider.js'

/**
 * Tests and CI only.
 *
 * The suite must never read or write the operator's real keychain, and it must
 * never be possible to fall back to this provider in a real run — so the guard is
 * here, in the provider, not in the caller.
 */
export class EnvKeyProvider implements KeyProvider {
  readonly name = 'env'

  constructor(
    private readonly base64Key: string,
    private readonly keyVersion = 1,
    nodeEnv: string | undefined = process.env.NODE_ENV,
  ) {
    if (nodeEnv !== 'test') {
      throw new Error('EnvKeyProvider is refused outside NODE_ENV=test. Use KeychainKeyProvider.')
    }
  }

  getKeyVersion(): number {
    return this.keyVersion
  }

  async getKek(): Promise<Buffer> {
    const key = Buffer.from(this.base64Key, 'base64')
    if (key.length !== KEK_BYTE_LENGTH) {
      throw new Error(`KEK must decode to ${KEK_BYTE_LENGTH} bytes, got ${key.length}.`)
    }
    return key
  }
}
