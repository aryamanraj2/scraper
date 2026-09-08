/**
 * ATS board detection, as pure pattern matching over a URL or a page's HTML.
 *
 * Kept separate from the adapters and from the network so it can be exhaustively
 * unit-tested against real markup without a database, a gate or a fixture server.
 *
 * B6's correction is encoded here: Greenhouse migrated its hosted board pages from
 * `boards.greenhouse.io` to `job-boards.greenhouse.io`. Both are matched — the old
 * host still appears in years of published links, and treating it as unknown would
 * silently lose every company whose site has not been updated.
 */

export type AtsVendor = 'greenhouse' | 'lever' | 'ashby'

export type AtsDetection = {
  vendor: AtsVendor
  /** The board token (Greenhouse) or board slug/name (Lever, Ashby). */
  boardToken: string
  /** The exact text the token was read out of — the excerpt for the Evidence row. */
  matchedText: string
}

/**
 * Board identifiers are a single path segment. Anchoring on the character class
 * rather than `.+` is what stops a match running past the segment and swallowing
 * `/jobs/12345` into the token.
 */
const TOKEN = '[A-Za-z0-9_-]+'

type Signature = { vendor: AtsVendor; pattern: RegExp }

/**
 * Order is load-bearing, not incidental.
 *
 * The embedded-board forms come FIRST because they are a prefix of the plain
 * hosted-board form: `boards.greenhouse.io/embed/job_board/js?for=acmecorp` also
 * matches `boards.greenhouse.io/(token)`, yielding the token "embed". `NOT_A_TOKEN`
 * catches that and rejects it — but rejecting is not detecting, and a company whose
 * only signal is an embed script would come back as "no board found". Matching the
 * embed shape explicitly, before the generic one, is what makes those companies
 * detectable at all.
 */
const SIGNATURES: Signature[] = [
  // Greenhouse's embedded board: the token travels as a query parameter.
  { vendor: 'greenhouse', pattern: new RegExp(`greenhouse\\.io/embed/job_board(?:/js)?\\?for=(${TOKEN})`, 'i') },
  { vendor: 'greenhouse', pattern: new RegExp(`grnhse[^"'>]*[?&]for=(${TOKEN})`, 'i') },
  // Hosted boards. Current host first, then the legacy one (B6).
  { vendor: 'greenhouse', pattern: new RegExp(`job-boards(?:\\.eu)?\\.greenhouse\\.io/(${TOKEN})`, 'i') },
  { vendor: 'greenhouse', pattern: new RegExp(`boards(?:\\.eu)?\\.greenhouse\\.io/(${TOKEN})`, 'i') },
  // The public API itself, in case a site links straight at it.
  { vendor: 'greenhouse', pattern: new RegExp(`boards-api(?:\\.eu)?\\.greenhouse\\.io/v1/boards/(${TOKEN})`, 'i') },

  { vendor: 'lever', pattern: new RegExp(`jobs(?:\\.eu)?\\.lever\\.co/(${TOKEN})`, 'i') },
  { vendor: 'lever', pattern: new RegExp(`api\\.lever\\.co/v0/postings/(${TOKEN})`, 'i') },

  { vendor: 'ashby', pattern: new RegExp(`jobs\\.ashbyhq\\.com/(${TOKEN})`, 'i') },
  { vendor: 'ashby', pattern: new RegExp(`api\\.ashbyhq\\.com/posting-api/job-board/(${TOKEN})`, 'i') },
]

/**
 * Segments that appear where a board token would, but are not one. A Greenhouse
 * embed script URL is `boards.greenhouse.io/embed/job_board/js?for=token`, so a
 * naive match reads "embed" as the company.
 */
const NOT_A_TOKEN = new Set(['embed', 'js', 'v1', 'v0', 'boards', 'jobs', 'api', 'posting-api'])

/**
 * First match wins, in signature order. Ordering is deliberate rather than
 * incidental: a page can carry both a current and a legacy Greenhouse link, and
 * the current host is the one worth recording.
 */
export function detectAtsInText(text: string): AtsDetection | null {
  for (const { vendor, pattern } of SIGNATURES) {
    const match = pattern.exec(text)
    const token = match?.[1]
    if (!match || !token) continue
    if (NOT_A_TOKEN.has(token.toLowerCase())) continue
    return { vendor, boardToken: token, matchedText: match[0] }
  }
  return null
}

/**
 * Detection from a URL alone — the cheap path, taken before any page is fetched.
 * A careers URL that already points at a hosted board answers the question with no
 * request at all.
 */
export function detectAtsInUrl(url: string): AtsDetection | null {
  return detectAtsInText(url)
}

/**
 * Every board detection found in a page, deduplicated.
 *
 * A page with two different vendors is real — a company mid-migration links both —
 * and it is a case the caller has to decide rather than one this function should
 * silently resolve by returning whichever appears first.
 */
export function detectAllAtsInText(text: string): AtsDetection[] {
  const found: AtsDetection[] = []
  for (const { vendor, pattern } of SIGNATURES) {
    const global = new RegExp(pattern.source, 'gi')
    for (const match of text.matchAll(global)) {
      const token = match[1]
      if (!token || NOT_A_TOKEN.has(token.toLowerCase())) continue
      if (found.some((f) => f.vendor === vendor && f.boardToken === token)) continue
      found.push({ vendor, boardToken: token, matchedText: match[0] })
    }
  }
  return found
}
