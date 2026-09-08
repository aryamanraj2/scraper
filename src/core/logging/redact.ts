/**
 * A5, restated: no plaintext credential in the database, and no credential may
 * ever enter an LLM prompt or a log line.
 *
 * Two layers, because either alone is escapable:
 *
 *   1. A registry of exact secret VALUES. Anything handed to the secret store, or
 *      read back out of it, is registered here and masked wherever it appears —
 *      including inside a JSON blob, an error message, or a stack trace.
 *   2. Pattern matching for credential SHAPES that never passed through our own
 *      code (a token pasted into a note, a bearer header echoed by a provider).
 *
 * Redaction is applied at the sink, not at each call site, so forgetting to
 * redact is not possible: the logger and the audit writer both run everything
 * through `redact` on the way out.
 */

const REDACTED = '[REDACTED]'

/** Exact values known to be secret. Never iterated into any output. */
const registeredSecrets = new Set<string>()

/** Values shorter than this are too collision-prone to mask globally. */
const MIN_REGISTERABLE_LENGTH = 8

export function registerSecretValue(value: string): void {
  if (value.length >= MIN_REGISTERABLE_LENGTH) registeredSecrets.add(value)
}

export function unregisterSecretValue(value: string): void {
  registeredSecrets.delete(value)
}

/** Test seam. */
export function clearRegisteredSecrets(): void {
  registeredSecrets.clear()
}

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'authorization-header', re: /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi },
  { name: 'google-oauth-refresh', re: /\b1\/\/[A-Za-z0-9_-]{20,}/g },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35,}/g },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9]{32,}/g },
  { name: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: 'postgres-url-password', re: /(postgres(?:ql)?:\/\/[^:@\s/]+:)[^@\s]+@/gi },
]

/** Keys whose value is masked wholesale regardless of shape. */
const SENSITIVE_KEY_RE =
  /(password|passwd|secret|token|api[_-]?key|apikey|authorization|auth|credential|refresh|cookie|session|kek|dek|private[_-]?key|salt|hmac)/i

function redactString(input: string): string {
  let out = input
  for (const value of registeredSecrets) {
    if (value && out.includes(value)) out = out.split(value).join(REDACTED)
  }
  for (const { re } of SECRET_PATTERNS) {
    out = out.replace(re, (match, ...groups) => {
      // Patterns with a capture group keep the non-secret prefix (e.g. the DSN
      // user), so a redacted line is still diagnosable.
      const prefix = typeof groups[0] === 'string' ? groups[0] : ''
      return prefix ? `${prefix}${REDACTED}@` : REDACTED
    })
  }
  return out
}

/**
 * Deep-redacts any value. Handles cycles, Errors (message + stack), Buffers, Maps
 * and Sets. Returns a structurally-similar value safe to write to a log sink or an
 * AuditLog.metadata column.
 */
export function redact<T>(value: T, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return redactString(value)
  if (value === null || value === undefined) return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value
  }
  if (typeof value === 'function' || typeof value === 'symbol') return '[unserializable]'

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
      cause: value.cause === undefined ? undefined : redact(value.cause, seen),
    }
  }
  if (value instanceof Date) return value.toISOString()
  // Buffers are how sealed ciphertext moves around. Never print the bytes.
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `[bytes:${value.byteLength}]`
  }

  if (typeof value === 'object') {
    const obj = value as object
    if (seen.has(obj)) return '[circular]'
    seen.add(obj)

    if (Array.isArray(value)) return value.map((v) => redact(v, seen))
    if (value instanceof Map) {
      return Object.fromEntries(
        [...value.entries()].map(([k, v]) => [
          String(k),
          SENSITIVE_KEY_RE.test(String(k)) ? REDACTED : redact(v, seen),
        ]),
      )
    }
    if (value instanceof Set) return [...value].map((v) => redact(v, seen))

    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? REDACTED : redact(v, seen)
    }
    return out
  }
  return '[unserializable]'
}

export const REDACTION_PLACEHOLDER = REDACTED
