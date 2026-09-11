import { z } from 'zod'
import type { FetchPolicyGate } from '../../core/policy/fetch-policy-gate.js'
import type { InboundMessage, MailProvider, OutboundMessage, ProviderMessageRef } from '../../core/interfaces/providers.js'
import { buildRawMessage, toBase64Url, OUTREACH_REF_HEADER } from './mime.js'
import { deriveMessageId, deriveOutreachRef, outreachRefOf, rfc822MsgIdQuery } from './message-id.js'
import type { GmailTokenProvider } from './oauth.js'

/**
 * The Gmail adapter — Part E's mail row, on `gmail.modify`.
 *
 * ## Endpoints, verified against Google's own reference on 2026-09-11
 *
 * | Purpose | Call |
 * |---|---|
 * | send | `POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send`, body `{raw, threadId?}`, `raw` = base64url RFC 2822 bytes |
 * | reconcile (A9 step 2) | `GET .../users/me/messages?q=rfc822msgid:<id>` — `q` "supports the same query format as the Gmail search box", and the reference's own example is `from:someuser@example.com rfc822msgid:<somemsgid@example.com> is:unread` |
 * | read a message | `GET .../users/me/messages/{id}?format=full` |
 *
 * Sources:
 * - https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send
 * - https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list
 * - https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get
 * - https://support.google.com/mail/answer/7190 (the `rfc822msgid:` operator)
 * - https://developers.google.com/workspace/gmail/api/reference/quota (the rate override)
 *
 * ## Everything goes through `FetchPolicyGate`
 *
 * There is no HTTP client here and there cannot be: `raw-client.ts` is the only module
 * permitted to reach the network, enforced by ESLint, by `tools/check-no-raw-http.ts`
 * and by the backend tsconfig having no DOM lib. `gmail.googleapis.com` and
 * `oauth2.googleapis.com` earn ordinary allowlist entries with a published rate
 * override, exactly as `api.firecrawl.dev` did in F2.
 *
 * Every call declares `cost: 0`. A send is not research and a research cap must never
 * be able to abort an approved message.
 *
 * ## What this class deliberately does NOT do
 *
 * It does not decide whether to send. It has no access to the send gate, the approval
 * hash, the suppression list or the caps, and it cannot look any of them up. It is
 * transport: it is handed a message and a key, and it returns what the provider said.
 * Everything that decides lives in `src/outreach/send/gate.ts`, in one transaction,
 * where D6 requires it.
 */

const SendResponse = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  labelIds: z.array(z.string()).optional(),
})

const ListResponse = z.object({
  messages: z.array(z.object({ id: z.string(), threadId: z.string() })).optional(),
  resultSizeEstimate: z.number().optional(),
})

const MessageResponse = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).optional(),
  snippet: z.string().optional(),
  internalDate: z.string().optional(),
  payload: z
    .object({
      headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
      mimeType: z.string().optional(),
      body: z.object({ data: z.string().optional(), size: z.number().optional() }).optional(),
      parts: z.array(z.unknown()).optional(),
    })
    .optional(),
})

export class GmailApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number | null,
    readonly detail?: string,
  ) {
    super(message)
    this.name = 'GmailApiError'
  }
}

/**
 * Raised when a send's outcome is genuinely unknown — a timeout, a connection reset,
 * a 5xx, or a 429. **This is the only error class that must trigger A9's
 * reconciliation** rather than a retry, because the message may already be in the
 * recipient's inbox.
 *
 * A 4xx that is not 429 is not ambiguous: the request was rejected and nothing was
 * sent. Conflating the two would make every rejected send run a search, which is
 * merely wasteful — but conflating them the other way is what double-sends.
 */
export class AmbiguousSendError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message)
    this.name = 'AmbiguousSendError'
  }
}

const API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

