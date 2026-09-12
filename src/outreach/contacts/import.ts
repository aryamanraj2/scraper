import { readFileSync } from 'node:fs'
import type { Prisma } from '../../../generated/prisma/client.js'
import { ContactType } from '../../../generated/prisma/enums.js'
import type { Db } from '../../core/audit/audit-log.js'
import { writeAudit } from '../../core/audit/audit-log.js'
import { contentHashOf } from '../../core/evidence/content-hash.js'
import { FETCHED_VIA, verbatimExcerpt, writeEvidence } from '../../core/evidence/write-evidence.js'
import { canonicalizeDomain } from '../../ingest/domain/canonicalize.js'
import { cell, missingColumns, parseCsv, type CsvRow } from '../../ingest/file/csv.js'
import { classifyLocal, isCompanyDomain, normalizeEmail } from './classify.js'
import { isExecutiveContact } from './executive-filter.js'

/**
 * Operator-entered contacts, gathered by hand from a lookup provider's free tier.
 *
 * ## What this is, in the project's own vocabulary
 *
 * It is **Tier B's data without Tier B's integration**. The operator's F4 amendment
 * permits verified lookup providers behind a provider seam, host allow entry,
 * fixtures and a `verified` flag; none of that exists yet, and this milestone does not
 * build it. What exists is a person reading Apollo's free tier in a browser and typing
 * the results into a CSV. That is not a provider call and must not be recorded as one:
 * no request was made, no vendor terms were accepted by this code, and nothing here
 * proves an address is deliverable.
 *
 * So every row lands as `verified = false`, and an unverified contact opens **no
 * outreach case** (`src/core/policy/outreach-case.ts`). These are candidates for the
 * operator to confirm, not send targets. Importing a thousand of them cannot, by
 * itself, cause a single message to be sent — which is the property that makes the
 * path safe to have at all.
 *
 * ## The three refusals, and why each survives the change of source
 *
 * **Executives.** Every row goes through {@link isExecutiveContact}, exactly as a
 * scraped address does. `handover.md` §1.1 is not amended by anything in this
 * milestone, and the failure mode is specific rather than theoretical: a lookup
 * provider asked for "someone at a 12-person startup" returns the founder, because at
 * a 12-person startup the founder is who it has. The filter reads the local part as
 * well as the title, so `founders@` with no title text is still refused.
 *
 * **Off-domain addresses.** Refused the way `curate.ts` refuses them. A `gmail.com`
 * address is somebody's personal account (§1.2), and an address at another company is
 * somebody else's employee. A provider's export is *more* likely to contain both than
 * a careers page is, not less.
 *
 * **Unknown companies.** A row whose domain is not already in the corpus is reported,
 * not created. A `Contact` needs a `companyId`, and inventing a Company from a contact
 * list would produce a company with no research, no score and no evidence — a row that
 * exists only to hold an address.
 *
 * ## Provenance
 *
 * The `Evidence` row cites **the provider and the operator**, because that is what
 * actually produced the value. There is no page to cite: nobody fetched one. The
 * excerpt is the operator's own CSV line, verbatim, which is the whole of what the
 * source said.
 */

export const CONTACT_IMPORT_COLUMNS = [
  'domain',
  'email',
  'full_name',
  'title',
  'contact_type',
  'provider',
  'source_url',
  'notes',
] as const

export const CONTACT_IMPORT_REQUIRED = ['domain', 'email'] as const

/**
 * A hand-transcribed provider result. Below the 0.9 a page-read address carries,
 * because nothing here was read by this system: the chain is a vendor's index, a
 * human's eyes and a human's typing, and each link can be wrong in a way a fetch
 * cannot.
 */
export const OPERATOR_IMPORT_CONFIDENCE = 0.5

export type ImportOutcome =
  | 'imported'
  | 'already_present'
  | 'unknown_company'
  | 'off_domain'
  | 'executive'
  | 'unusable_row'

export type ImportRowResult = {
  line: number
  email: string
  domain: string
  outcome: ImportOutcome
  contactType: ContactType | null
  detail: string
}

export type ImportResult = {
  rows: ImportRowResult[]
  counts: Record<ImportOutcome, number>
}

export type ImportOptions = {
  /** Where the addresses came from, e.g. `apollo.io`. Used as the Evidence source. */
  provider: string
  /** Who typed them. The second half of the provenance — a person, not a page. */
  operator: string
  now?: Date
  /** Report what would happen, write nothing. */
  dryRun?: boolean
}

/**
 * The `Evidence.sourceUrl` for an operator-entered address.
 *
 * Deliberately not an `https://` URL. Every other row in that column is something
 * this system fetched, and putting a provider's marketing page there would claim a
 * fetch that never happened. The scheme says what the row actually is, and both
 * parties responsible for the value are named in it.
 */
