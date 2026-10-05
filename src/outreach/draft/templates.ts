import type { SentenceRole } from './message.js'
import { EMAIL_MODULE_IDS, EMAIL_TRACKS } from '../../core/llm/tasks.js'
import { MODULES, ROUTE, TLDR } from './email.js'

/**
 * The registered sentences a composer may emit without a citation.
 *
 * ## Why a registry rather than free text
 *
 * `message.ts` requires an `evidenceId` on a company sentence and an
 * `approvedClaimId` on a candidate one. A role with neither requirement would be the
 * obvious way around both: write the company claim into the greeting and no check
 * fires. F3 §4.2 closed the identical hole by making a deterministic answer exactly
 * the concatenation of the claims it cites, so traceability is checkable by
 * containment instead of by a human reading for smuggled facts.
 *
 * The analogue here is that an uncited sentence must be one of these, rendered from
 * values already in the database. There is no template that takes an arbitrary
 * string, so nothing a model or a page wrote can reach the message through a role
 * that is not checked.
 *
 * ## What these deliberately do NOT say
 *
 * No praise ("I love what you're building" — `handover.md` §8 names it), no claim
 * about the company, no claim about the candidate, no assertion about hiring plans.
 * They are scaffolding: what this is, where the resume is, what is being asked. Every
 * substantive sentence in the message carries a citation, which is the whole point of
 * §10.1's instruction not to weaken the rule for throughput.
 *
 * ## Length
 *
 * §10.8: *"Short. Model it on a real reply-getting cold email, not a cover letter."*
 * `handover.md` §8 says the same from the other side — the long sample in the
 * screenshots is reference material, not the output length target. These are one line
 * each on purpose.
 */

export type TemplateVars = {
  companyName: string
  /** The role the message is about, when there is one. Case 4 messages have none. */
  roleTitle: string | null
  /** H3: a link on first contact, never an attachment. */
  resumeUrl: string
  /** `identity.full_name`, verbatim. */
  candidateName: string
  /** The first word of `identity.full_name`. The sign-off a person actually writes. */
  candidateFirstName?: string
  /** `identity.portfolio` and `identity.github`, scheme stripped, joined with " · ". */
  candidateLinks?: string | null
  /**
   * The recipient's first name, from the `full_name` column of the operator's import
   * line stored as the contact's Evidence. Null for a role inbox, and for a named
   * contact whose stored name does not yield one (see `greeting.ts`).
   */
  recipientFirstName?: string | null
  /** `voice.hook`'s text, first letter lowered and final period dropped, to open the TL;DR. */
  hookClause?: string
}

export type SentenceTemplate = {
  id: string
  role: SentenceRole
  /** Rendered from `TemplateVars` only — there is no free-text parameter, by design. */
  render: (v: TemplateVars) => string
  /**
   * A CITED template (`outreach_draft@3`): candidate copy the operator wrote, sitting in a
   * cited role and citing these claims. `validateComposition` refuses the sentence unless
   * it cites every one of them.
   */
  claimKeys?: string[]
  /** Fixed copy. `validateComposition` refuses a sentence whose text differs by a byte. */
  text?: string
}