export type GmailProviderOptions = {
  /** A9: the domain part of the derived Message-ID. The OWNED domain. */
  messageIdDomain: string
  /** Bytes ceiling for a message read. Bodies are small; a runaway one is a bug. */
  maxBytes?: number
  /**
   * Spacing between this provider's own consecutive API calls, in ms.
   *
   * Must exceed the gate's EFFECTIVE delay for `gmail.googleapis.com`, which is
   * `max(DEFAULT_HOST_RATE_DELAY_MS, override, crawlDelay)` — 5,000 ms by default. A
   * first attempt set this to 1,700 on the assumption that a host override could make
   * us faster; it cannot (see `host-lists.ts`), and the reconciliation search was
   * refused a second time.
   */
  interRequestDelayMs?: number
  /**
   * How far back the reconciliation looks for a candidate. Two days covers a crash the
   * operator did not notice over a weekend; longer only costs candidates to sift.
   */
  reconcileWindowDays?: number
}

/** Above the 5,000 ms default spacing in `.env`'s `DEFAULT_HOST_RATE_DELAY_MS`. */
const DEFAULT_INTER_REQUEST_DELAY_MS = 5_200

export class GmailProvider implements MailProvider {
  private lastRequestAt = 0

  constructor(
    private readonly gate: FetchPolicyGate,
    private readonly tokens: GmailTokenProvider,
    private readonly opts: GmailProviderOptions,
  ) {}

