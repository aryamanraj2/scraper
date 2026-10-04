import { readImportedRow } from '../contacts/verify-backfill.js'

/**
 * The recipient's first name for "Hi <name>,", or null for "Hi there,".
 *
 * F6 step 3b: the name comes from the `full_name` column of the operator's import line,
 * which the importer stored verbatim as the contact's Evidence excerpt. Nothing is
 * inferred. A role inbox has no name, a page-published contact has no import line, and
 * a stored name that does not start with a plain word (an initial, a title, a stray
 * symbol) gets "Hi there," rather than a guess at what the person is called.
 */
export function recipientFirstName(contact: {
  contactType: string
  emailNormalized: string
  evidence: { excerpt: string; sourceUrl: string } | null
}): string | null {
  if (!contact.contactType.startsWith('named') || !contact.evidence) return null
  const row = readImportedRow({ ...contact.evidence, emailNormalized: contact.emailNormalized })
  if (!row.ok) return null
  const first = (row.cells['full_name'] ?? '').trim().split(/\s+/)[0] ?? ''
  // Letters, then letters, hyphens or apostrophes. "Dr.", "J." and "" all fail.
  return /^\p{Lu}[\p{L}'’-]+$/u.test(first) ? first : null
}
