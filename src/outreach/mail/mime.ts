/**
 * The raw RFC 5322 message, built by hand.
 *
 * No MIME library. The message this system sends is deliberately the simplest thing
 * email can be — one `text/plain` part, no attachment (H3: link on first contact; B5:
 * a new sending domain plus an attachment is the worst deliverability combination
 * available), no HTML alternative, no inline images. A dependency that can build a
 * multipart tree with attachments is a dependency that can be talked into building
 * one, and every byte of an outbound message here should be attributable to a
 * sentence a human approved.
 *
 * What the builder does have to get right:
 *
 * - **`Message-ID` is set explicitly** (A9). Gmail must not mint it.
 * - **Header values are sanitised against injection.** A header value carrying CR or
 *   LF can inject arbitrary headers — a second `Bcc:` is the classic — and the
 *   subject is composed text. Refused, not stripped: a subject that contains a
 *   newline is a composer bug, and silently repairing it would hide the bug while
 *   sending the repaired version.
 * - **Non-ASCII survives.** The corpus is international and the operator's own name
 *   is not the constraint — a company name might be. Headers use RFC 2047 encoded
 *   words; the body is UTF-8 with `Content-Transfer-Encoding: base64`, which also
 *   sidesteps every line-length and bare-CR rule in one move.
 */

/** RFC 5322 forbids CR and LF inside a header value; everything else is the field's. */
const HEADER_FORBIDDEN = /[\r\n]/

export type RawMessageInput = {
  to: string
  from: string
  replyTo: string
  subject: string
  bodyText: string
  messageId: string
  /** Set on a follow-up so it threads under the original (RFC 5322 §3.6.4). */
  inReplyTo?: string | undefined
  date?: Date
}

export class HeaderInjectionError extends Error {
  constructor(field: string) {
    super(`header "${field}" contains a line break: refusing to build the message`)
    this.name = 'HeaderInjectionError'
  }
}

/** True when every character is printable US-ASCII, so no encoding is needed. */
function isPlainAscii(value: string): boolean {
  return !/[^\x20-\x7E]/.test(value)
}

/**
 * RFC 2047 encoded-word, base64 form.
 *
 * Applied whole-value rather than per-word. That is simpler and still conforming, and
 * the alternative — splitting on whitespace and encoding only the non-ASCII runs —
 * is where implementations get the 75-octet limit wrong.
 */
export function encodeHeaderValue(value: string): string {
  if (isPlainAscii(value)) return value
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

/**
 * An address with an optional display name: `Name <local@domain>`.
 *
 * The display name is encoded if it needs it; the address itself is never encoded,
 * because an encoded-word is not permitted inside `addr-spec` and doing so would
 * produce a header that looks fine and routes nowhere.
 */
export function encodeAddress(value: string): string {
  const match = /^(.*)<([^<>]+)>\s*$/.exec(value.trim())
  if (!match) return value.trim()
  const display = (match[1] ?? '').trim().replace(/^"|"$/g, '')
  const address = (match[2] ?? '').trim()
  if (display === '') return `<${address}>`
  return `${encodeHeaderValue(display)} <${address}>`
}

function header(field: string, value: string): string {
  if (HEADER_FORBIDDEN.test(value)) throw new HeaderInjectionError(field)
  return `${field}: ${value}`
}

/** RFC 5322 date, in the form `Thu, 11 Sep 2026 15:04:05 +0000`. */
export function rfc5322Date(date: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${days[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${months[date.getUTCMonth()]} ` +
    `${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:` +
    `${pad(date.getUTCSeconds())} +0000`
  )
}

/** Base64 body, wrapped at 76 characters per RFC 2045 §6.8. */
function base64Body(text: string): string {
  const encoded = Buffer.from(text, 'utf8').toString('base64')
  return (encoded.match(/.{1,76}/g) ?? ['']).join('\r\n')
}

export function buildRawMessage(input: RawMessageInput): string {
  // Every header value passes through `header()`, which refuses a line break. The
  // subject is the one composed from model output, so it is the one that matters —
  // but a curated contact address reaching here with a newline in it would be just as
  // bad, and neither is worth a special case.
  const headers = [
    header('From', encodeAddress(input.from)),
    header('To', encodeAddress(input.to)),
    header('Reply-To', encodeAddress(input.replyTo)),
    header('Subject', encodeHeaderValue(input.subject)),
    header('Message-ID', input.messageId),
    header('Date', rfc5322Date(input.date ?? new Date())),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ]

  if (input.inReplyTo) {
    // Both, per RFC 5322 §3.6.4: `In-Reply-To` is what most clients thread on and
    // `References` is what the standard actually specifies for the chain.
    headers.push(header('In-Reply-To', input.inReplyTo))
    headers.push(header('References', input.inReplyTo))
  }

  return `${headers.join('\r\n')}\r\n\r\n${base64Body(input.bodyText)}\r\n`
}

/**
 * base64url, unpadded — what Gmail's `message.raw` field takes.
 *
 * The API reference calls the field "RFC 2822 format bytes of the message" and the
 * transport is JSON, so the bytes are base64url-encoded. Standard base64 is rejected:
 * `+` and `/` are not in the URL-safe alphabet.
 */
export function toBase64Url(raw: string): string {
  return Buffer.from(raw, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}
