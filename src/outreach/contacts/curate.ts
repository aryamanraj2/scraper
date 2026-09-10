import type { Prisma } from '../../../generated/prisma/client.js'
import type { ContactSourcePageKind, ContactType } from '../../../generated/prisma/enums.js'
import type { Db } from '../../core/audit/audit-log.js'
import { writeAudit } from '../../core/audit/audit-log.js'
import { contentHashOf } from '../../core/evidence/content-hash.js'
import { FETCHED_VIA, verbatimExcerpt, writeEvidence } from '../../core/evidence/write-evidence.js'
import type { GatedFetcher } from '../../core/interfaces/providers.js'
import { fetchPage } from '../../ingest/fetch-page.js'
import { extractPageAddresses, extractReadable } from '../../intel/research/readability.js'
import { scanForInjection } from '../../intel/research/injection.js'
import { ensureCompanyResearchBudget } from '../../ingest/budget/company-budget.js'
import {
  classifyLocal,
  extractEmails,
  isCompanyDomain,
  normalizeEmail,
} from './classify.js'
import { isExecutiveContact } from './executive-filter.js'

/**
 * Tier A — the contact curator, and the only tier F4 exercises.
 *
 * Reads role aliases and published HR addresses off pages the **employer themselves
 * published**, through `FetchPolicyGate`. No lookup provider, no broker, no pattern
 * construction: `handover.md` §1.2 is untouched by this path, which is exactly why the
 * operator made it the working one.
 *
 * ## What it stores, and what it refuses
 *
 * Stored: an address on the company's own domain, classified as a role alias or as a
 * named non-executive, with an `Evidence` row quoting the page text it was read from
 * and the timestamp it was captured. §1.3's requirement — *"a source URL and capture
 * timestamp"* — is the row's precondition, not a field somebody remembers to fill in.
 *
 * Refused, each with a reason code and an audit row:
 *   - an executive, at any tier (`executive_only_contact`) — §1.1, and the boundary of
 *     the operator's F4 amendment;
 *   - an address off the company's domain, which is a personal account or somebody
 *     else's employee;
 *   - a page whose text is shaped like instructions to an agent
 *     (`injection_detected`) — F2 §4.12's rule, and it must hold here too, because a
 *     careers page that can talk a curator into storing an address it chose is a far
 *     better attack than one that can talk a scorer into a bad label.
 *
 * ## The yield question this exists to answer
 *
 * Every stored row records which **page kind** produced it. Nobody has ever had that
 * number, and it is what decides whether a paid lookup provider is worth buying: if
 * employer pages already yield an alias for most companies, Tier B is a quality
 * addition rather than a volume necessity.
 */

/** Paths tried per company, in order, with the page kind each is recorded as. */
export const CONTACT_PAGE_PATHS: { path: string; kind: ContactSourcePageKind }[] = [
  { path: '/careers', kind: 'careers' },
  { path: '/contact', kind: 'contact' },
  { path: '/jobs', kind: 'job_posting' },
  { path: '/about', kind: 'other' },
  { path: '/', kind: 'footer' },
]

/**
 * Deliberately short, like F1 §4.15's detection list and for the same reason: a
 * company that hides its contact route behind four redirects is not one to spend ten
 * requests and fifty seconds of rate delay on. Widen it with measurements, not guesses.
 */
export const DEFAULT_MAX_PAGES = 3

const sleep = (ms: number) =>
  ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve()

export type CuratedContact = {
  email: string
  contactType: ContactType
  pageKind: ContactSourcePageKind
  sourceUrl: string
  created: boolean
}

export type CurateOutcome = {
  companyId: string
  companyName: string
  contacts: CuratedContact[]
  /** Pages actually read. Used to attribute yield and to bound spend. */
  pagesRead: { url: string; kind: ContactSourcePageKind; chars: number }[]
  refusals: { reason: string; detail: string }[]
  executivesRejected: number
}

