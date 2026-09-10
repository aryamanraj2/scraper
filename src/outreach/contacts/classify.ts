import type { ContactType } from '../../../generated/prisma/enums.js'

/**
 * Email extraction and classification — pure, no network, no database.
 *
 * This is the piece that decides what a found address *is*, and therefore whether it
 * may be stored at all. It is deliberately a pure function over text so it can be
 * red-teamed exhaustively in unit tests: `handover.md` §1.1's ban on executive
 * targeting is only as good as the classifier that recognises one.
 */

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Conservative address matcher.
 *
 * Deliberately narrower than RFC 5322, which permits quoted local parts and comments
 * that no careers page has ever used and that would mostly match prose. Over-matching
 * here is not a cosmetic problem: every false positive becomes a `Contact` row this
 * system might one day mail.
 */
const EMAIL_RE = /\b[A-Za-z0-9](?:[A-Za-z0-9._%+-]{0,62}[A-Za-z0-9])?@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+\b/g

/**
 * Addresses that are never a recruiting route, and in several cases never a person.
 *
 * `noreply` and friends are obvious. The others are the ones that cost you a bounce or
 * a complaint: `abuse@` and `postmaster@` are RFC 2142 mailboxes whose operators
 * specifically do not want unsolicited mail, and `privacy@`/`dpo@` is the address you
 * least want a cold recruiting message to arrive at.
 */
const NEVER_CONTACT_LOCALS = new Set([
  'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'bounce', 'bounces',
  'mailer-daemon', 'postmaster', 'abuse', 'security', 'privacy', 'dpo',
  'legal', 'compliance', 'unsubscribe', 'notifications', 'notification',
  'sentry', 'root', 'webmaster', 'hostmaster', 'admin', 'administrator',
  'billing', 'invoices', 'accounts', 'accounting', 'payments',
])

/** Placeholder domains that appear in documentation and templates, never in life. */
const PLACEHOLDER_DOMAINS = new Set([
  'example.com', 'example.org', 'example.net', 'example.invalid',
  'domain.com', 'yourcompany.com', 'company.com', 'email.com',
  'test.com', 'sentry.io', 'wixpress.com',
])

/** File extensions that look like addresses when a filename contains an @. */
const ASSET_SUFFIX_RE = /\.(png|jpe?g|gif|svg|webp|css|js|woff2?|ttf|ico|mp4|pdf)$/i

export function extractEmails(text: string): string[] {
  const found = new Set<string>()
  for (const raw of text.match(EMAIL_RE) ?? []) {
    const email = raw.toLowerCase()
    if (ASSET_SUFFIX_RE.test(email)) continue
    const at = email.lastIndexOf('@')
    const local = email.slice(0, at)
    const domain = email.slice(at + 1)
    if (PLACEHOLDER_DOMAINS.has(domain)) continue
    if (NEVER_CONTACT_LOCALS.has(local)) continue
    // `2x@3x` in an image srcset, version strings, and similar noise.
    if (/^\d+x?$/.test(local)) continue
    found.add(email)
  }
  return [...found]
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Role-based local parts, in tier order. H2: role aliases are the default target and
 * the lowest-exposure option available — nobody's personal address.
 *
 * Order matters: the first match wins, so the more specific university-recruiting
 * spellings are checked before the general careers ones.
 */
const ALIAS_LOCALS: { locals: string[]; type: ContactType }[] = [
  {
    type: 'university_recruiting',
    locals: [
      'universityrecruiting', 'university-recruiting', 'campus', 'campusrecruiting',
      'campus-recruiting', 'students', 'internships', 'interns', 'internship',
      'earlycareers', 'early-careers', 'graduates', 'grads', 'newgrad',
    ],
  },
  {
    type: 'talent_alias',
    locals: [
      'talent', 'talentacquisition', 'talent-acquisition', 'recruiting', 'recruitment',
      'recruiter', 'recruiters', 'hiring', 'people', 'peopleops', 'people-ops', 'hr',
    ],
  },
  {
    type: 'careers_alias',
    locals: ['careers', 'career', 'jobs', 'job', 'work', 'workwithus', 'join', 'joinus', 'apply'],
  },
]

/** Generic company mailboxes that are a usable route when nothing better exists. */
const FALLBACK_ALIAS_LOCALS = new Set(['hello', 'info', 'contact', 'team', 'enquiries', 'inquiries'])

export type Classification =
  | { kind: 'alias'; contactType: ContactType; local: string }
  | { kind: 'fallback_alias'; contactType: ContactType; local: string }
  | { kind: 'named'; local: string }

/**
 * What an address is, from its local part alone.
 *
 * A local part that is not a known role word and contains a separator or looks like a
 * personal name is treated as **named** — a real human — which routes it into Tier B
 * and therefore through the executive filter and the verification requirement. When in
 * doubt this errs towards `named`, because the consequences of misfiling a person as a
 * role alias (mailing an individual under Tier A's looser rules) are worse than the
 * reverse.
 */
export function classifyLocal(email: string): Classification {
  const local = email.slice(0, email.lastIndexOf('@'))
  const bare = local.replace(/[._-]/g, '')

  for (const group of ALIAS_LOCALS) {
    if (group.locals.includes(local) || group.locals.includes(bare)) {
      return { kind: 'alias', contactType: group.type, local }
    }
  }
  if (FALLBACK_ALIAS_LOCALS.has(local) || FALLBACK_ALIAS_LOCALS.has(bare)) {
    return { kind: 'fallback_alias', contactType: 'careers_alias', local }
  }
  return { kind: 'named', local }
}

/**
 * An address is on the company's own domain, or a subdomain of it.
 *
 * Tier A stores only addresses at the employer. A `gmail.com` address on a careers
 * page is somebody's personal account (§1.2 forbids using one) and an address at an
 * unrelated company is somebody else's employee.
 */
export function isCompanyDomain(email: string, canonicalDomain: string): boolean {
  const domain = email.slice(email.lastIndexOf('@') + 1)
  return domain === canonicalDomain || domain.endsWith(`.${canonicalDomain}`)
}

/** Normalized form used for the unique index and for suppression hashing (A10). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}
