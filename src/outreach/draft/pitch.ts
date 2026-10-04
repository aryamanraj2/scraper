/**
 * The fixed candidate sentence of F6 step 3b's message: the intro.
 *
 * It is NOT a template. It states facts about the candidate, so it is a cited sentence
 * carrying the `ApprovedClaim` rows it rests on, and it is dropped rather than sent
 * uncited if any of them is withdrawn. Its wording differs from the claims, so
 * containment (F3 §4.2) cannot check it; `test/unit/pitch.test.ts` checks that every
 * number and capitalised name in it appears in those claims, through the table below.
 *
 * (The second and third passes also fixed two story sentences per track here. The
 * fourth pass, from the operator's sample drafts, hands the story to the session so it
 * can pick and order the projects for each company: `outreach_draft@2`.)
 */

export type PitchSentence = {
  text: string
  /** `ApprovedClaim.key`s, resolved to ids at composition. */
  claimKeys: string[]
}

/**
 * Who the candidate is: its own line after the greeting. Year of study and graduation
 * come from claims the operator supplied; the branch is deliberately left out, by the
 * operator's instruction.
 */
export const INTRO: PitchSentence = {
  text: "I'm Aryaman, a third-year B.Tech student at NSUT Delhi, graduating 2028.",
  claimKeys: ['identity.full_name', 'education.degree', 'education.year_of_study', 'education.expected_graduation'],
}

/**
 * Short or plain forms a sentence may use for what a claim states. The only liberty the
 * bound in the header allows, and it is listed so it can be read.
 */
export const ABBREVIATIONS: Record<string, string> = {
  'B.Tech': 'Bachelor of Technology',
  NSUT: 'Netaji Subhas University of Technology',
  Aryaman: 'Aryaman Raj Jaiswal',
}
