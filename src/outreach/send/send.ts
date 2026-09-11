import type { Db } from '../../core/audit/audit-log.js'
import { writeAudit } from '../../core/audit/audit-log.js'
import type { MailProvider } from '../../core/interfaces/providers.js'
import type { ReasonCodeValue } from '../../core/reason-codes/registry.js'
import { AmbiguousSendError } from '../mail/gmail.js'
import { deriveIdempotencyKey } from '../mail/message-id.js'
import { evaluateSendGate, type SendGateOptions, type SendPlan } from './gate.js'

/**
 * A9 — the send, and the only at-most-once job class in the system.
 *
 * > *"A retriable job that calls a mail API can double-send when the provider succeeds
 * > and the response is lost. Fix: write `SendAttempt` with a unique idempotency key
 * > **before** the provider call; reconcile `provider_message_id` after. A retry
 * > finding an `in_flight` attempt reconciles by querying the provider, never
 * > re-sends."*
 *
 * The order below is the whole mechanism and every step of it is load-bearing:
 *
 * 1. The gate decides. Nothing is written if it refuses.
 * 2. `SendAttempt` is written `in_flight`, carrying the idempotency key **and the
 *    derived `Message-ID`**, and the transaction commits. A crash between here and
 *    step 3 leaves a row that says "a send may have gone out, and here is the exact
 *    string to search for".
 * 3. The provider is called.
 * 4. The outcome is recorded.
 *
 * Step 2 committing before step 3 is what makes the difference. The tempting
 * arrangement — one transaction wrapping the API call — is strictly worse: a crash
 * rolls the row back, the message is in the recipient's inbox, and nothing in the
 * database knows it exists.
 *
 * ## What happens on an ambiguous failure
 *
 * `AmbiguousSendError` means the outcome is unknown: a timeout, a reset, a 5xx, a 429,
 * or a 200 whose body we could not read. The response is **never** another send. The
 * `rfc822msgid:` search runs first, and only a miss permits the attempt to be recorded
 * as failed — at which point a human, or a later retry, may try again against a
 * row that now truthfully says nothing was delivered.
 *
 * A non-ambiguous error (a 4xx that is not 429, a gate refusal) means the request was
 * rejected and no message exists. Those are recorded `failed` without a search,
 * because searching for a message that was never accepted is a slow way to learn
 * nothing.
 */

export type SendOutcome =
  | { status: 'sent'; attemptId: string; providerMessageId: string; reconciled: boolean }
  | { status: 'refused'; reason: ReasonCodeValue; detail: string }
  | { status: 'failed'; attemptId: string; detail: string }

export type SendOptions = SendGateOptions & {
  /**
   * Test seam for Part G's row 1: run after the provider call and before the outcome
   * is recorded, so a test can kill the process exactly where A9 says the danger is.
   */
  onAfterProviderCall?: () => void | Promise<void>
}