export const SENTENCE_TEMPLATES: SentenceTemplate[] = [
  {
    id: 'tldr.intern_inquiry@1',
    role: 'tldr',
    // RETIRED (F6 step 3b), and its text deliberately deleted. It hardcoded a branch and
    // a year of study: two candidate facts no ApprovedClaim states, sitting in a role
    // that cites nothing, and neither was true. That is the exact smuggling route the
    // registry exists to close. The id stays registered so a stored composition that
    // cites it still validates; nothing may render it again.
    render: () => {
      throw new Error('tldr.intern_inquiry@1 is retired: it stated candidate facts no ApprovedClaim supports')
    },
  },
  {
    id: 'tldr.posted_role@1',
    role: 'tldr',
    render: (v) =>
      `TL;DR — I'm interested in ${v.roleTitle ?? 'an engineering role'} at ${v.companyName} and wanted to check it's open to interns before I apply.`,
  },
  {
    id: 'tldr.post_application@1',
    role: 'tldr',
    render: (v) =>
      `TL;DR — I applied for ${v.roleTitle ?? 'an engineering role'} at ${v.companyName} through your careers page; one note on why, in case it's useful to whoever picks it up.`,
  },
  {
    id: 'resume.link@1',
    role: 'resume_link',
    // Linked, never attached: H3, and B5 — a new sending domain plus an attachment is
    // the worst deliverability combination available.
    render: (v) => `Resume: ${v.resumeUrl}`,
  },
  {
    id: 'ask.intern_availability@1',
    role: 'ask',
    // A question with one obvious answer costs the recipient a sentence to decline,
    // which is what makes it answerable at all. No "let me know if there's a fit".
    render: (v) =>
      `Is ${v.companyName} taking engineering interns in that window, or is there a better route than this address?`,
  },
  {
    id: 'ask.route_unclear@1',
    role: 'ask',
    render: (v) =>
      `I couldn't find a public application route for this — is there one I missed, or is ${v.companyName} not hiring interns right now?`,
  },
  {
    id: 'ask.post_application@1',
    role: 'ask',
    render: () => `No action needed if it's already in the pile — happy to answer anything useful.`,
  },
  {
    id: 'signoff.plain@1',
    role: 'signoff',
    // RETIRED for composition (F6), and kept registered on purpose. Stored drafts cite
    // this id: `validateComposition` refuses an unregistered templateId, so deleting it
    // would fail every stored @1 draft at the gate and in `verify:f4`. Never edit the
    // rendered text either — a stored sentence must stay what this id renders.
    //
    // handover.md §8 and B4: accurate sender identity, and an easy way to decline. The
    // opt-out line is adopted voluntarily (B4) rather than because a regime was found
    // to apply, and it is deliberately a human sentence rather than RFC 8058's
    // one-click header, which H6 reserves for bulk volume this system never reaches.
    render: (v) => `${v.candidateName}\n\nIf you'd rather I didn't write again, say so and I won't.`,
  },
  {
    id: 'signoff.plain@2',
    role: 'signoff',
    // F6-DECISIONS §3.2, the operator's call: the mail should read as hand-written, and
    // nobody signs a one-off note with a decline line. Sender identity stays accurate
    // (the name here, the From header). The opt-out mechanism is the reply itself —
    // `classifyReply` reads "stop" or "not interested" as an opt-out (recall over
    // precision) and suppresses, and the system sends each person one message only.
    render: (v) => v.candidateName,
  },
  // F6 step 3b — the operator-approved message shape. Everything here is scaffolding or
  // a value drawn from a claim or the recipient's own Evidence; the candidate facts in
  // the message are cited sentences (`pitch.ts`), never template text.
  {
    id: 'tldr.hook@2',
    role: 'hook',
    // A CITED role: the first clause is `voice.hook` and the sentence cites it. The
    // template only records the shape; the second clause asserts nothing.
    render: (v) => `tldr; ${v.hookClause ?? ''}, and I'd love to spend an internship building at ${v.companyName}.`,
  },
  {
    id: 'greeting.named@1',
    role: 'greeting',
    render: (v) => `Hi ${v.recipientFirstName ?? 'there'},`,
  },
  {
    id: 'greeting.inbox@1',
    role: 'greeting',
    render: () => 'Hi there,',
  },
  {
    id: 'bridge.close_to_problem@1',
    role: 'bridge',
    render: () => "That's the kind of problem I want to be close to.",
  },
  {
    id: 'ask.call@1',
    role: 'ask',
    render: () => 'Would you be open to a quick 15-minute call in the next couple of weeks?',
  },
  {
    id: 'ask.call_or_route@1',
    role: 'ask',
    // A role inbox is read by someone who may not be the person to talk to, so it also
    // gets the one-sentence way to decline: tell us who is.
    render: () =>
      'Would you be open to a quick 15-minute call in the next couple of weeks, or point me to whoever handles intern hiring?',
  },
  // Second pass of step 3b (the operator: "unnecessarily short and unnaturally direct").
  // The ask says why a call, the inbox variant asks for a redirect politely, and the
  // close thanks the reader. Still no fact about either party.
  {
    id: 'bridge.ask_intern@1',
    role: 'bridge',
    // Closes the opening paragraph: who I am, why you, so here is the question. The ask
    // paragraph's "If there's room..." answers back to it.
    render: (v) => `So I wanted to ask whether ${v.companyName} takes engineering interns.`,
  },
  // Fourth pass: the operator's sample drafts. Plain, short, no preamble.
  {
    id: 'ask.call@3',
    role: 'ask',
    render: () => 'Would you be open to a 15-minute call in the next couple of weeks?',
  },
  {
    id: 'ask.call_or_route@3',
    role: 'ask',
    render: () =>
      'Would you be open to a 15-minute call in the next couple of weeks? If this is the wrong inbox, a pointer to whoever handles intern hiring would mean a lot.',
  },
  {
    id: 'signoff.plain@5',
    role: 'signoff',
    render: (v) =>
      ['Thanks,', v.candidateFirstName ?? v.candidateName, ...(v.candidateLinks ? [v.candidateLinks] : [])].join('\n'),
  },
  {
    id: 'ask.call@2',
    role: 'ask',
    render: () =>
      "If there's room for an intern on your team, would you be open to a quick 15-minute call in the next couple of weeks?",
  },
  {
    id: 'ask.call_or_route@2',
    role: 'ask',
    render: () =>
      "If there's room for an intern on your team, would you be open to a quick 15-minute call in the next couple of weeks? If I've reached the wrong inbox, a pointer to whoever handles intern hiring would mean a lot.",
  },
  {
    id: 'resume.link@2',
    role: 'resume_link',
    render: (v) => `My resume is here: ${v.resumeUrl}`,
  },
  {
    id: 'signoff.plain@4',
    role: 'signoff',
    render: (v) =>
      [
        'Thanks for reading, and looking forward to hearing from you!',
        '',
        'Best,',
        v.candidateFirstName ?? v.candidateName,
        ...(v.candidateLinks ? [v.candidateLinks] : []),
      ].join('\n'),
  },
  {
    id: 'signoff.plain@3',
    role: 'signoff',
    render: (v) =>
      [
        'Looking forward to hearing from you!',
        '',
        'Best,',
        v.candidateFirstName ?? v.candidateName,
        ...(v.candidateLinks ? [v.candidateLinks] : []),
      ].join('\n'),
  },
  // F6-EMAIL-SPEC, `outreach_draft@3`: the operator's own email. The tldr and the modules
  // are cited templates (see `claimKeys`); the rest is scaffolding.
  ...EMAIL_TRACKS.map(
    (track): SentenceTemplate => ({
      id: `tldr.${track}@1`,
      role: 'opener',
      render: (v) => TLDR[track].render(v.companyName),
      claimKeys: TLDR[track].claimKeys,
    }),
  ),
  ...EMAIL_MODULE_IDS.map(
    (id): SentenceTemplate => ({
      id: `module.${id}@1`,
      role: 'candidate',
      render: () => MODULES[id].text,
      claimKeys: MODULES[id].claimKeys,
      text: MODULES[id].text,
    }),
  ),
  {
    id: 'greeting.team@1',
    role: 'greeting',
    render: (v) => `Hi ${v.companyName} team,`,
  },
  {
    id: 'bridge.keep_building@1',
    role: 'bridge',
    render: () => "That's the problem I keep building around.",
  },
  {
    // outreach_draft@4: the Temple email's own bridge.
    id: 'bridge.built_for@1',
    role: 'bridge',
    render: () => "I've been building for exactly that.",
  },
  {
    id: 'resume.link@3',
    role: 'resume_link',
    render: (v) => `My resume is here: ${v.resumeUrl}.`,
  },
  {
    id: 'ask.talk@1',
    role: 'ask',
    render: () => 'Would love to talk.',
  },
  {
    id: 'ask.talk_or_route@1',
    role: 'ask',
    render: () => `Would love to talk. ${ROUTE}`,
  },
  {
    id: 'signoff.plain@6',
    role: 'signoff',
    render: (v) => ['Best,', v.candidateFirstName ?? v.candidateName, ...(v.candidateLinks ? [v.candidateLinks] : [])].join('\n'),
  },
]

const BY_ID = new Map(SENTENCE_TEMPLATES.map((t) => [t.id, t]))

export const TEMPLATE_IDS: ReadonlySet<string> = new Set(SENTENCE_TEMPLATES.map((t) => t.id))

export function findTemplate(id: string): SentenceTemplate | undefined {
  return BY_ID.get(id)
}

/**
 * Renders a registered template, or throws.
 *
 * Throwing rather than returning a placeholder is deliberate: an unrenderable
 * template is a bug in the composer, and a placeholder would be text nobody wrote
 * sitting in a message about to be sent to a stranger.
 */
export function renderTemplate(id: string, vars: TemplateVars): string {
  const template = findTemplate(id)
  if (!template) throw new Error(`unregistered sentence template "${id}"`)
  return template.render(vars)
}
