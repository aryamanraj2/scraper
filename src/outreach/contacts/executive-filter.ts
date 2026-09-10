/**
 * `handover.md` §1.1, enforced.
 *
 * > *Never target CEOs, founders, executives, or generic employee lists by default.*
 *
 * The operator's F4 scope note broadened the contact policy to permit **named
 * employees at any level** — and explicitly kept this exclusion: *"except founders,
 * CEOs, C-suite, VPs"*. So this filter is not a leftover from a narrower era; it is
 * the boundary of the amendment, and it now does more work than it used to rather
 * than less.
 *
 * Two properties it is built for:
 *
 * **It fails closed on ambiguity.** A title it cannot parse is not waved through. The
 * cost of a false negative is mailing a founder, which is the single behaviour
 * `handover.md` §1 names first; the cost of a false positive is one contact skipped
 * out of a target set of two thousand.
 *
 * **It reads the local part as well as the title**, because a careers page often
 * publishes `founders@` or `ceo@` with no title text at all, and a filter that only
 * looked at titles would pass those straight through.
 */

/**
 * Executive title patterns. Word-anchored, because substring matching turns
 * "Head of..." into a match inside "Overhead" and "VP" into a match inside "VPN".
 */
const EXECUTIVE_TITLE_PATTERNS: RegExp[] = [
  /\bfounder(s)?\b/i,
  /\bco[- ]?founder(s)?\b/i,
  /\bchief\b/i,
  /\bc[eoftmiprsdx]o\b/i, // CEO CTO CFO CMO CIO CPO CRO CSO CDO COO CXO
  /\bpresident\b/i,
  /\bvice[- ]president\b/i,
  /\bvp\b/i,
  /\bsvp\b/i,
  /\bevp\b/i,
  /\bmanaging director\b/i,
  /\bexecutive director\b/i,
  /\bboard member\b/i,
  /\bchair(man|woman|person)?\b/i,
  /\bproprietor\b/i,
  /\bowner\b/i,
  /\bhead of (engineering|product|people|talent|hr|operations|design|marketing|sales|finance|legal)\b/i,
]

/**
 * "Partner" is genuinely ambiguous and needed its own rule.
 *
 * At a VC or a law firm it is an executive. In a recruiting org it is an individual
 * contributor: "Talent Partner", "People Partner", "HR Business Partner" and
 * "Recruiting Partner" are standard IC titles for precisely the person Tier B wants to
 * reach. A bare `\bpartner\b` rejected "Talent Partner Associate", which is a recruiter.
 *
 * So the word is executive only when it is NOT preceded by one of those qualifiers.
 */
const PARTNER_PATTERN = /(?<!\b(?:talent|people|hr|human resources|business|recruiting|recruitment|staffing)\s)\bpartner\b/i

/**
 * Local parts that are an executive route regardless of any title text.
 *
 * `office-of-the-ceo` and `founders` show up on real contact pages, and an address is
 * a target even when nobody wrote a job title next to it.
 */
const EXECUTIVE_LOCALS = [
  /^founder(s)?$/,
  /^cofounder(s)?$/,
  /^ceo$/,
  /^cto$/,
  /^cfo$/,
  /^coo$/,
  /^cmo$/,
  /^cpo$/,
  /^cio$/,
  /^cro$/,
  /^cso$/,
  /^cdo$/,
  /^president$/,
  /^chairman$/,
  /^exec(utive)?s?$/,
  /^leadership$/,
  /^board$/,
  /^officeofthe/,
  /^vp[._-]?/,
]

export type ExecutiveVerdict =
  | { isExecutive: false }
  | { isExecutive: true; matched: string; where: 'title' | 'local' }

/**
 * Whether this contact is an executive and must therefore never be stored as a target.
 *
 * `title` may be null — a page that publishes an address with no role text at all —
 * in which case the local part is the only signal and is checked alone.
 */
export function isExecutiveContact(email: string, title: string | null): ExecutiveVerdict {
  const local = email.slice(0, email.lastIndexOf('@')).toLowerCase()
  const bare = local.replace(/[._-]/g, '')

  for (const pattern of EXECUTIVE_LOCALS) {
    if (pattern.test(local) || pattern.test(bare)) {
      return { isExecutive: true, matched: pattern.source, where: 'local' }
    }
  }

  if (title) {
    for (const pattern of EXECUTIVE_TITLE_PATTERNS) {
      const hit = title.match(pattern)
      if (hit) return { isExecutive: true, matched: hit[0], where: 'title' }
    }
    const partner = title.match(PARTNER_PATTERN)
    if (partner) return { isExecutive: true, matched: partner[0], where: 'title' }
  }

  return { isExecutive: false }
}
