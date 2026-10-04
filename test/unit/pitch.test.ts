import { describe, expect, it } from 'vitest'
import { APPROVED_CLAIMS } from '../../src/apply/claims/claims-data.js'
import { ABBREVIATIONS, INTRO } from '../../src/outreach/draft/pitch.js'
import { SENTENCE_TEMPLATES } from '../../src/outreach/draft/templates.js'
import { recipientFirstName } from '../../src/outreach/draft/greeting.js'

/**
 * F6 step 3b. Two halves of one rule: a candidate fact enters a message only through a
 * sentence that cites the claim it comes from.
 */

const claimText = new Map(APPROVED_CLAIMS.map((c) => [c.key, c.text]))

/**
 * Words that state something about the candidate: education, standing, achievements.
 * Deliberately narrow. Its own first test is that it catches the sentence it exists for.
 */
const CANDIDATE_FACT =
  /\b(undergrad\w*|student|freshman|sophomore|(first|second|third|fourth|final)[- ]year|graduat\w*|degree|b\.?\s?tech|bachelor|cs|computer science|university|college|nsut|gpa|cgpa|won(?!['’])|winner|installs?|years? of experience)\b/i

/** Templates whose text predates the rule and is retired, never rendered again. */
const RETIRED = new Set(['tldr.intern_inquiry@1'])

const SENTINELS = {
  companyName: 'QQCO',
  roleTitle: 'QQROLE',
  resumeUrl: 'https://qq.example/r.pdf',
  candidateName: 'QQNAME',
  candidateFirstName: 'QQFIRST',
  candidateLinks: 'qq.example',
  recipientFirstName: 'QQRECIP',
  hookClause: 'qqhook',
}

describe('no template states a candidate fact (F6 step 3b)', () => {
  it('the detector catches the sentence that motivated it', () => {
    expect(CANDIDATE_FACT.test('TL;DR — second-year CS undergrad asking whether Acme takes interns')).toBe(true)
  })

  it('every live template renders only scaffolding and values drawn from claims or Evidence', () => {
    for (const t of SENTENCE_TEMPLATES.filter((t) => !RETIRED.has(t.id))) {
      let text = t.render(SENTINELS)
      for (const v of Object.values(SENTINELS)) text = text.split(v).join('')
      expect(CANDIDATE_FACT.test(text), `${t.id}: ${text}`).toBe(false)
    }
  })

  it('the retired TL;DR can never render again, though its id still resolves', () => {
    const retired = SENTENCE_TEMPLATES.find((t) => t.id === 'tldr.intern_inquiry@1')!
    expect(() => retired.render(SENTINELS)).toThrow(/retired/)
  })
})

describe('the fixed intro is bounded by the claims it cites', () => {
  const all = [INTRO]
  // Sentence openers, and "AI" — a word, not a fact any claim would need to state.
  const LEADING = new Set(['I', "I'm", 'My', 'On', 'During', 'At', 'The', 'It', 'This', 'AI'])

  it('cites claims that exist', () => {
    for (const p of all) for (const k of p.claimKeys) expect(claimText.has(k), `${k} in "${p.text}"`).toBe(true)
  })

  it('states no number or name its cited claims do not', () => {
    // Every number, and every capitalised word that is not a sentence opener, must be
    // found in the cited claims' text, directly or through the listed abbreviations.
    for (const p of all) {
      const source = p.claimKeys.map((k) => claimText.get(k) ?? '').join(' \n ')
      const text = p.text.replace('{company}', 'acme')
      const tokens = (text.match(/\d[\d,.]*\+?%?|\b[A-Z][\w.'’+-]*/g) ?? [])
        .map((t) => t.replace(/[.,;:]+$/, '').replace(/['’]s$/, ''))
        .filter((t) => !LEADING.has(t))
      for (const t of tokens) {
        const expanded = ABBREVIATIONS[t]
        expect(source.includes(t) || (expanded !== undefined && source.includes(expanded)), `"${t}" in "${p.text}" is not in ${p.claimKeys.join(', ')}`).toBe(true)
      }
    }
  })

})

describe('the greeting uses a stored first name, never an invented one', () => {
  const line = (name: string, email = 'person@acme.example') =>
    `acme.example,${email},${name},Senior Recruiter,named_talent,hunter,,"a note, with a comma",valid`
  const named = (name: string, email?: string) => ({
    contactType: 'named_talent',
    emailNormalized: 'person@acme.example',
    evidence: { excerpt: line(name, email), sourceUrl: 'operator-entry://hunter/operator' },
  })

  it('reads the first word of the stored full_name', () => {
    expect(recipientFirstName(named('Priya Example'))).toBe('Priya')
    expect(recipientFirstName(named('"Anne-Marie O’Neil"'))).toBe('Anne-Marie')
  })

  it('says "there" to a role inbox', () => {
    expect(recipientFirstName({ ...named('Priya Example'), contactType: 'careers_alias' })).toBeNull()
  })

  it('says "there" rather than guess at an initial, a title or a lower-case fragment', () => {
    for (const name of ['J. Example', 'Dr. Example', 'priya example', '']) {
      expect(recipientFirstName(named(name)), name).toBeNull()
    }
  })

  it('never reads a name off an import line about someone else, or off a web page', () => {
    expect(recipientFirstName(named('Priya Example', 'other@acme.example'))).toBeNull()
    expect(
      recipientFirstName({ ...named('Priya Example'), evidence: { excerpt: line('Priya Example'), sourceUrl: 'https://acme.example/team' } }),
    ).toBeNull()
  })
})
