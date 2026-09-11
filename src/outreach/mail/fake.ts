import type { InboundMessage, MailProvider, OutboundMessage, ProviderMessageRef } from '../../core/interfaces/providers.js'
import { buildRawMessage } from './mime.js'
import { deriveMessageId, deriveOutreachRef, outreachRefOf, syntheticProviderId } from './message-id.js'
import { AmbiguousSendError } from './gmail.js'

/**
 * The fake `MailProvider` — Part G's "contract tests run against both
 * real-with-fixtures and fake adapters".
 *
 * ## What a fake must not be allowed to do here
 *
 * A fake mail provider is uniquely dangerous, because the property under test is
 * *"a crash mid-send issues no second send"* and a fake that quietly behaves better
 * than Gmail proves nothing. Two rules follow, and both are the point of this file:
 *
_PLACEHOLDER_
 * 2. **It can fail ambiguously on demand.** `failNextSendAmbiguously()` delivers the
 *    message and then throws, which is the exact shape of a lost response — the state
 *    that A9 exists for and the one a naive fake never produces.
 */

export type FakeSentMessage = {
  providerMessageId: string
  threadId: string
  rfc822MessageId: string
  /** What the provider stored, which is not necessarily what we asked for. */
  storedMessageId: string
  /** The `X-Outreach-Ref` the provider kept, or null if it stripped it. */
  storedOutreachRef: string | null
  to: string
  subject: string
  bodyText: string
  raw: string
  sentAt: Date
}

export type FakeMailOptions = {
  messageIdDomain?: string
  /**
   * Whether the provider keeps a client-supplied `Message-ID`.
   *
   * **Defaults to false, because Gmail does not keep it.** Nothing in the
   * reconciliation reads it any more; it is modelled so `storedMessageId` stays honest.
   */
  preservesMessageId?: boolean
  /**
   * Whether the provider keeps the `X-Outreach-Ref` header the reconciliation matches
   * on. Defaults to true — measured. Set false to assert that a provider which strips
   * it still cannot cause a double send.
   */
  preservesOutreachRef?: boolean
}

export class FakeMailProvider implements MailProvider {
  readonly sent: FakeSentMessage[] = []
  /** Every send CALL, including ones that threw. `sent` holds only what landed. */
  sendCalls = 0

  private ambiguousNext = false
  private refuseNext: Error | null = null
  private readonly inbound: InboundMessage[] = []
  private readonly messageIdDomain: string
  private readonly preservesMessageId: boolean
  private readonly preservesOutreachRef: boolean

  constructor(opts: FakeMailOptions = {}) {
    this.messageIdDomain = opts.messageIdDomain ?? 'owned.example'
    this.preservesMessageId = opts.preservesMessageId ?? false
    this.preservesOutreachRef = opts.preservesOutreachRef ?? true
  }

  /**
   * The next send delivers the message and then throws — a response lost in flight.
   *
   * Delivering first is not a detail. A fake that threw without recording the message
   * would model a *failed* send, and the reconciliation would correctly find nothing
   * and correctly send again. The dangerous state is the one where the message is
   * already in the recipient's inbox.
   */
  failNextSendAmbiguously(): void {
    this.ambiguousNext = true
  }

  /** The next send fails unambiguously — nothing is delivered. */
  failNextSendWith(err: Error): void {
    this.refuseNext = err
  }

  async send(m: OutboundMessage, idempotencyKey: string): Promise<ProviderMessageRef> {
    this.sendCalls += 1

    if (this.refuseNext) {
      const err = this.refuseNext
      this.refuseNext = null
      throw err
    }

    const derived = deriveMessageId(idempotencyKey, this.messageIdDomain)
    const raw = buildRawMessage({
      to: m.to,
      from: m.fromIdentity,
      replyTo: m.replyTo,
      subject: m.subject,
      bodyText: m.bodyText,
      messageId: derived,
      outreachRef: deriveOutreachRef(idempotencyKey),
      ...(m.inReplyToMessageId ? { inReplyTo: m.inReplyToMessageId } : {}),
    })

    const record: FakeSentMessage = {
      providerMessageId: syntheticProviderId(),
      threadId: syntheticProviderId(),
      rfc822MessageId: derived,
      storedMessageId: this.preservesMessageId
        ? derived
        : `<rewritten.${syntheticProviderId()}@mail.provider.invalid>`,
      storedOutreachRef: this.preservesOutreachRef ? deriveOutreachRef(idempotencyKey) : null,
      to: m.to,
      subject: m.subject,
      bodyText: m.bodyText,
      raw,
      sentAt: new Date(),
    }
    this.sent.push(record)

    if (this.ambiguousNext) {
      this.ambiguousNext = false
      throw new AmbiguousSendError('fake: response lost after the message was delivered')
    }
    return { providerMessageId: record.providerMessageId, threadId: record.threadId }
  }

  async findByMessageId(messageId: string): Promise<ProviderMessageRef | null> {
    // Matches on the HEADER the provider kept, which is what the Gmail implementation
    // does and for the same measured reason. With `preservesOutreachRef: false` this
    // returns null for a message that really was sent — the residual failure mode, and
    // the assertion is that even then no second send is issued.
    const ref = outreachRefOf(messageId)
    const hit = this.sent.find((s) => s.storedOutreachRef !== null && s.storedOutreachRef === ref)
    return hit ? { providerMessageId: hit.providerMessageId, threadId: hit.threadId } : null
  }

  async listReplies(threadIds: string[]): Promise<InboundMessage[]> {
    const wanted = new Set(threadIds)
    return this.inbound.filter((m) => wanted.has(m.threadId))
  }

  /** Test seam: put a reply, bounce or opt-out into the mailbox. */
  deliverInbound(message: InboundMessage): void {
    this.inbound.push(message)
  }
}