export type CurateOptions = {
  maxPages?: number
  now?: Date
  /** Credits charged per page. One, like every other research fetch (F2 §4.7). */
  costPerPage?: number
  /**
   * Wait between two requests to the SAME host, redirect hops included.
   *
   * Every path below is on one employer domain, so D4 step 4's per-host spacing
   * applies between them. The gate REFUSES a too-early request rather than queueing
   * it, so without this wait every company's second candidate page comes back
   * `rate_limited` and curation effectively gets one attempt per company.
   *
   * `src/ingest/ats/detect.ts` carries the identical option and the identical
   * comment, because F1 hit exactly this and wrote down why waiting is the only
   * correct response: retrying immediately, or reaching past the limiter, would be
   * evading a rate limit (`handover.md` §1.5).
   */
  interPageDelayMs?: number
}

/**
 * Preflight refusals that are a verdict about the HOST, and therefore end the walk.
 *
 * F1 §4.15's rule — "a refusal is about the host, so every other path on it would
 * refuse identically" — is true of these four and **not** of `rate_limited`, which is
 * a statement about *timing* and expires on its own. Treating a rate refusal as a
 * host verdict is what made the first live run report five zero-yield companies that
 * had never been read. `budget_exhausted` stops the walk for a different reason that
 * is still correct: there is no headroom, and every further page would cost more.
 */
const HOST_VERDICT_REFUSALS = new Set(['host_denied', 'robots_disallowed', 'terms_prohibited', 'budget_exhausted'])

