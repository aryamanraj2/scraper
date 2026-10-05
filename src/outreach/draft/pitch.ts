/**
 * The fixed candidate sentences of the message: the intro and the internship window.
 *
 * They are NOT templates. They state facts about the candidate, so each is a cited
 * sentence carrying the `ApprovedClaim` rows it rests on, and is dropped rather than sent
 * uncited if any of them is withdrawn. Their wording differs from the claims, so
 * containment (F3 §4.2) cannot check them; `test/unit/pitch.test.ts` checks that every
 * number and capitalised name in them appears in those claims, through the table below.
 *
 * (Step 3b's passes put story sentences here and then handed them to a session. The
 * operator's own email, `outreach_draft@3`, fixes them again as module templates in
 * `email.ts`, each citing its claims; only the intro and the window stay here.)
 */

export type PitchSentence = {
  text: string
  /** `ApprovedClaim.key`s, resolved to ids at composition. */
  claimKeys: string[]
}

/**
 * Who the candidate is (F6-EMAIL-SPEC). Year of study and the university come from
 * claims the operator supplied; the branch is deliberately left out, by the operator's
 * instruction, and so is the graduation year the step-3b intro carried. The renderer
 * folds an `outreach_draft@3` session's `via` into this sentence before its period.
 */
export const INTRO: PitchSentence = {
  text: "I'm Aryaman, a third-year student at NSUT Delhi.",
  claimKeys: ['identity.full_name', 'education.year_of_study', 'education.degree'],
}

/**
 * The internship window, shortened from `eligibility.internship_window` (F6-EMAIL-SPEC).
 * It says "internship" because otherwise the email never does.
 */
export const WINDOW: PitchSentence = {
  text: "I'm looking for an internship from Dec 2026 to Jan 2027, or Jun to Aug 2027.",
  claimKeys: ['eligibility.internship_window'],
}

/**
 * Short or plain forms a sentence may use for what a claim states. The only liberty the
 * bound in the header allows, and it is listed so it can be read.
 */
export const ABBREVIATIONS: Record<string, string> = {
  'B.Tech': 'Bachelor of Technology',
  NSUT: 'Netaji Subhas University of Technology',
  Aryaman: 'Aryaman Raj Jaiswal',
  Canadian: 'Canada',
}