export function operatorEntrySource(provider: string, operator: string): string {
  return `operator-entry://${encodeURIComponent(provider)}/${encodeURIComponent(operator)}`
}

const CONTACT_TYPES = new Set<string>(Object.values(ContactType))

export async function importContacts(
  db: Db,
  filePath: string,
  opts: ImportOptions,
): Promise<ImportResult> {
  const parsed = parseCsv(readFileSync(filePath, 'utf8'))
  const missing = missingColumns(parsed.header, CONTACT_IMPORT_REQUIRED)
  if (missing.length > 0) {
    throw new Error(
      `${filePath} is missing required column(s): ${missing.join(', ')}. ` +
        `Expected header: ${CONTACT_IMPORT_COLUMNS.join(',')}`,
    )
  }

  const now = opts.now ?? new Date()
  const rows: ImportRowResult[] = []

  for (const bad of parsed.malformed) {
    rows.push({
      line: bad.line,
      email: '',
      domain: '',
      outcome: 'unusable_row',
      contactType: null,
      detail: `row has ${bad.got} field(s), header has ${bad.want}`,
    })
  }

  for (const row of parsed.rows) {
    rows.push(await importRow(db, row, opts, now))
  }

  const counts = {
    imported: 0,
    already_present: 0,
    unknown_company: 0,
    off_domain: 0,
    executive: 0,
    unusable_row: 0,
  } satisfies Record<ImportOutcome, number>
  for (const r of rows) counts[r.outcome] += 1

  // A dry run writes NOTHING, audit rows included. `audit_log` is the record of what
  // the system did, and a preview did nothing; a refusal row for an address that was
  // never imported is a decision that was never taken.
  if (opts.dryRun !== true) {
    await writeAudit(db, {
      actorType: 'user',
      actorId: opts.operator,
      action: 'contact.import_completed',
      subjectType: 'ContactImport',
      metadata: { file: filePath, provider: opts.provider, ...counts },
    })
  }

  return { rows, counts }
}

/**
 * Import refusals are recorded under their OWN action, not the curator's
 * `contact.refused`.
 *
 * Not cosmetic. `tierAYield` counts `contact.refused` rows with no filter on who wrote
 * them, so an import refusing one founder would have moved `executivesRejected` in the
 * **Tier A** yield report — a statistic about what employer pages publish, shifted by a
 * file nobody fetched. That is the same class of error §5 of this milestone's handover
 * is about, and it would have been introduced by the fix for it.
 *
 * Separate actions also keep the two discovery methods independently countable, which
 * is the entire reason `Contact.discoveryMethod` exists: bounce analysis has to be able
 * to separate the methods rather than average them.
 */
const IMPORT_REFUSED = 'contact.import_refused'

