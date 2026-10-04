import type { Db } from '../../core/audit/audit-log.js'
import { writeAudit } from '../../core/audit/audit-log.js'
import { MAX_EXCERPT_CHARS } from '../../core/evidence/write-evidence.js'
import { parseCsv } from '../../ingest/file/csv.js'
import { normalizeEmail } from './classify.js'
import { isExecutiveContact } from './executive-filter.js'
import { CONTACT_IMPORT_COLUMNS, providerAttestsDeliverable } from './import.js'

/**
 * The F6 verification backfill — `docs/F6-DECISIONS.md` §3.1.
 *
 * Every `lookup_provider` contact imported before F6 landed `verified = false`, because
 * the importer never read the `email_status` column. The verdict was not lost: the
 * importer stores the operator's CSV line verbatim as the Evidence excerpt, and the
 * verdict is the last field of that line. So this reads data already in the database —
 * no CSV, no re-import, no network — and flips exactly the rows whose provider said
 * `valid`, through {@link providerAttestsDeliverable}, the same rule the importer now
 * applies on the way in.
 *
 * ## Why the project's CSV parser, and why the email cross-check
 *
 * `notes` and `title` routinely contain quoted commas (`"Tech Lead, Mechanical
 * Engineering"`), and a `split(',')` would read the wrong column as the verdict. That
 * misreading would not throw; it would quietly verify somebody. So the excerpt is parsed
 * with `src/ingest/file/csv.ts` against the import header, and then the parsed `email`
 * cell must equal the contact's own address — if it does not, the columns are not where
 * we think they are and nothing about that row is trusted.
 *
 * A truncated excerpt is refused for the same reason: `verbatimExcerpt` keeps a prefix
 * at the column limit, and the verdict is the field a prefix loses first.
 *
 * ## What it writes
 *
 * `Contact.verified = true` and one `audit_log` row per flip naming the contact, the
 * evidence id and the verbatim token. **No second Evidence row**: the existing one
 * already holds the verdict verbatim under its `operator-entry://` source, and a copy
 * would be a second provenance record for one fact. A dry run writes nothing at all,
 * audit rows included — the importer's rule.
 *
 * ## The executive filter runs again, first
 *
 * These rows passed `isExecutiveContact` at import, but F6 widened its "head of" rule
 * after a provider export wrote "Head -Talent Acquisition". Verifying a contact is the
 * step that lets a draft reach them, so the filter as it stands TODAY decides, not the
 * filter as it stood when the row arrived. A refused row is never flipped; on `--write`
 * it is set `retired` with an audit row naming the rule. Its address is not put in the
 * audit row, for `import.ts`'s reason: §1.1 says never target them.
 */

/** The header the importer's rows were written under, verdict column last. */
const EXCERPT_HEADER = CONTACT_IMPORT_COLUMNS.join(',')

export const BACKFILL_ACTION = 'contact.verified_by_provider'
export const RETIRE_ACTION = 'contact.retired_executive'

export type VerdictReading =
  | { ok: true; verdict: string }
  | { ok: false; reason: 'not_operator_entry' | 'truncated' | 'unparseable' | 'email_mismatch' }

export type ImportedRowReading =
  | { ok: true; cells: Record<string, string | undefined> }
  | { ok: false; reason: 'not_operator_entry' | 'truncated' | 'unparseable' | 'email_mismatch' }

/**
 * Pure. Parses one stored import line back into its columns.
 *
 * The importer stored the operator's CSV line verbatim as the contact's Evidence
 * excerpt, so every column the operator supplied is recoverable from the database
 * without the CSV. Parsed with the project's own CSV parser because names, titles and
 * notes carry quoted commas that `split(',')` would misread.
 */
export function readImportedRow(input: {
  excerpt: string
  sourceUrl: string
  emailNormalized: string
}): ImportedRowReading {
  // Only rows the importer wrote. Any other Evidence row is a page or a feed, and its
  // comma-separated tokens mean nothing.
  if (!input.sourceUrl.startsWith('operator-entry://')) return { ok: false, reason: 'not_operator_entry' }
  if (input.excerpt.length >= MAX_EXCERPT_CHARS) return { ok: false, reason: 'truncated' }

  const parsed = parseCsv(`${EXCERPT_HEADER}\n${input.excerpt}`)
  const row = parsed.rows[0]
  if (parsed.rows.length !== 1 || parsed.malformed.length !== 0 || !row) {
    return { ok: false, reason: 'unparseable' }
  }
  // The line must be about THIS contact, or every field read from it is someone else's.
  const email = row.cells['email']
  if (email === undefined || normalizeEmail(email) !== input.emailNormalized) {
    return { ok: false, reason: 'email_mismatch' }
  }
  return { ok: true, cells: row.cells }
}

