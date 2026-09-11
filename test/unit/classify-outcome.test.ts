import { describe, expect, it } from 'vitest'
import { classifyBounce, classifyReply } from '../../src/outreach/send/classify-outcome.js'

/**
 * A12's first gap: *"Bounce hardness (hard vs soft) undefined — a soft bounce must not
 * permanently suppress."*
 *
 * The fixtures below are shaped like real delivery status notifications (RFC 3464),
 * because the field that decides the answer — `Status:` — lives inside the DSN part
 * rather than in anything a human reads.
 */

const dsn = (status: string, diagnostic: string) =>
  [
    'Reporting-MTA: dns; googlemail.com',
    '',
    'Final-Recipient: rfc822; someone@example.com',
    'Action: failed',
    `Status: ${status}`,
    `Diagnostic-Code: smtp; ${diagnostic}`,
  ].join('\n')

describe('classifyBounce', () => {
  it('reads a 5.x.x enhanced status as HARD', () => {
    const result = classifyBounce({
      from: 'mailer-daemon@googlemail.com',
      subject: 'Delivery Status Notification (Failure)',
      bodyText: dsn('5.1.1', "550-5.1.1 The email account that you tried to reach does not exist."),
    })
    expect(result.kind).toBe('bounce')
    if (result.kind !== 'bounce') throw new Error('unreachable')
    expect(result.hardness).toBe('hard')
    expect(result.providerCode).toBe('5.1.1')
    expect(result.inferred).toBe(false)
  })

  it('reads a 4.x.x enhanced status as SOFT', () => {
    const result = classifyBounce({
      from: 'mailer-daemon@googlemail.com',
      subject: 'Delivery Status Notification (Delay)',
      bodyText: dsn('4.2.2', '452 4.2.2 The recipient mailbox is over quota'),
    })
    expect(result.kind).toBe('bounce')
    if (result.kind !== 'bounce') throw new Error('unreachable')
    expect(result.hardness).toBe('soft')
    expect(result.providerCode).toBe('4.2.2')
  })

  it('treats a 2.x.x DSN as NOT a bounce — it is a delivery receipt', () => {
    // Suppressing on this would permanently block someone who received the mail
    // perfectly well, which is the worst kind of false positive available here.
    const result = classifyBounce({
      from: 'mailer-daemon@googlemail.com',
      subject: 'Delivery Status Notification (Relayed)',
      bodyText: dsn('2.0.0', '250 2.0.0 OK'),
    })
    expect(result.kind).toBe('not_bounce')
  })

  it('falls back to the SMTP reply code when no enhanced status is present', () => {
    const hard = classifyBounce({
      from: 'postmaster@example.com',
      subject: 'Undeliverable: Internship enquiry',
      bodyText: 'Diagnostic-Code: smtp; 550 No such user here',
    })
    expect(hard.kind).toBe('bounce')
    if (hard.kind !== 'bounce') throw new Error('unreachable')
    expect(hard.hardness).toBe('hard')

    const soft = classifyBounce({
      from: 'postmaster@example.com',
      subject: 'Undeliverable: Internship enquiry',
      bodyText: 'Diagnostic-Code: smtp; 421 Service not available, try later',
    })
    if (soft.kind !== 'bounce') throw new Error('unreachable')
    expect(soft.hardness).toBe('soft')
  })

  it('classifies an unreadable bounce as SOFT, and marks it inferred', () => {
    // The considered choice, not the lazy one — see the module header. Hardness decides
    // only whether an irreversible, HMAC-backed suppression is written; the lead is
    // stopped either way, so nothing is retried. Writing an irreversible record on a
    // guess is the wrong trade, and `inferred` is what makes the guess visible.
    const result = classifyBounce({
      from: 'mailer-daemon@some-host.example',
      subject: 'Mail delivery failed: returning message to sender',
      bodyText: 'Your message could not be delivered. No further information is available.',
    })
    expect(result.kind).toBe('bounce')
    if (result.kind !== 'bounce') throw new Error('unreachable')
    expect(result.hardness).toBe('soft')
    expect(result.providerCode).toBeNull()
    expect(result.inferred).toBe(true)
  })

  it('does not read an ordinary reply as a bounce', () => {
    for (const body of [
      'Thanks for getting in touch — we do take interns, let me check with the team.',
      'Hi Aryaman, could you send over a portfolio link?',
      'We had a delivery problem with our product last week, but your timing is good.',
    ]) {
      expect(
        classifyBounce({ from: 'recruiter@acme.example', subject: 'Re: Internship enquiry', bodyText: body }).kind,
        body,
      ).toBe('not_bounce')
    }
  })
})

describe('classifyReply', () => {
  it('reads an answer to our own opt-out line as an opt-out', () => {
    // The sentence this system actually sends is "If you'd rather I didn't write
    // again, say so and I won't." These are what "saying so" looks like.
    for (const body of [
      "I'd rather you didn't write again, thanks.",
      'Please do not contact me again.',
      'Remove me from your list.',
      'Unsubscribe',
      'Not interested, thanks.',
      'Please stop emailing this address.',
    ]) {
      expect(classifyReply({ subject: 'Re: Internship enquiry', bodyText: body }), body).toBe('opt_out')
    }
  })

  it('reads a redirect as wrong_contact, not as an opt-out', () => {
    for (const body of [
      "I'm not the right person for this — try our careers team.",
      'Wrong department, sorry.',
      "I don't handle recruiting.",
      'This inbox is not monitored.',
    ]) {
      expect(classifyReply({ subject: 'Re: Internship enquiry', bodyText: body }), body).toBe('wrong_contact')
    }
  })

  it('reads an out-of-office as an auto-reply, which changes nothing', () => {
    for (const body of [
      'I am currently away from the office and will respond on my return.',
      'Out of office: back Monday.',
      'Automatic reply: on parental leave until March.',
    ]) {
      expect(classifyReply({ subject: 'Automatic reply', bodyText: body }), body).toBe('auto_reply')
    }
  })

  it('trusts RFC 3834 over the text, so a vacation note cannot read as an opt-out', () => {
    // A signature block containing "not interested in unsolicited vendor mail" on an
    // out-of-office would otherwise suppress a contact who never saw the message.
    const result = classifyReply({
      subject: 'Re: Internship enquiry',
      bodyText: 'I am away. Please note I am not interested in unsolicited vendor email.',
      headers: { 'auto-submitted': 'auto-replied' },
    })
    expect(result).toBe('auto_reply')
  })

  it('reads a genuine reply as a reply', () => {
    for (const body of [
      'Thanks for reaching out — we do run a summer internship, applications open in November.',
      'Can you send your resume as a PDF?',
      "Interesting background. What's your availability?",
    ]) {
      expect(classifyReply({ subject: 'Re: Internship enquiry', bodyText: body }), body).toBe('reply')
    }
  })

  it('prefers the stronger reading when both an opt-out and a redirect appear', () => {
    // "I'm the wrong person, and don't write again" is a request to stop.
    const result = classifyReply({
      subject: 'Re: Internship enquiry',
      bodyText: "I'm not the right person for this, and please do not contact me again.",
    })
    expect(result).toBe('opt_out')
  })
})
