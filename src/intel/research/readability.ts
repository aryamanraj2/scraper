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

/**
 * The page's FULL text plus its `mailto:` targets — everything Readability throws
 * away, which for contact curation is most of what matters.
 *
 * `extractReadable` strips navigation, footers and boilerplate, and that is right for
 * the track matcher: an address in a footer says nothing about whether a company
 * writes Swift. It is exactly wrong for the contact curator, whose path list includes
 * `{ path: '/', kind: 'footer' }` precisely because a published `careers@` usually
 * lives in a footer. Measured on the first live run: the curator read 4-5 pages per
 * company across 19 companies and found one address, while asking Readability for
 * text that by definition excluded the region it was looking in.
 *
 * An address is a token, not prose, so it needs no article extraction — only the full
 * text and the links. Both are returned verbatim; nothing here rewords anything.
 */
export type PageAddresses = {
  /** Whole-document text, whitespace-normalised. Footers and nav included. */
  fullText: string
  /** Every `mailto:` target on the page. Often the only place an address appears. */
  mailtoTargets: string[]
}

export function extractPageAddresses(html: string): PageAddresses | null {
  let document: { querySelectorAll?: unknown }
  try {
    ;({ document } = parseHTML(html) as never)
  } catch {
    return null
  }

  const fullText = textWithElementBoundaries(html)

  const mailtoTargets: string[] = []
  try {
    const links = (document as { querySelectorAll: (s: string) => Iterable<{ getAttribute: (a: string) => string | null }> })
      .querySelectorAll('a[href^="mailto:"]')
    for (const link of links) {
      const href = link.getAttribute('href')
      if (!href) continue
      // Strip the scheme and any ?subject=... the site attached.
      const address = href.slice('mailto:'.length).split('?')[0]!.trim()
      if (address) mailtoTargets.push(address)
    }
  } catch {
    // A document linkedom cannot query is still one we have text for.
  }

  return { fullText, mailtoTargets }
}

/**
 * Page text with a space at every element boundary.
 *
 * `document.body.textContent` concatenates adjacent elements with **no separator**,
 * which is fine for prose and wrong for addresses. Measured on a live run: a footer
 * whose links read "…Case studies · LinkedIn · Instagram · X · Facebook" sitting
 * beside `info@geckorobotics.com` produced the single token
 * `studieslinkedininstagramxfacebookinfo@geckorobotics.com`, which matched the address
 * pattern and was stored as a contact.
 *
 * A word-boundary regex cannot recover from a source that has no boundaries, so the
 * boundary is restored before matching: tags become spaces. `<script>` and `<style>`
 * bodies are dropped first — they are not page text, and a JSON blob inside one is
 * both noise for address matching and a false-positive source for the injection
 * scanner.
 *
 * Nothing here rewords anything: only markup is removed and whitespace collapsed,
 * which is the same treatment `normalizeWhitespace` already applies to extracted text.
 */
export function textWithElementBoundaries(html: string): string {
  return normalizeWhitespace(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      // Every tag becomes a space, so two elements' text can never fuse into one token.
      .replace(/<[^>]+>/g, ' ')
      // The entities that actually appear around addresses. `&#64;` and `&#46;` are
      // the standard "obfuscated" spellings of @ and . on a contact page.
      .replace(/&nbsp;/gi, ' ')
      .replace(/&#0*64;|&commat;/gi, '@')
      .replace(/&#0*46;|&period;/gi, '.')
      .replace(/&amp;/gi, '&'),
  )
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
