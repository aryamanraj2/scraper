import { createHash, randomUUID } from 'node:crypto'

/**
 * A9 step 1 — the deterministic RFC 5322 `Message-ID`.
 *
 * > *"Derive a deterministic RFC 5322 `Message-ID` from `SendAttempt.idempotency_key`
 * > (stable domain part on the owned sending domain) and set it explicitly in the raw
 * > MIME. Do not let Gmail generate one — a generated ID is unknowable after an
 * > ambiguous failure."*
 *
 * That last clause is the whole argument. Gmail has no idempotency-key parameter, so
 * the key has to travel inside the message, and the only field that both survives
 * transmission and is searchable afterwards is the `Message-ID`. If we let the
 * provider mint it, then the one moment we need it — a timeout where we do not know
 * whether the send landed — is exactly the moment we cannot ask for it.
 *
 * ## Why a hash rather than the key itself
 *
 * An idempotency key is ours and could be any string; a `msg-id` is a constrained
 * grammar (RFC 5322 §3.6.4 `dot-atom-text`), and an unescaped character would produce
 * a header a provider may rewrite or reject. Hashing gives a fixed-length token drawn
 * from `[0-9a-f]`, which is inside `dot-atom-text` with no escaping at all, and it is
 * still a pure function of the key: the same `SendAttempt` always derives the same id,
 * on any machine, after any crash.
 *
 * ## Why the OWNED domain and not the sending account's
 *
 * A9 says "stable domain part on the owned sending domain". The pilot sends from a
 * personal Gmail and migrates to Workspace on the owned domain around F6. If the
 * domain part tracked the sending account, every Message-ID derived before the
 * migration would stop being reconstructible from its `SendAttempt` afterwards — and
 * reconciling a historical send is precisely what the derivation exists for.
 *
 * A `Message-ID` domain is an identifier, not a routing target. RFC 5322 §3.6.4 asks
 * only that it be globally unique; it explicitly does not have to resolve to the
 * sending host.
 */

/** Prefix, so a message of ours is recognisable in a mailbox by eye. */
const LOCAL_PREFIX = 'oi'

export function deriveMessageId(idempotencyKey: string, domain: string): string {
  const digest = createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)
  return `<${LOCAL_PREFIX}.${digest}@${domain}>`
}

/**
 * The `rfc822msgid:` search term for a derived id.
 *
 * Gmail's own documentation gives the form with the angle brackets intact —
 * `from:someuser@example.com rfc822msgid:<somemsgid@example.com> is:unread` — so they
 * are kept rather than stripped. Verified against
 * https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list
 * and https://support.google.com/mail/answer/7190 on 2026-09-11.
 */
export function rfc822MsgIdQuery(messageId: string): string {
  return `rfc822msgid:${messageId}`
}

/**
 * The idempotency key for one first touch or follow-up.
 *
 * Deterministic in the inputs that define "this message to this person in this cycle",
 * so a retry after a crash derives the same key, finds the same `SendAttempt` row, and
 * reconciles rather than sending again. The `draftId` is in it because a re-approved
 * draft is a different artefact with a different `approval_hash`; the touch number is
 * in it because a follow-up is a genuinely different message.
 */
export function deriveIdempotencyKey(parts: {
  draftId: string
  contactId: string
  campaignCycle: string
  touchNumber: number
}): string {
  return `${parts.draftId}:${parts.contactId}:${parts.campaignCycle}:t${parts.touchNumber}`
}

/**
 * A per-process token for the fake provider's synthetic ids. Never used for a real
 * Message-ID — that one must be derived, never random, or A9 does not work.
 */
export function syntheticProviderId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16)
}
