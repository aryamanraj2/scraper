/**
 * Bounce and reply classification — A12's first gap, closed.
 *
 * > *"Bounce hardness (hard vs soft) undefined — a soft bounce must not permanently
 * > suppress."*
 *
 * Pure functions over the text of a received message. No database, no clock, no
 * network — which is what lets the hard cases be pinned by unit tests rather than
 * discovered in a mailbox.
 */

export type BounceHardnessValue = 'hard' | 'soft'

export type BounceClassification =
  | {
      kind: 'bounce'
      hardness: BounceHardnessValue
      /** The RFC 3463 enhanced status or the SMTP reply code, verbatim, if present. */
      providerCode: string | null
      diagnostic: string | null
      /**
       * True when the message is recognisably a bounce but published no code we could
       * read, so the hardness below is a default rather than a reading. Carried so an
       * operator can review it instead of it looking like a measurement.
       */
      inferred: boolean
    }
  | { kind: 'not_bounce' }

/** Addresses that generate delivery status notifications. */
const DAEMON_PATTERN = /(mailer-daemon|postmaster|mail\.delivery\.subsystem)@/i

const BOUNCE_SUBJECT_PATTERN =
  /(delivery status notification|undeliverable|returned mail|mail delivery (failed|subsystem)|failure notice|delivery incomplete|address not found)/i

/** RFC 3464 `Status:` field — `Status: 5.1.1`. The most reliable signal available. */
const DSN_STATUS = /^status:\s*([245])\.(\d{1,3})\.(\d{1,3})/im

/** RFC 3464 `Diagnostic-Code:` — `Diagnostic-Code: smtp; 550 5.1.1 User unknown`. */
const DIAGNOSTIC_CODE = /^diagnostic-code:\s*(.+)$/im

/** A bare SMTP reply code inside the diagnostic text. */
const SMTP_REPLY = /\b([245])\d{2}\b/

/**
 * ## Why an unreadable bounce is classified SOFT, and why that is not the weak choice
 *
 * The instinct is that an unknown bounce should be treated as hard, because retrying a
 * dead address damages the sending reputation. That instinct is right about the
 * *retry* and wrong about the *suppression*, and the two are separable.
 *
 * A12's rule is specifically that a soft bounce must not permanently suppress. It says
 * nothing about continuing to send, and nothing here does: a soft bounce still stops
 * the lead and cancels any pending follow-up (`ingest-outcomes.ts`). So the address is
 * not retried either way, and the only thing hardness decides is whether a permanent,
 * HMAC-backed `Suppression` row is written — a row A10 deliberately makes survive the
 * contact's deletion, and therefore one that is effectively irreversible.
 *
 * Writing an irreversible record on a guess is the wrong trade. Classifying soft, not
 * retrying, and flagging `inferred` for review gets the deliverability protection
 * without the permanence.
 */
export function classifyBounce(message: {
  from: string
  subject: string
  bodyText: string
}): BounceClassification {
  const fromDaemon = DAEMON_PATTERN.test(message.from)
  const bounceSubject = BOUNCE_SUBJECT_PATTERN.test(message.subject)
  const hasDsnPart = /^(reporting-mta|final-recipient|action:\s*failed)/im.test(message.bodyText)

  if (!fromDaemon && !bounceSubject && !hasDsnPart) return { kind: 'not_bounce' }

  const diagnosticMatch = DIAGNOSTIC_CODE.exec(message.bodyText)
  const diagnostic = diagnosticMatch?.[1]?.trim() ?? null

  const status = DSN_STATUS.exec(message.bodyText)
  if (status) {
    const klass = status[1]
    // RFC 3463: 2.x.x success, 4.x.x persistent transient failure, 5.x.x permanent.
    // A 2.x.x in a message that otherwise looks like a DSN is a delivery *receipt*,
    // not a failure — treating it as a bounce would suppress a contact who received
    // the mail perfectly well.
    if (klass === '2') return { kind: 'not_bounce' }
    return {
      kind: 'bounce',
      hardness: klass === '5' ? 'hard' : 'soft',
      providerCode: `${status[1]}.${status[2]}.${status[3]}`,
      diagnostic,
      inferred: false,
    }
  }

  if (diagnostic) {
    const reply = SMTP_REPLY.exec(diagnostic)
    if (reply?.[1] === '5') {
      return { kind: 'bounce', hardness: 'hard', providerCode: reply[0], diagnostic, inferred: false }
    }
    if (reply?.[1] === '4') {
      return { kind: 'bounce', hardness: 'soft', providerCode: reply[0], diagnostic, inferred: false }
    }
  }

  return { kind: 'bounce', hardness: 'soft', providerCode: null, diagnostic, inferred: true }
}

