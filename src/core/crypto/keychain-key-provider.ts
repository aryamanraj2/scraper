import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { KEK_BYTE_LENGTH, type KeyProvider } from './key-provider.js'

const execFileAsync = promisify(execFile)

/**
 * Reads the key-encryption key from the macOS login keychain.
 *
 * Uses the `security` CLI rather than a native binding: no compiled dependency,
 * and the exact command is auditable. In deployment this provider is replaced by
 * a secret-manager provider; nothing else changes.
 *
 * Provision once, by hand:
 *   security add-generic-password -s outreach-intelligence -a kek \
 *     -w "$(openssl rand -base64 32)" -U
 */
export class KeychainKeyProvider implements KeyProvider {
  readonly name = 'keychain'

  constructor(
    private readonly service: string,
    private readonly account: string,
    private readonly keyVersion = 1,
  ) {}

  getKeyVersion(): number {
    return this.keyVersion
  }

  async getKek(): Promise<Buffer> {
    let stdout: string
    try {
      const result = await execFileAsync('security', [
        'find-generic-password',
        '-s', this.service,
        '-a', this.account,
        '-w',
      ])
      stdout = result.stdout
    } catch {
      // Deliberately does not forward the child process output: on some failures
      // `security` echoes surrounding keychain context.
      throw new Error(
        `No keychain item for service="${this.service}" account="${this.account}". ` +
          'Provision it with: security add-generic-password -s ' +
          `${this.service} -a ${this.account} -w "$(openssl rand -base64 32)" -U`,
      )
    }
    const key = Buffer.from(stdout.trim(), 'base64')
    if (key.length !== KEK_BYTE_LENGTH) {
      throw new Error(
        `Keychain KEK must decode to ${KEK_BYTE_LENGTH} bytes, got ${key.length}.`,
      )
    }
    return key
  }
}
