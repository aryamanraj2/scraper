import type { SentenceRole } from './message.js'

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
  candidateName: string
}

export type SentenceTemplate = {
  id: string
  role: SentenceRole
  /** Rendered from `TemplateVars` only — there is no free-text parameter, by design. */
  render: (v: TemplateVars) => string
}

export const SENTENCE_TEMPLATES: SentenceTemplate[] = [
  {
    id: 'tldr.intern_inquiry@1',
    role: 'tldr',
    render: (v) =>
      `TL;DR — second-year CS undergrad asking whether ${v.companyName} takes engineering interns; one specific reason I'm writing to you below, resume linked.`,
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
    // handover.md §8 and B4: accurate sender identity, and an easy way to decline. The
    // opt-out line is adopted voluntarily (B4) rather than because a regime was found
    // to apply, and it is deliberately a human sentence rather than RFC 8058's
    // one-click header, which H6 reserves for bulk volume this system never reaches.
    render: (v) => `${v.candidateName}\n\nIf you'd rather I didn't write again, say so and I won't.`,
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