  private async authHeaders(): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await this.tokens.accessToken()}` }
  }

  /**
   * Waits out the per-host rate window before issuing a request.
   *
   * ## Why this exists, and why waiting is the only correct answer
   *
   * The first live run of `send:test` sent successfully and then **threw** on the
   * reconciliation search:
   *
   * ```
   * GmailApiError: reconciliation search refused by FetchPolicyGate: rate_limited
   * ```
   *
   * The gate refuses a too-early request rather than queueing it, and the search
   * follows the send by milliseconds. So A9 step 2 — the mechanism whose entire job is
   * to stop a double send after an ambiguous failure — was unable to run at exactly
   * the moment it is needed, because our own conservative rate policy had just been
   * consumed by the send it is meant to reconcile.
   *
   * This is F4 §4.1 one layer down, and that entry already wrote the rule: the "a
   * refusal is about the host, so every other path would refuse identically" reasoning
   * is true of `host_denied`, `robots_disallowed` and `terms_prohibited`, and **false
   * of `rate_limited`**, which is a statement about *timing* and expires on its own.
   * `src/ingest/ats/detect.ts` and the F4 curator both carry the same fix.
   *
   * The response is to **wait**. Retrying immediately, or reaching past the limiter
   * with a raw client, would be evading a rate limit — `handover.md` §1.5, and the one
   * rule this project treats as having no engineering trade-off.
   *
   * Note the failure was loud rather than silent, which is the part that was already
   * right: `findByMessageId` throws instead of returning `null`, because a `null` here
   * means "not sent" and licenses another send. A reconciliation that cannot look must
   * never report that it looked and found nothing.
   */
  private async spaceRequests(): Promise<void> {
    const spacing = this.opts.interRequestDelayMs ?? DEFAULT_INTER_REQUEST_DELAY_MS
    const elapsed = Date.now() - this.lastRequestAt
    if (this.lastRequestAt !== 0 && elapsed < spacing) {
      await new Promise((resolve) => setTimeout(resolve, spacing - elapsed))
    }
  }

  /**
   * Stamps the clock **after** a request completes, not before it starts.
   *
   * The second version of this got it wrong and a live run caught it: `spaceRequests`
   * stamped on entry, while the gate's `HostRateLimiter` stamps when the request is
   * actually issued and measures the next window from there. A Gmail call takes 300-900
   * ms, so the 200 ms of margin between our 5,200 and the gate's 5,000 was consumed by
   * the request itself and the following search was refused `rate_limited` again.
   *
   * Measuring from completion is strictly more conservative than the limiter, which
   * makes the margin a real margin rather than a race against how fast the API happens
   * to be today.
   */
  private markRequestDone(): void {
    this.lastRequestAt = Date.now()
  }

  /**
   * A9: the caller has already written a `SendAttempt` carrying this key and the
   * derived Message-ID **before** calling this. Nothing here writes to the database.
   */
  async send(
    m: OutboundMessage,
    idempotencyKey: string,
  ): Promise<{ providerMessageId: string; threadId?: string }> {
    const messageId = deriveMessageId(idempotencyKey, this.opts.messageIdDomain)
    const raw = buildRawMessage({
      to: m.to,
      from: m.fromIdentity,
      replyTo: m.replyTo,
      subject: m.subject,
      bodyText: m.bodyText,
      messageId,
      outreachRef: deriveOutreachRef(idempotencyKey),
      ...(m.inReplyToMessageId ? { inReplyTo: m.inReplyToMessageId } : {}),
    })

    let result: Awaited<ReturnType<FetchPolicyGate['postJson']>>
    try {
      await this.spaceRequests()
      result = await this.gate.postJson(
        `${API_BASE}/messages/send`,
        { raw: toBase64Url(raw) },
        { companyId: null, cost: 0, headers: await this.authHeaders() },
      )
      this.markRequestDone()
    } catch (err) {
      // A transport throw is the ambiguous case by definition: undici raises on a
      // timeout or a reset, and neither tells us whether Gmail accepted the message
      // before the connection died.
      throw new AmbiguousSendError('the send request failed in transport', err)
    }

    if (!result.ok) {
      // A preflight refusal happened BEFORE any request was issued, so it is
      // unambiguous — no message exists. `rate_limited` is included deliberately: the
      // gate refuses rather than queues, so nothing was sent.
      throw new GmailApiError(`send refused by FetchPolicyGate: ${result.reason}`, null)
    }

    const { statusCode, body } = result.response
    if (statusCode === 429 || statusCode >= 500) {
      // Gmail may have accepted and then failed to tell us. Ambiguous.
      throw new AmbiguousSendError(`gmail returned ${statusCode}`, body.slice(0, 400))
    }
    if (statusCode !== 200) {
      throw new GmailApiError(`gmail returned ${statusCode}`, statusCode, body.slice(0, 400))
    }

    const parsed = SendResponse.safeParse(JSON.parse(body))
    if (!parsed.success) {
      // A 200 whose body we cannot read means the message very likely went out and we
      // cannot say what its id is. Ambiguous, not a plain failure.
      throw new AmbiguousSendError('gmail returned 200 with an unrecognised body', body.slice(0, 400))
    }
    return { providerMessageId: parsed.data.id, threadId: parsed.data.threadId }
  }

  /**
   * A9 step 2 — the reconciliation, **not** as A9 specifies it, because A9's mechanism
   * does not exist on this provider.
   *
   * ## What was measured, on 2026-09-11, against the real account
   *
   * A9 says to derive a deterministic `Message-ID`, set it in the raw MIME, and search
   * `rfc822msgid:<id>` before considering another send. Gmail's API **replaces** the
   * header:
   *
   * ```
   * we set:       <oi.90ffa8e402a69d41a19ec505ec038af2@aryamanj.in>
   * Gmail stored: <CAGBX58siJOdRioW4btcyYmV4-_oo5XFHkPNx+OMtpuvhVL46DQ@mail.gmail.com>
   * x-google-original-message-id: absent
   * ```
   *
   * The search operator is fine — the id it would look for simply does not exist. Left
   * as specified, every reconciliation would report "not sent" for a message sitting in
   * the recipient's inbox, and the retry would deliver a second copy. That is precisely
   * the failure A9 exists to prevent, and it would have passed every test written
   * against a fake that preserves the header.
   *
   * ## What replaces it
   *
   * A header we control. `X-Outreach-Ref` carries the same derivation and **does**
   * survive — verified on the same account, same run. So:
   *
   *   1. a bounded candidate search (`in:sent`, the recipient, a short window), then
   *   2. an **exact match on the header** of each candidate.
   *
   * The search is a filter, never the answer. Gmail exposes no `header:` operator, and
   * it would be easy to guess that a custom header lands in the full-text index and
   * search for the bare token — but relying on undocumented provider behaviour is
   * exactly what just cost A9 its mechanism, so this does not do it twice.
   *
   * Everything A9 actually depends on is intact: the handle is still a pure function of
   * `SendAttempt.idempotencyKey`, still persisted before the API call, and still
   * recoverable from the stored row alone after a crash.
   *
   * `messageId` is accepted in D5's shape; the ref is its local part.
   */
  async findByMessageId(
    messageId: string,
    hint: { to?: string | undefined; withinDays?: number } = {},
  ): Promise<ProviderMessageRef | null> {
    const ref = outreachRefOf(messageId)
    const days = hint.withinDays ?? this.opts.reconcileWindowDays ?? 2
    const parts = ['in:sent', `newer_than:${days}d`]
    // Narrowing by recipient turns "every send this week" into "the one send to this
    // person", which is the difference between a handful of reads and forty.
    if (hint.to) parts.push(`to:${hint.to}`)

    const params = new URLSearchParams({ q: parts.join(' '), maxResults: '25' })
    await this.spaceRequests()
    const result = await this.gate.fetchText(`${API_BASE}/messages?${params.toString()}`, {
      companyId: null,
      cost: 0,
      headers: await this.authHeaders(),
    })
    this.markRequestDone()
    if (!result.ok) {
      // Never report "not found" from a refusal. A null here licenses another send, so
      // the only safe answer to "we could not look" is to raise.
      throw new GmailApiError(`reconciliation search refused by FetchPolicyGate: ${result.reason}`, null)
    }
    if (result.response.statusCode !== 200) {
      throw new GmailApiError(
        `reconciliation search returned ${result.response.statusCode}`,
        result.response.statusCode,
        result.response.body.slice(0, 400),
      )
    }
    const parsed = ListResponse.safeParse(JSON.parse(result.response.body))
    if (!parsed.success) throw new GmailApiError('unrecognised list response', 200)

    for (const candidate of parsed.data.messages ?? []) {
      const message = await this.getMessage(candidate.id)
      if (message.headers[OUTREACH_REF_HEADER.toLowerCase()] === ref) {
        return { providerMessageId: message.id, threadId: message.threadId }
      }
    }
    return null
  }

  /**
   * A9 **as originally specified**, kept solely so the deviation stays evidenced.
   *
   * Returns what `rfc822msgid:<derived-id>` finds. On Gmail that is always nothing,
   * because the API replaces the header — `send:test` prints this beside the header
   * search so the reason for the deviation is visible in the output rather than only
   * in a comment.
   */
  async findByRfc822MsgId(messageId: string): Promise<ProviderMessageRef[]> {
    const params = new URLSearchParams({
      q: rfc822MsgIdQuery(messageId),
      maxResults: '10',
      includeSpamTrash: 'true',
    })
    await this.spaceRequests()
    const result = await this.gate.fetchText(`${API_BASE}/messages?${params.toString()}`, {
      companyId: null,
      cost: 0,
      headers: await this.authHeaders(),
    })
    this.markRequestDone()
    if (!result.ok || result.response.statusCode !== 200) return []
    const parsed = ListResponse.safeParse(JSON.parse(result.response.body))
    if (!parsed.success) return []
    return (parsed.data.messages ?? []).map((m) => ({ providerMessageId: m.id, threadId: m.threadId }))
  }

  /**
   * Every copy of a message carrying our `X-Outreach-Ref`, across all labels.
   *
   * For the diagnostic, not for the reconciliation. A message sent to an address on
   * the same account exists twice — the SENT copy and the delivered copy — and only
   * the delivered one carries `Authentication-Results`, because SPF, DKIM and DMARC
   * are conclusions the RECEIVING side reached. `findByMessageId` scopes to `in:sent`
   * because A9 asks about what we sent; this deliberately does not.
   */
  async findAllByMessageId(
    messageId: string,
    hint: { to?: string | undefined; withinDays?: number } = {},
  ): Promise<ProviderMessageRef[]> {
    const ref = outreachRefOf(messageId)
    const days = hint.withinDays ?? this.opts.reconcileWindowDays ?? 2
    const parts = [`newer_than:${days}d`]
    if (hint.to) parts.push(`to:${hint.to}`)

    const params = new URLSearchParams({ q: parts.join(' '), maxResults: '25', includeSpamTrash: 'true' })
    await this.spaceRequests()
    const result = await this.gate.fetchText(`${API_BASE}/messages?${params.toString()}`, {
      companyId: null,
      cost: 0,
      headers: await this.authHeaders(),
    })
    this.markRequestDone()
    if (!result.ok) throw new GmailApiError(`search refused by FetchPolicyGate: ${result.reason}`, null)
    if (result.response.statusCode !== 200) {
      throw new GmailApiError(`search returned ${result.response.statusCode}`, result.response.statusCode)
    }
    const parsed = ListResponse.safeParse(JSON.parse(result.response.body))
    if (!parsed.success) throw new GmailApiError('unrecognised list response', 200)

    const out: ProviderMessageRef[] = []
    for (const candidate of parsed.data.messages ?? []) {
      const message = await this.getMessage(candidate.id)
      if (message.headers[OUTREACH_REF_HEADER.toLowerCase()] === ref) {
        out.push({ providerMessageId: message.id, threadId: message.threadId })
      }
    }
    return out
  }

  /** One message, with headers and body, for reply and bounce classification. */
  async getMessage(providerMessageId: string): Promise<GmailMessage> {
    await this.spaceRequests()
    const result = await this.gate.fetchText(
      `${API_BASE}/messages/${encodeURIComponent(providerMessageId)}?format=full`,
      {
        companyId: null,
        cost: 0,
        headers: await this.authHeaders(),
        maxBytes: this.opts.maxBytes ?? 1024 * 1024,
      },
    )
    this.markRequestDone()
    if (!result.ok) throw new GmailApiError(`message read refused: ${result.reason}`, null)
    if (result.response.statusCode !== 200) {
      throw new GmailApiError(`message read returned ${result.response.statusCode}`, result.response.statusCode)
    }
    if (result.response.truncated) {
      // F1 §4.7: a truncated body is still valid UTF-8 and parses as far as it goes.
      // Classifying a bounce from half a message is how a hard bounce reads as soft.
      throw new GmailApiError('message body exceeded the byte ceiling and was truncated', 200)
    }
    const parsed = MessageResponse.safeParse(JSON.parse(result.response.body))
    if (!parsed.success) throw new GmailApiError('unrecognised message response', 200)
    return toGmailMessage(parsed.data)
  }

  /**
   * Messages in the given threads that are not ours — i.e. replies.
   *
   * One search per thread rather than one giant `OR` query: Gmail's `q` has no
   * documented length ceiling, and discovering the undocumented one in production
   * would look like "replies stopped arriving".
   */
  async listReplies(threadIds: string[]): Promise<InboundMessage[]> {
    const out: InboundMessage[] = []
    for (const threadId of threadIds) {
      const params = new URLSearchParams({ q: `thread:${threadId}`, maxResults: '20' })
      await this.spaceRequests()
      const result = await this.gate.fetchText(`${API_BASE}/messages?${params.toString()}`, {
        companyId: null,
        cost: 0,
        headers: await this.authHeaders(),
      })
      this.markRequestDone()
      if (!result.ok || result.response.statusCode !== 200) continue
      const parsed = ListResponse.safeParse(JSON.parse(result.response.body))
      if (!parsed.success) continue
      for (const hit of parsed.data.messages ?? []) {
        const message = await this.getMessage(hit.id)
        if (message.fromIsSelf) continue
        out.push({
          providerMessageId: message.id,
          threadId: message.threadId,
          from: message.from,
          receivedAt: message.receivedAt,
          snippet: message.snippet,
        })
      }
    }
    return out
  }

  /**
   * Everything that has arrived since a given history id, which is how the inbox is
   * polled without re-reading the mailbox. Kept as a thin list-by-query for F5: the
   * pilot's volume makes a full `history.list` cursor more machinery than the problem
   * needs, and F6 can add one when there is traffic to justify it.
   */
  async listInbox(query: string, maxResults = 25): Promise<Array<{ id: string; threadId: string }>> {
    const params = new URLSearchParams({ q: query, maxResults: String(maxResults) })
    await this.spaceRequests()
    const result = await this.gate.fetchText(`${API_BASE}/messages?${params.toString()}`, {
      companyId: null,
      cost: 0,
      headers: await this.authHeaders(),
    })
    this.markRequestDone()
    if (!result.ok) throw new GmailApiError(`inbox list refused: ${result.reason}`, null)
    if (result.response.statusCode !== 200) {
      throw new GmailApiError(`inbox list returned ${result.response.statusCode}`, result.response.statusCode)
    }
    const parsed = ListResponse.safeParse(JSON.parse(result.response.body))
    if (!parsed.success) throw new GmailApiError('unrecognised list response', 200)
    return parsed.data.messages ?? []
  }
}

export type GmailMessage = {
  id: string
  threadId: string
  from: string
  to: string
  subject: string
  /** The `Message-ID` header of this message, if it published one. */
  rfc822MessageId: string | null
  /** `In-Reply-To`, which is how a bounce or reply names the message it is about. */
  inReplyTo: string | null
  snippet: string
  bodyText: string
  labelIds: string[]
  receivedAt: Date
  fromIsSelf: boolean
  /** Every header, lowercased key. The diagnostic reads Authentication-Results here. */
  headers: Record<string, string>
}

function headerValue(
  headers: Array<{ name: string; value: string }> | undefined,
  name: string,
): string | null {
  const hit = headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())
  return hit?.value ?? null
}

/** base64url -> utf8, tolerating the padding Gmail omits. */
export function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(normalized, 'base64').toString('utf8')
}

/**
 * Flattens a Gmail payload into the fields the classifiers read.
 *
 * A bounce is usually `multipart/report`, so the useful text is in a child part rather
 * than in `payload.body`. Everything is walked and every `text/*` part concatenated:
 * a classifier that read only the first part would miss the `Diagnostic-Code` line,
 * which is the single most informative field in a delivery status notification.
 */