async function importRow(
  db: Db,
  row: CsvRow,
  opts: ImportOptions,
  now: Date,
): Promise<ImportRowResult> {
  const rawEmail = cell(row, 'email')
  const rawDomain = cell(row, 'domain')
  if (rawEmail === null || rawDomain === null) {
    return {
      line: row.line,
      email: rawEmail ?? '',
      domain: rawDomain ?? '',
      outcome: 'unusable_row',
      contactType: null,
      detail: 'domain and email are both required',
    }
  }

  const email = normalizeEmail(rawEmail)
  const canonical = canonicalizeDomain(rawDomain)
  if (!canonical.ok) {
    return {
      line: row.line,
      email,
      domain: rawDomain,
      outcome: 'unusable_row',
      contactType: null,
      detail: `domain is unusable: ${canonical.reason}`,
    }
  }

  const company = await db.company.findUnique({
    where: { canonicalDomain: canonical.domain },
    select: { id: true, displayName: true },
  })
  if (!company) {
    return {
      line: row.line,
      email,
      domain: canonical.domain,
      outcome: 'unknown_company',
      contactType: null,
      detail: 'no Company with this canonical domain — seed it first',
    }
  }

  // Same rule as `curate.ts`, and it matters more here: a provider export mixes
  // personal accounts and other employers' addresses in a way a careers page does not.
  if (!isCompanyDomain(email, canonical.domain)) {
    if (opts.dryRun !== true) {
      await writeAudit(db, {
        actorType: 'user',
        actorId: opts.operator,
        action: IMPORT_REFUSED,
        subjectType: 'Company',
        subjectId: company.id,
        metadata: { reason: 'off_domain', domain: canonical.domain },
      })
    }
    return {
      line: row.line,
      email,
      domain: canonical.domain,
      outcome: 'off_domain',
      contactType: null,
      detail: `address is not on ${canonical.domain}`,
    }
  }

  const title = cell(row, 'title')
  const exec = isExecutiveContact(email, title)
  if (exec.isExecutive) {
    if (opts.dryRun !== true) {
      await writeAudit(db, {
        actorType: 'user',
        actorId: opts.operator,
        action: IMPORT_REFUSED,
        subjectType: 'Company',
        subjectId: company.id,
        reasonCode: 'executive_only_contact',
        // The address itself is NOT recorded, for the same reason `curate.ts` does not
        // record it: handover.md §1.1 says never target them, and storing the address
        // in an audit row so a later query could find it keeps exactly what the rule
        // says not to keep.
        metadata: { matched: exec.matched, where: exec.where },
      })
    }
    return {
      line: row.line,
      email,
      domain: canonical.domain,
      outcome: 'executive',
      contactType: null,
      detail: `${exec.where} matched ${exec.matched}`,
    }
  }

  const contactType = resolveContactType(row, email, title)

  const existing = await db.contact.findUnique({
    where: { emailNormalized: email },
    select: { id: true },
  })
  if (existing) {
    return {
      line: row.line,
      email,
      domain: canonical.domain,
      outcome: 'already_present',
      contactType,
      detail: 'a Contact with this address already exists',
    }
  }

  if (opts.dryRun === true) {
    return { line: row.line, email, domain: canonical.domain, outcome: 'imported', contactType, detail: 'dry run' }
  }

  const provider = cell(row, 'provider') ?? opts.provider
  const evidence = await writeEvidence(db, {
    companyId: company.id,
    sourceUrl: operatorEntrySource(provider, opts.operator),
    // Not `company_page`: nobody read a page. `user_hint` is the enum value that says
    // "a human supplied this", which is exactly what happened.
    sourceType: 'user_hint',
    // The operator's own line, verbatim. Any `source_url` the operator noted travels
    // inside it rather than in the column above, because that column has to say where
    // THIS system got the value, and it got it from a person.
    excerpt: verbatimExcerpt(row.raw),
    contentHash: contentHashOf({ provider, operator: opts.operator, email, row: row.raw }),
    observedAt: now,
    confidence: OPERATOR_IMPORT_CONFIDENCE,
    fetchedVia: FETCHED_VIA.userHint,
  })

  const created = await db.contact.create({
    data: {
      companyId: company.id,
      emailNormalized: email,
      contactType,
      // The whole safety story of this path. Nothing here was verified by this system,
      // so nothing here opens an outreach case until the operator confirms it.
      verified: false,
      discoveryMethod: 'lookup_provider',
      // Tier A's page-kind attribution is meaningless for a row nobody fetched, and a
      // value like `other` would quietly enter the yield report as if a page had been
      // read. Null is the honest answer.
      sourcePageKind: null,
      publicTitle: title,
      evidenceId: evidence.id,
      capturedAt: now,
    } satisfies Prisma.ContactUncheckedCreateInput,
    select: { id: true },
  })

  await writeAudit(db, {
    actorType: 'user',
    actorId: opts.operator,
    action: 'contact.created',
    subjectType: 'Contact',
    subjectId: created.id,
    metadata: {
      companyId: company.id,
      contactType,
      discoveryMethod: 'lookup_provider',
      verified: false,
      provider,
      sourceUrl: operatorEntrySource(provider, opts.operator),
    },
  })

  return { line: row.line, email, domain: canonical.domain, outcome: 'imported', contactType, detail: '' }
}

/**
 * The operator's own `contact_type` when they supplied a valid one, otherwise the
 * same derivation `curate.ts` uses.
 *
 * `named_employee` is **allowed** here, where Tier A refuses it. That is not an
 * inconsistency: Tier A refuses it because a bare address found on a company page is
 * as likely to be a support desk as a person, and Tier A stores recruiting routes
 * only. A row on this list is a named individual the operator looked up on purpose,
 * and the F4 amendment made any current employee a valid contact — "SDE1, SDE2,
 * senior, staff, tech lead, EM" — with founders, CEOs, C-suite and VPs excluded, which
 * is the executive filter's job and happens before this function is reached.
 */
function resolveContactType(row: CsvRow, email: string, title: string | null): ContactType {
  const supplied = cell(row, 'contact_type')
  if (supplied !== null && CONTACT_TYPES.has(supplied)) return supplied as ContactType

  const classification = classifyLocal(email)
  if (classification.kind !== 'named') return classification.contactType
  return title !== null && /recruit|talent|people|hr/i.test(title) ? 'named_talent' : 'named_employee'
}
