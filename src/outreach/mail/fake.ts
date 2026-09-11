import type { InboundMessage, MailProvider, OutboundMessage, ProviderMessageRef } from '../../core/interfaces/providers.js'
import { buildRawMessage } from './mime.js'
import { deriveMessageId, syntheticProviderId } from './message-id.js'
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
 * 1. **It models the provider's Message-ID behaviour as a parameter**, not as an
 *    assumption. `preservesMessageId` defaults to whatever the live probe measured;
 *    a test can flip it and assert the reconciliation still works. A fake hard-coded
 *    to preserve the id would make the double-send test pass on a provider that
 *    rewrites it.
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
   * Deliberately explicit rather than defaulted-true. See the class comment: the whole
   * risk in A9 is a provider that rewrites it, and a fake that cannot express that
   * case cannot test the thing that matters.
   */
  preservesMessageId?: boolean
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

  constructor(opts: FakeMailOptions = {}) {
    this.messageIdDomain = opts.messageIdDomain ?? 'owned.example'
    this.preservesMessageId = opts.preservesMessageId ?? true
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
      ...(m.inReplyToMessageId ? { inReplyTo: m.inReplyToMessageId } : {}),
    })

    const record: FakeSentMessage = {
      providerMessageId: syntheticProviderId(),
      threadId: syntheticProviderId(),
      rfc822MessageId: derived,
      storedMessageId: this.preservesMessageId
        ? derived
        : `<rewritten.${syntheticProviderId()}@mail.provider.invalid>`,
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
    // Matches on what the provider STORED, exactly as `rfc822msgid:` does. When
    // `preservesMessageId` is false this returns null for a message that really was
    // sent — which is the failure mode the probe exists to rule out, reproduced.
    const hit = this.sent.find((s) => s.storedMessageId === messageId)
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