/** Pure. Reads the provider verdict out of one stored import line. */
export function readProviderVerdict(input: {
  excerpt: string
  sourceUrl: string
  emailNormalized: string
}): VerdictReading {
  const row = readImportedRow(input)
  if (!row.ok) return row
  return { ok: true, verdict: row.cells['email_status'] ?? '' }
}

/** `operator-entry://<provider>/<operator>` → provider, for per-provider reporting. */
export function providerOf(sourceUrl: string): string {
  const rest = sourceUrl.slice('operator-entry://'.length)
  return decodeURIComponent(rest.split('/')[0] ?? '') || 'unknown'
}

export type BackfillRow = {
  contactId: string
  email: string
  title: string | null
  companyName: string
  provider: string
  /** The verbatim verdict token, or the reason it could not be read. */
  verdict: string
  flip: boolean
}

export type BackfillResult = {
  rows: BackfillRow[]
  /** provider → verdict token → count. A blank verdict is reported as `(blank)`. */
  byProvider: Record<string, Record<string, number>>
  flips: number
  /** Rows the executive filter refuses; retired on `--write`, never verified. */
  executives: number
  dryRun: boolean
}

export async function backfillProviderVerification(
  db: Db,
  opts: { operator: string; dryRun?: boolean },
): Promise<BackfillResult> {
  const dryRun = opts.dryRun !== false
  const contacts = await db.contact.findMany({
    where: { discoveryMethod: 'lookup_provider', verified: false, status: 'active' },
    select: {
      id: true,
      emailNormalized: true,
      publicTitle: true,
      evidenceId: true,
      company: { select: { displayName: true } },
    },
    orderBy: { id: 'asc' },
  })
  const evidence = new Map(
    (
      await db.evidence.findMany({
        where: { id: { in: contacts.map((c) => c.evidenceId) } },
        select: { id: true, excerpt: true, sourceUrl: true },
      })
    ).map((e) => [e.id, e]),
  )

  const rows: BackfillRow[] = []
  const byProvider: BackfillResult['byProvider'] = {}

  for (const c of contacts) {
    const e = evidence.get(c.evidenceId)
    const reading = e
      ? readProviderVerdict({ excerpt: e.excerpt, sourceUrl: e.sourceUrl, emailNormalized: c.emailNormalized })
      : ({ ok: false, reason: 'unparseable' } as const)
    const provider = e ? providerOf(e.sourceUrl) : 'unknown'
    const exec = isExecutiveContact(c.emailNormalized, c.publicTitle)
    const verdict = exec.isExecutive
      ? 'REFUSED:executive'
      : reading.ok
        ? reading.verdict
        : `REFUSED:${reading.reason}`
    const flip = !exec.isExecutive && reading.ok && providerAttestsDeliverable(reading.verdict)

    const tally = (byProvider[provider] ??= {})
    const key = verdict === '' ? '(blank)' : verdict
    tally[key] = (tally[key] ?? 0) + 1

    rows.push({
      contactId: c.id,
      email: c.emailNormalized,
      title: c.publicTitle,
      companyName: c.company.displayName,
      provider,
      verdict,
      flip,
    })

    if (exec.isExecutive && !dryRun) {
      await db.$transaction(async (tx) => {
        const updated = await tx.contact.updateMany({ where: { id: c.id, status: 'active' }, data: { status: 'retired' } })
        if (updated.count !== 1) return
        await writeAudit(tx, {
          actorType: 'user',
          actorId: opts.operator,
          action: RETIRE_ACTION,
          subjectType: 'Contact',
          subjectId: c.id,
          reasonCode: 'executive_only_contact',
          metadata: { matched: exec.matched, where: exec.where, rule: 'executive-filter HEAD_OF_FUNCTION (widened F6)' },
        })
      })
      continue
    }
    if (!flip || dryRun) continue
    // Conditional update, so a concurrent run or a re-run flips nothing twice and
    // writes no second audit row for a flip it did not make.
    await db.$transaction(async (tx) => {
      const updated = await tx.contact.updateMany({
        where: { id: c.id, verified: false },
        data: { verified: true },
      })
      if (updated.count !== 1) return
      await writeAudit(tx, {
        actorType: 'user',
        actorId: opts.operator,
        action: BACKFILL_ACTION,
        subjectType: 'Contact',
        subjectId: c.id,
        // `verdict`, not `verdictToken`: the sink-side redactor masks any key containing
        // "token", which would destroy the one value this row exists to record.
        metadata: { evidenceId: c.evidenceId, provider, verdict: reading.ok ? reading.verdict : null },
      })
    })
  }

  return {
    rows,
    byProvider,
    flips: rows.filter((r) => r.flip).length,
    executives: rows.filter((r) => r.verdict === 'REFUSED:executive').length,
    dryRun,
  }
}
