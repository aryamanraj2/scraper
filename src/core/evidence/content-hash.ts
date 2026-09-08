import { createHash } from 'node:crypto'

/**
 * `Evidence.contentHash` exists for "change detection without refetch" (D5), and
 * F2 turns it into `content_unchanged` and the week-over-week ATS job-count delta
 * (B2). Both only work if the hash is STABLE across runs — which is why this
 * hashes a canonical form of the values we persist rather than the raw response
 * bytes.
 *
 * Raw bytes are the wrong input: JSON key order, whitespace, and volatile fields
 * (view counts, cache-busting URLs, a `last_updated` stamp that moves on every
 * publish) all change without the facts changing. Hashing those produces a change
 * signal that is pure noise, and noise in this hash makes every downstream
 * freshness decision unreliable.
 *
 * Canonical form: object keys sorted lexicographically at every depth, array order
 * preserved (order is meaningful in a postings list), `undefined` dropped, dates
 * as ISO strings.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value === 'object') {
    const src = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(src).sort()) {
      if (src[key] === undefined) continue
      out[key] = canonicalize(src[key])
    }
    return out
  }
  return value
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/** sha256 over the canonical JSON form. The stable identity of a fetched fact. */
export function contentHashOf(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}