export async function curateCompanyContacts(
  db: Db,
  fetcher: GatedFetcher,
  company: { id: string; canonicalDomain: string; displayName: string; countries: string[] },
  opts: CurateOptions = {},
): Promise<CurateOutcome> {
  const now = opts.now ?? new Date()
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES

  // F1 §4.2: idempotent, keyed by period month. Opens the current month's envelope
  // before anything can be spent against it.
  await ensureCompanyResearchBudget(db, company.id, company.countries, now)

  const out: CurateOutcome = {
    companyId: company.id,
    companyName: company.displayName,
    contacts: [],
    pagesRead: [],
    refusals: [],
    executivesRejected: 0,
  }

  const seen = new Set<string>()
  let pagesAttempted = 0

  for (const candidate of CONTACT_PAGE_PATHS) {
    if (pagesAttempted >= maxPages) break

    // Before the second and every later request to this host, not before the first.
    if (pagesAttempted > 0) await sleep(opts.interPageDelayMs ?? 0)
    pagesAttempted += 1

    const url = `https://${company.canonicalDomain}${candidate.path}`

    // F1's invariant: "a skipped source is an OUTCOME, not an exception." `fetchPage`
    // turns an HTTP error into `ok: false`, but a transport failure — DNS miss,
    // connection reset, TLS error — throws out of undici. A company whose /contact
    // does not resolve must not abort curation for the other sixteen.
    let page: Awaited<ReturnType<typeof fetchPage>>
    try {
      page = await fetchPage(fetcher, url, {
        companyId: company.id,
        cost: opts.costPerPage ?? 1,
        sameHostDelayMs: opts.interPageDelayMs ?? 0,
      })
    } catch (err) {
      out.refusals.push({ reason: 'source_unavailable', detail: `${url}: ${(err as Error).message}` })
      continue
    }

    if (!page.ok) {
      out.refusals.push({ reason: page.reason, detail: url })
      // F1 §4.15: a HOST verdict applies to every other path on that host, so stop
      // rather than spend rate budget learning the same thing five times. A
      // `rate_limited` refusal is not a host verdict — it expires — and an ordinary
      // HTTP failure is about one path, so both continue to the next candidate.
      if (HOST_VERDICT_REFUSALS.has(page.reason)) break
      continue
    }

    const readable = extractReadable(page.body)
    // Readability strips navigation, FOOTERS and boilerplate — which is right for the
    // track matcher and exactly wrong here, because a published `careers@` usually
    // lives in a footer and this path list has an entry named `footer` for that
    // reason. An address is a token, not prose, so it is looked for in the whole
    // document text and in every `mailto:` target, not in the extracted article.
    const addresses = extractPageAddresses(page.body)
    const text = addresses?.fullText ?? readable?.text ?? page.body
    out.pagesRead.push({ url: page.url, kind: candidate.kind, chars: text.length })

    // F2 §4.12: instruction-shaped text never becomes a quotable row. A page that can
    // talk this module into storing an address of its choosing is a better attack than
    // one that can talk the scorer into a bad label.
    //
    // Scanned across BOTH the article and the full text: widening where addresses are
    // read from would otherwise narrow where hostile text is looked for, and a page
    // that hides its instructions in a footer is the obvious response to a scanner
    // that only reads the article.
    const injection = scanForInjection(`${readable?.text ?? ''}\n${text}`)
    if (injection.detected) {
      await writeAudit(db, {
        actorType: 'system',
        actorId: 'contact-curator',
        action: 'contact.injection_blocked',
        subjectType: 'Company',
        subjectId: company.id,
        reasonCode: 'injection_detected',
        metadata: { url: page.url, patterns: injection.matches.map((m) => m.pattern) },
      })
      out.refusals.push({ reason: 'injection_detected', detail: page.url })
      continue
    }

    // `mailto:` targets first: a site that links its address rather than printing it
    // is the common case, and those never appear in any text extraction at all.
    //
    // They go through `extractEmails` rather than being trusted as-is, because that
    // is where `noreply@`, `abuse@`, `privacy@` and the placeholder domains are
    // refused — and a `mailto:` is the single most likely place to find `noreply@`.
    // Taking the parsed href as an address directly would have quietly reopened every
    // one of those holes.
    const candidates = [
      ...new Set([...extractEmails((addresses?.mailtoTargets ?? []).join(' ')), ...extractEmails(text)]),
    ]
    for (const raw of candidates) {
      const email = normalizeEmail(raw)
      if (seen.has(email)) continue
      seen.add(email)

      if (!isCompanyDomain(email, company.canonicalDomain)) {
        out.refusals.push({ reason: 'off_domain', detail: email })
        continue
      }

      const title = titleNear(text, email)
      const exec = isExecutiveContact(email, title)
      if (exec.isExecutive) {
        out.executivesRejected += 1
        await writeAudit(db, {
          actorType: 'system',
          actorId: 'contact-curator',
          action: 'contact.refused',
          subjectType: 'Company',
          subjectId: company.id,
          reasonCode: 'executive_only_contact',
          // The address itself is NOT recorded. handover.md §1.1 says never target
          // them; storing the address in an audit row so a later query could find it
          // would be keeping exactly what the rule says not to keep.
          metadata: { url: page.url, matched: exec.matched, where: exec.where },
        })
        continue
      }

      const classification = classifyLocal(email)
      const contactType: ContactType =
        classification.kind === 'named'
          ? title && /recruit|talent|people|hr/i.test(title)
            ? 'named_talent'
            : 'named_employee'
          : classification.contactType

      // Tier A stores RECRUITING ROUTES, and `handover.md` §8's selection order names
      // exactly three: a role alias, a published university/recruiting address, and a
      // named People/Talent/Recruiting contact whose work email the employer printed.
      // A bare `named_employee` is none of those.
      //
      // Found live: `support@qventus.com` and `periop@qventus.com` were stored as
      // named employees. Neither is a person and neither is a recruiting route — a
      // support desk receiving a cold internship enquiry is the same failure as the
      // `abuse@` case this file already refuses, and a departmental mailbox is not
      // what the operator's Tier B amendment was about either. §10.5 keeps Tier B a
      // seam this milestone, so a page-read address that is not a recruiting route is
      // simply not stored.
      if (contactType === 'named_employee') {
        out.refusals.push({ reason: 'not_recruiting_route', detail: email })
        continue
      }

      const stored = await storeContact(db, {
        companyId: company.id,
        email,
        contactType,
        title,
        pageKind: candidate.kind,
        sourceUrl: page.url,
        excerptSource: text,
        now,
      })
      out.contacts.push({
        email,
        contactType,
        pageKind: candidate.kind,
        sourceUrl: page.url,
        created: stored.created,
      })
    }

    // A recruiting route is the target; once one is found there is no reason to keep
    // spending requests on this company. Every stored contactType now IS a route —
    // `named_employee` is refused above — so any contact stops the walk.
    if (out.contacts.length > 0) break
  }

  await writeAudit(db, {
    actorType: 'system',
    actorId: 'contact-curator',
    action: 'contact.curated',
    subjectType: 'Company',
    subjectId: company.id,
    metadata: {
      contacts: out.contacts.length,
      pagesRead: out.pagesRead.length,
      executivesRejected: out.executivesRejected,
      refusals: out.refusals.length,
      byPageKind: out.contacts.reduce<Record<string, number>>((a, c) => {
        a[c.pageKind] = (a[c.pageKind] ?? 0) + 1
        return a
      }, {}),
    },
  })

  return out
}