export type ReplyClassification = 'opt_out' | 'wrong_contact' | 'auto_reply' | 'reply'

/**
 * The opt-out line this system sends is *"If you'd rather I didn't write again, say so
 * and I won't."* — B4's voluntarily-adopted control, and H6's reason for preferring a
 * human sentence over RFC 8058's one-click header at this volume.
 *
 * A human sentence has to be read by something. These patterns are deliberately narrow
 * for the same reason F2 §4.12's injection patterns are: *"ignore" alone is a normal
 * English word; "ignore all previous instructions" is not something a careers page
 * says to a reader.* The analogue here is that "no" is a normal reply and "please
 * don't contact me again" is not ambiguous.
 *
 * **Precision is not the priority here — recall is.** A missed opt-out means writing
 * again to someone who asked us not to, which is the single worst outcome available to
 * this system. A false positive means one lead is dropped. So where a phrase is
 * genuinely ambiguous it counts as an opt-out, and the operator sees the thread.
 */
const OPT_OUT_PATTERNS: RegExp[] = [
  /\b(unsubscribe|opt[- ]?out)\b/i,
  /\b(do not|don'?t|please don'?t|stop)\s+(contact|email|e-mail|message|write|reach out)/i,
  /\b(remove|take)\s+me\s+(from|off)\b/i,
  /\bno longer wish to (receive|be contacted)/i,
  /\bnot interested\b/i,
  /\brather you didn'?t\b/i,
]

const WRONG_CONTACT_PATTERNS: RegExp[] = [
  /\b(not|wrong)\s+the\s+right\s+(person|contact|address|team)\b/i,
  /\bwrong (person|address|department|team|inbox)\b/i,
  /\bi don'?t handle\b/i,
  /\b(you|please) (should|could|can) (contact|email|reach|write to)\b.*\binstead\b/i,
  /\bforwarded (this )?to\b/i,
  /\bthis (inbox|address) (is not|isn'?t) monitored\b/i,
]

const AUTO_REPLY_PATTERNS: RegExp[] = [
  /\bout of (the )?office\b/i,
  /\bauto(matic)?[- ]?(reply|response|responder)\b/i,
  /\bon (annual |parental |holiday )?leave\b/i,
  /\bi am currently away\b/i,
  /\bwe('| ha)ve received your (message|email|enquiry|inquiry)\b/i,
  /\bthank you for (contacting|reaching out|your (message|email))\b.*\b(will (get back|respond)|ticket|case number)\b/i,
]

export function classifyReply(message: {
  subject: string
  bodyText: string
  headers?: Record<string, string>
}): ReplyClassification {
  // RFC 3834 and the de-facto Microsoft header. Trusted before any text matching:
  // a vacation responder that happens to contain "not interested" in a signature
  // would otherwise read as an opt-out from someone who never saw the message.
  const headers = message.headers ?? {}
  const autoSubmitted = headers['auto-submitted'] ?? headers['Auto-Submitted']
  if (autoSubmitted && autoSubmitted.toLowerCase() !== 'no') return 'auto_reply'
  if (headers['x-autoreply'] ?? headers['x-autorespond'] ?? headers['X-Autoreply']) return 'auto_reply'

  const text = `${message.subject}\n${message.bodyText}`

  // Auto-reply is checked before opt-out and wrong-contact, and only via the patterns
  // that are unambiguous about being machine-generated. An out-of-office is not a
  // decision by the recipient about being contacted.
  if (AUTO_REPLY_PATTERNS.some((p) => p.test(text))) return 'auto_reply'

  // Opt-out beats wrong-contact: "I'm the wrong person, and please don't write again"
  // is a request to stop, and the stronger reading is the safe one.
  if (OPT_OUT_PATTERNS.some((p) => p.test(text))) return 'opt_out'
  if (WRONG_CONTACT_PATTERNS.some((p) => p.test(text))) return 'wrong_contact'
  return 'reply'
}
