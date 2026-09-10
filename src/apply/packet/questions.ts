/**
 * The application questions a packet prefills.
 *
 * ## Two kinds, and why the split matters
 *
 * A **deterministic** question has one right answer that is already sitting in
 * `ApprovedClaim`: a name, a degree, a work-authorization status. Its answer is the
 * cited claims' own text, concatenated — nothing is reworded. That is not squeamish-
 * ness; it is what makes the traceability criterion mechanically true. If the answer
 * text is exactly the union of the claims it cites, then "every claim in a packet
 * traces to an `ApprovedClaim`" is checkable by string containment rather than by a
 * human reading for smuggled facts.
 *
 * A **judgment** question ("why this company") needs a sentence nobody has written
 * yet, drawn from company `Evidence` and candidate `ApprovedClaim` together. That is
 * the one thing in F3 the deterministic pipeline cannot do, so it goes to the
 * `HandoffLlmGateway` as an `LlmTask` and arrives later, or never.
 *
 * H10 binds either way: a packet whose judgment answers have not come back is still a
 * complete, usable packet with those questions listed as unanswered. The operator
 * fills them in at submit time. **A packet is never blocked on the LLM backlog.**
 */

export type PacketQuestionKind = 'deterministic' | 'judgment'

export type PacketQuestion = {
  key: string
  /** Shown to the operator. `{company}` is substituted; nothing else is. */
  prompt: string
  kind: PacketQuestionKind
  /**
   * Deterministic questions: the claims whose text becomes the answer, in order.
   * A key that resolves to no active claim makes the question unanswered — the
   * remaining claims are NOT silently used, because a partial answer to "are you
   * authorized to work here" is worse than no answer.
   */
  claimKeys?: string[]
  /** Judgment questions: the claim categories the session may draw on. */
  claimCategories?: string[]
  /** One line telling the operator why a question came back unanswered. */
  note?: string
}

export const PACKET_QUESTIONS: PacketQuestion[] = [
  {
    key: 'full_name',
    prompt: 'Full name',
    kind: 'deterministic',
    claimKeys: ['identity.full_name'],
  },
  {
    key: 'email',
    prompt: 'Email address',
    kind: 'deterministic',
    claimKeys: ['identity.email'],
  },
  {
    key: 'phone',
    prompt: 'Phone number',
    kind: 'deterministic',
    claimKeys: ['identity.phone'],
  },
  {
    key: 'location',
    prompt: 'Current location',
    kind: 'deterministic',
    claimKeys: ['identity.location'],
  },
  {
    key: 'links',
    prompt: 'GitHub / portfolio / LinkedIn',
    kind: 'deterministic',
    claimKeys: ['identity.github', 'identity.portfolio', 'identity.linkedin'],
  },
  {
    key: 'education',
    prompt: 'Education',
    kind: 'deterministic',
    claimKeys: ['education.degree'],
  },
  {
    key: 'expected_graduation',
    prompt: 'Expected graduation date',
    kind: 'deterministic',
    claimKeys: ['education.expected_graduation'],
    // Only reached if the claim is ever withdrawn. Inferring a date from the degree
    // start would be exactly the false claim handover.md §8 forbids — and would have
    // been wrong here, since the operator graduates in March rather than mid-year.
    note: 'No approved claim states a graduation date, and it cannot be inferred from the degree start date.',
  },
  {
    key: 'work_authorization',
    prompt: 'Are you legally authorized to work for {company}, and will you require sponsorship?',
    kind: 'deterministic',
    claimKeys: ['eligibility.work_authorization_india', 'eligibility.sponsorship_required_abroad'],
  },
  {
    key: 'remote_preference',
    prompt: 'Location / remote preference',
    kind: 'deterministic',
    claimKeys: ['eligibility.remote'],
  },
  {
    key: 'availability',
    prompt: 'When are you available to start, and for how long?',
    kind: 'deterministic',
    claimKeys: ['eligibility.internship_window'],
    // Only reached if the claim is ever withdrawn.
    note: 'No approved claim states an internship window.',
  },
  {
    key: 'why_company',
    prompt: 'Why do you want to work at {company}?',
    kind: 'judgment',
    claimCategories: ['experience', 'project', 'achievement', 'skill'],
    note: 'Needs a company-specific sentence grounded in stored Evidence; queued for a Claude Code session.',
  },
  {
    key: 'relevant_experience',
    prompt: 'What in your experience is most relevant to this role?',
    kind: 'judgment',
    claimCategories: ['experience', 'project', 'achievement', 'skill'],
    note: 'Needs the posting read against the candidate record; queued for a Claude Code session.',
  },
]

export function renderPrompt(question: PacketQuestion, companyName: string): string {
  return question.prompt.replace('{company}', companyName)
}

export const DETERMINISTIC_QUESTIONS = PACKET_QUESTIONS.filter((q) => q.kind === 'deterministic')
export const JUDGMENT_QUESTIONS = PACKET_QUESTIONS.filter((q) => q.kind === 'judgment')
