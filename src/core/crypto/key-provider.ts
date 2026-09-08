/**
 * A5. The key-encryption key never lives in Postgres and never lives in a file
 * that the repo tracks. Providers are the seam that lets tests run without
 * touching the operator's real keychain.
 */
export interface KeyProvider {
  readonly name: string
  /** Returns the 32-byte key-encryption key. */
  getKek(): Promise<Buffer>
  /** Monotonic version, stamped onto every sealed record so rotation is replayable. */
  getKeyVersion(): number
}

export const KEK_BYTE_LENGTH = 32
