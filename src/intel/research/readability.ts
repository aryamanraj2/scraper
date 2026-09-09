import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'

/**
 * D4 tier 2: readable text from an employer page.
 *
 * ## Why linkedom rather than jsdom
 *
 * `@mozilla/readability` needs a DOM, and jsdom is its usual host. Two reasons it
 * is not used here, in order of weight:
 *
 *  1. **jsdom ships an HTTP stack.** It implements XMLHttpRequest and can load
 *     subresources. In a system whose central invariant is that `FetchPolicyGate`
 *     is the only path to the network — enforced by an ESLint rule, an AST scanner
 *     and transport-level tests — putting a second network-capable engine into the
 *     research path is exactly the kind of hole those three layers exist to close.
 *     linkedom parses HTML and does nothing else: no fetch, no XHR, no script
 *     execution.
 *  2. jsdom 30 requires Node ^22.22.2 and this machine runs 22.16.0, so the current
 *     release is not installable here anyway.
 *
 * The trade is that linkedom is not the DOM Readability is tested against. The
 * contract test in `test/unit/readability.test.ts` pins the behaviour we depend on.
 *
 * ## What "extracted" means
 *
 * Readability's job is to strip navigation, footers and boilerplate and leave the
 * article. What survives is what a human reader would call the page's content, and
 * it is what the track matcher sees. The HTML is never stored: `Evidence.excerpt`
 * quotes the extracted TEXT, so what is cited is what was read.
 */

export type ExtractedPage = {
  title: string | null
  /** Readable text, whitespace-normalised. Never reworded. */
  text: string
  /** Characters of readable text. Below `MIN_READABLE_CHARS` the page is unusable. */
  length: number
  /** Readability's own excerpt (usually the meta description), when it produced one. */
  summary: string | null
}

/**
 * A page shorter than this is treated as unusable and becomes the Firecrawl
 * escalation trigger (D4 step 3). Most JS-rendered careers pages land here: the
 * server sends a shell, and the roles arrive from an API the shell calls.
 */
export const MIN_READABLE_CHARS = 200

/**
 * Collapses runs of whitespace without touching words.
 *
 * Extracted text carries the newlines and indentation of the markup it came from,
 * which makes an excerpt unreadable in a database column. Only whitespace changes;
 * `Evidence.excerpt` must stay verbatim in every way that matters — the source's
 * own words, in the source's own order.
 */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function extractReadable(html: string): ExtractedPage | null {
  let document: unknown
  try {
    ;({ document } = parseHTML(html))
  } catch {
    return null
  }

  let parsed: { title?: string | null | undefined; textContent?: string | null | undefined; excerpt?: string | null | undefined } | null = null
  try {
    // Readability mutates the document it is given, which is fine: this one is ours
    // and is discarded immediately after.
    parsed = new Readability(document as never).parse()
  } catch {
    // A page that crashes the extractor is an unusable page, not an exception that
    // unwinds a research job — a skipped source is an outcome (F1 §5).
    return null
  }
  if (!parsed) return null

  const text = normalizeWhitespace(parsed.textContent ?? '')
  if (text === '') return null

  return {
    title: parsed.title ? normalizeWhitespace(parsed.title) : null,
    text,
    length: text.length,
    summary: parsed.excerpt ? normalizeWhitespace(parsed.excerpt) : null,
  }
}