function collectText(node: unknown, out: string[]): void {
  if (node === null || typeof node !== 'object') return
  const part = node as {
    mimeType?: string
    body?: { data?: string }
    parts?: unknown[]
  }
  if (part.body?.data && (part.mimeType === undefined || part.mimeType.startsWith('text/') || part.mimeType.startsWith('message/'))) {
    out.push(decodeBase64Url(part.body.data))
  }
  for (const child of part.parts ?? []) collectText(child, out)
}

function toGmailMessage(raw: z.infer<typeof MessageResponse>): GmailMessage {
  const headers = raw.payload?.headers
  const text: string[] = []
  if (raw.payload) collectText(raw.payload, text)
  const labelIds = raw.labelIds ?? []
  const allHeaders: Record<string, string> = {}
  for (const h of headers ?? []) allHeaders[h.name.toLowerCase()] = h.value
  return {
    headers: allHeaders,
    id: raw.id,
    threadId: raw.threadId,
    from: headerValue(headers, 'From') ?? '',
    to: headerValue(headers, 'To') ?? '',
    subject: headerValue(headers, 'Subject') ?? '',
    rfc822MessageId: headerValue(headers, 'Message-ID'),
    inReplyTo: headerValue(headers, 'In-Reply-To'),
    snippet: raw.snippet ?? '',
    bodyText: text.join('\n'),
    labelIds,
    receivedAt: raw.internalDate ? new Date(Number(raw.internalDate)) : new Date(),
    // Gmail labels our own messages SENT. Cheaper and more reliable than parsing the
    // From header and comparing it to a configured address, which gets display names,
    // aliases and plus-tags wrong.
    fromIsSelf: labelIds.includes('SENT'),
  }
}