/**
 * Writes a `Contact` with its `Evidence`.
 *
 * The `Evidence` row is not optional and not written afterwards: `Contact.evidenceId`
 * is a required column, so a contact with no provenance cannot exist. §1.3's "source
 * URL and capture timestamp" is a schema fact.
 *
 * `verified: true` for this path — the address was read off the employer's own page,
 * which is the strongest verification available without contacting anyone.
 */
async function storeContact(
  db: Db,
  input: {
    companyId: string
    email: string
    contactType: ContactType
    title: string | null
    pageKind: ContactSourcePageKind
    sourceUrl: string
    excerptSource: string
    now: Date
  },
): Promise<{ id: string; created: boolean }> {
  const existing = await db.contact.findUnique({
    where: { emailNormalized: input.email },
    select: { id: true },
  })
  if (existing) return { id: existing.id, created: false }

  const evidence = await writeEvidence(db, {
    companyId: input.companyId,
    sourceUrl: input.sourceUrl,
    sourceType: 'company_page',
    // The window around the address, so the excerpt shows the address in the context
    // the employer published it in rather than the top of the page (F2 §4.1's lesson).
    excerpt: verbatimExcerpt(windowAround(input.excerptSource, input.email)),
    contentHash: contentHashOf({ url: input.sourceUrl, email: input.email }),
    observedAt: input.now,
    confidence: 0.9,
    fetchedVia: FETCHED_VIA.staticFetch,
  })

  const row = await db.contact.create({
    data: {
      companyId: input.companyId,
      emailNormalized: input.email,
      contactType: input.contactType,
      verified: true,
      discoveryMethod: 'page_published',
      sourcePageKind: input.pageKind,
      publicTitle: input.title,
      evidenceId: evidence.id,
      capturedAt: input.now,
    } satisfies Prisma.ContactUncheckedCreateInput,
    select: { id: true },
  })

  await writeAudit(db, {
    actorType: 'system',
    actorId: 'contact-curator',
    action: 'contact.created',
    subjectType: 'Contact',
    subjectId: row.id,
    metadata: {
      companyId: input.companyId,
      contactType: input.contactType,
      discoveryMethod: 'page_published',
      pageKind: input.pageKind,
      sourceUrl: input.sourceUrl,
    },
  })

  return { id: row.id, created: true }
}

/** A verbatim window around the address, snapped outward to whitespace (F2 §4.1). */
export function windowAround(text: string, needle: string, radius = 200): string {
  const at = text.toLowerCase().indexOf(needle.toLowerCase())
  if (at < 0) return text.slice(0, radius * 2)
  let start = Math.max(0, at - radius)
  let end = Math.min(text.length, at + needle.length + radius)
  while (start > 0 && !/\s/.test(text[start - 1]!)) start -= 1
  while (end < text.length && !/\s/.test(text[end]!)) end += 1
  return text.slice(start, end).trim()
}

/**
 * The nearest plausible job title in the text preceding an address.
 *
 * Best-effort by design, and its failure mode is the safe one: a title this cannot
 * find is `null`, and `isExecutiveContact` then falls back to the local part rather
 * than waving the address through.
 */
export function titleNear(text: string, email: string, radius = 120): string | null {
  const at = text.toLowerCase().indexOf(email.toLowerCase())
  if (at < 0) return null
  const before = text.slice(Math.max(0, at - radius), at)
  const lines = before
    .split(/[\n\r|·•,;()<>]+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 2 && l.length < 80)
  return lines.length > 0 ? lines[lines.length - 1]! : null
}