export async function sendApprovedDraft(
  db: Db,
  mail: MailProvider,
  draftId: string,
  opts: SendOptions,
): Promise<SendOutcome> {
  // --- Step 0: is there already an attempt under this key? -----------------
  //
  // **Before the gate, not after.** A9: *"A retry finding an `in_flight` attempt
  // reconciles by querying the provider, never re-sends."*
  //
  // The first version of this ran the gate first, and a test caught what that costs:
  // an `in_flight` attempt makes D6 condition 8 refuse with `duplicate_contact`, so a
  // retry after a crash could never reach the reconciliation at all. The refusal is
  // correct as a refusal — there IS a duplicate — but it answers the wrong question.
  // Once an attempt exists, the decision to send has already been taken and possibly
  // already executed; what is needed is to find out what happened, not to adjudicate
  // it again. Re-gating would also mean a message that genuinely went out could be
  // recorded as refused because a cap moved in the meantime.
  //
  // Nothing here can cause a send. The only outcomes are "reconcile" and "report".
  const existingKey = await existingAttemptFor(db, draftId, opts.touchNumber ?? 1)
  if (existingKey) {
    if (existingKey.status === 'sent' && existingKey.providerMessageId) {
      return {
        status: 'sent',
        attemptId: existingKey.id,
        providerMessageId: existingKey.providerMessageId,
        reconciled: true,
      }
    }
    if (existingKey.status === 'in_flight') {
      return await reconcileAttempt(db, mail, existingKey.id, existingKey.rfc822MessageId)
    }
    // `failed` or `aborted`: the row records that nothing landed, so a fresh attempt is
    // legitimate — but it would need its own key, and deriving the same one again
    // collides. Surfacing this rather than silently mutating a terminal row keeps the
    // history of what was tried intact.
    return {
      status: 'failed',
      attemptId: existingKey.id,
      detail: `a ${existingKey.status} attempt already exists under this idempotency key`,
    }
  }

  const decision = await evaluateSendGate(db, draftId, opts)
  if (!decision.allowed) {
    return { status: 'refused', reason: decision.reason, detail: decision.detail }
  }
  const plan = decision.plan

  // --- Step 2: the row, before the call. -----------------------------------
  const attempt = await db.$transaction(async (tx) => {
    const row = await tx.sendAttempt.create({
      data: {
        draftId: plan.draftId,
        contactId: plan.contactId,
        companyId: plan.companyId,
        campaignCycle: plan.campaignCycle,
        touchNumber: plan.touchNumber,
        touchSlot: plan.touchSlot,
        idempotencyKey: plan.idempotencyKey,
        // A9 step 3: persisted BEFORE the API call so it survives a crash between
        // derivation and transmission. It is also derivable again from the key, which
        // is belt and braces on purpose — this is the string the reconciliation needs.
        rfc822MessageId: plan.rfc822MessageId,
        status: 'in_flight',
      },
      select: { id: true },
    })
    await tx.draft.update({ where: { id: plan.draftId }, data: { status: 'sending' } })
    return row
  })

  await writeAudit(db, {
    actorType: 'system',
    actorId: 'send',
    action: 'send.attempt_written',
    subjectType: 'SendAttempt',
    subjectId: attempt.id,
    metadata: {
      draftId: plan.draftId,
      rfc822MessageId: plan.rfc822MessageId,
      touchNumber: plan.touchNumber,
      touchSlot: plan.touchSlot,
    },
  })

  // --- Step 3: the provider call. ------------------------------------------
  let ref: { providerMessageId: string; threadId?: string | undefined }
  try {
    ref = await mail.send(
      {
        to: plan.to,
        subject: plan.subject,
        bodyText: plan.bodyText,
        fromIdentity: plan.fromIdentity,
        replyTo: plan.replyTo,
        ...(plan.inReplyToMessageId ? { inReplyToMessageId: plan.inReplyToMessageId } : {}),
      },
      plan.idempotencyKey,
    )
  } catch (err) {
    if (err instanceof AmbiguousSendError) {
      return await reconcileAttempt(db, mail, attempt.id, plan.rfc822MessageId)
    }
    await markFailed(db, attempt.id, plan.draftId, (err as Error).message)
    return { status: 'failed', attemptId: attempt.id, detail: (err as Error).message }
  }

  // The seam sits HERE, outside the try, and that placement is the test it enables:
  // Part G's row 1 kills the worker "after the Gmail call but before the response is
  // recorded". A hook inside the try would be caught by the handler above and recorded
  // as a send failure, which is the opposite of a crash — the whole point is that
  // nothing gets to write anything.
  await opts.onAfterProviderCall?.()

  // --- Step 4: record the outcome. -----------------------------------------
  await markSent(db, attempt.id, plan.draftId, ref.providerMessageId, ref.threadId ?? null, false)
  return { status: 'sent', attemptId: attempt.id, providerMessageId: ref.providerMessageId, reconciled: false }
}

/**
 * The `SendAttempt` for this draft's touch, looked up by the key the gate would
 * derive — without running the gate.
 *
 * It reads only the four fields the key is made of. That is deliberate: this runs
 * before any policy check, so it must not be able to learn anything it could act on.
 */
async function existingAttemptFor(
  db: Db,
  draftId: string,
  touchNumber: number,
): Promise<{
  id: string
  status: string
  rfc822MessageId: string
  providerMessageId: string | null
} | null> {
  const draft = await db.draft.findUnique({
    where: { id: draftId },
    select: { id: true, contactId: true, lead: { select: { campaignCycle: true } } },
  })
  if (!draft?.contactId) return null

  const key = deriveIdempotencyKey({
    draftId: draft.id,
    contactId: draft.contactId,
    campaignCycle: draft.lead.campaignCycle,
    touchNumber,
  })
  return db.sendAttempt.findUnique({
    where: { idempotencyKey: key },
    select: { id: true, status: true, rfc822MessageId: true, providerMessageId: true },
  })
}

/**
 * A9 step 2 — *"on any ambiguous timeout or retry, search the Sent mailbox for
 * `rfc822msgid:<message-id>` **before** attempting another send."*
 *
 * This function never sends. That is not an oversight to be fixed later: it is the
 * property the whole design rests on, and it is enforced by the fact that it holds no
 * message to send — only an id to look for.
 */
export async function reconcileAttempt(
  db: Db,
  mail: MailProvider,
  attemptId: string,
  rfc822MessageId: string,
): Promise<SendOutcome> {
  const attempt = await db.sendAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    select: { draftId: true },
  })

  const found = await mail.findByMessageId(rfc822MessageId)
  if (found) {
    // The send landed and the response was lost. Record it and stop.
    await markSent(db, attemptId, attempt.draftId, found.providerMessageId, found.threadId ?? null, true)
    await writeAudit(db, {
      actorType: 'system',
      actorId: 'send',
      action: 'send.reconciled',
      subjectType: 'SendAttempt',
      subjectId: attemptId,
      metadata: {
        rfc822MessageId,
        providerMessageId: found.providerMessageId,
        outcome: 'found_in_mailbox_no_second_send',
      },
    })
    return { status: 'sent', attemptId, providerMessageId: found.providerMessageId, reconciled: true }
  }

  await markFailed(db, attemptId, attempt.draftId, 'reconciliation found no sent message')
  await writeAudit(db, {
    actorType: 'system',
    actorId: 'send',
    action: 'send.reconciled',
    subjectType: 'SendAttempt',
    subjectId: attemptId,
    metadata: { rfc822MessageId, outcome: 'not_found_marked_failed' },
  })
  return { status: 'failed', attemptId, detail: 'reconciliation found no sent message' }
}

/**
 * Reconciles every `in_flight` attempt — the recovery path a worker runs at startup.
 *
 * An `in_flight` row is the residue of a crash between the write and the outcome, and
 * it is exactly the state Part G's first proving test creates: *"kill the worker after
 * the Gmail call but before the response is recorded; restart; assert the
 * reconciliation search finds the sent message and no second send is issued."*
 */
export async function reconcileInFlight(
  db: Db,
  mail: MailProvider,
  opts: { limit?: number } = {},
): Promise<SendOutcome[]> {
  const rows = await db.sendAttempt.findMany({
    where: { status: 'in_flight' },
    select: { id: true, rfc822MessageId: true },
    orderBy: { attemptedAt: 'asc' },
    take: opts.limit ?? 50,
  })
  const out: SendOutcome[] = []
  for (const row of rows) {
    out.push(await reconcileAttempt(db, mail, row.id, row.rfc822MessageId))
  }
  return out
}

async function markSent(
  db: Db,
  attemptId: string,
  draftId: string,
  providerMessageId: string,
  threadId: string | null,
  reconciled: boolean,
): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.sendAttempt.update({
      where: { id: attemptId },
      data: {
        status: 'sent',
        providerMessageId,
        providerThreadId: threadId,
        ...(reconciled ? { reconciledAt: new Date() } : {}),
      },
    })
    await tx.draft.update({ where: { id: draftId }, data: { status: 'sent' } })
    await tx.deliveryEvent.create({
      data: {
        sendAttemptId: attemptId,
        eventType: reconciled ? 'reconciled' : 'sent',
        occurredAt: new Date(),
      },
    })
  })
}

async function markFailed(db: Db, attemptId: string, draftId: string, detail: string): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.sendAttempt.update({ where: { id: attemptId }, data: { status: 'failed' } })
    // Back to `approved`, not to `sent` and not to `gate_failed`: the human's approval
    // still stands and the message still exists. A7 says a mismatch returns a draft to
    // `awaiting_approval`; a transport failure is not a mismatch and must not quietly
    // discard an approval the operator already gave.
    await tx.draft.update({ where: { id: draftId }, data: { status: 'approved' } })
    await tx.deliveryEvent.create({
      data: {
        sendAttemptId: attemptId,
        eventType: 'failed',
        occurredAt: new Date(),
        raw: { detail },
      },
    })
  })
}

export type { SendPlan }
