import { describe, expect, it } from 'vitest'
import { matchTracks, confidenceFrom, MIN_CONFIDENCE } from '../../src/intel/taxonomy/matcher.js'
import { ROLE_TRACKS, GENERIC_TERMS } from '../../src/intel/taxonomy/role-tracks.js'

const field = (text: string, name = 'company:one_liner') => [{ field: name, text }]

describe('role taxonomy vocabularies', () => {
  it('covers the four tracks handover.md §6 names', () => {
    expect(ROLE_TRACKS.map((t) => t.key)).toEqual(['ios_android', 'ai_engineer', 'sde', 'swe'])
  })

  it('gives every track both positive and negative vocabulary', () => {
    for (const track of ROLE_TRACKS) {
      expect(track.positive.length).toBeGreaterThan(0)
      expect(track.negative.length).toBeGreaterThan(0)
    }
  })

  /**
   * A generic term no vocabulary contains is inert: the "generic cannot carry a
   * label" rule would then pass because nothing matched at all, which is a
   * different fact.
   */
  it('keeps every generic term reachable from some vocabulary', () => {
    const all = new Set(ROLE_TRACKS.flatMap((t) => t.positive))
    for (const term of GENERIC_TERMS) expect(all.has(term)).toBe(true)
  })
})

describe('a label is never applied without supporting text (handover.md §5.3, §6)', () => {
  it('does not make a company an AI Engineer target for having "AI" in its name', () => {
    const result = matchTracks(field('Acme AI — the AI-powered CRM for AI-driven teams', 'company:name'))
    expect(result.matches.map((m) => m.track)).not.toContain('ai_engineer')
    expect(result.primary).toBeNull()
  })

  it('does apply the label when the engineering evidence is there', () => {
    const result = matchTracks(
      field('We serve fine-tuned PyTorch models with a RAG pipeline over our own embeddings.'),
    )
    const ai = result.matches.find((m) => m.track === 'ai_engineer')
    expect(ai).toBeDefined()
    expect(ai!.specificTerms).toEqual(expect.arrayContaining(['pytorch', 'rag', 'embeddings']))
  })

  it('carries the matched snippet verbatim, so the label can be shown to be supported', () => {
    const text = 'Our mobile team writes SwiftUI for iOS and ships weekly.'
    const result = matchTracks(field(text))
    const snippet = result.matches
      .flatMap((m) => m.snippets)
      .find((s) => s.term === 'swiftui')
    expect(snippet).toBeDefined()
    expect(text).toContain(snippet!.snippet.slice(0, 30))
  })

  it('records the field a match came from', () => {
    const result = matchTracks([{ field: 'posting:Senior iOS Engineer', text: 'Swift, UIKit, Xcode' }])
    expect(result.matches[0]!.snippets[0]!.field).toBe('posting:Senior iOS Engineer')
  })

  it('never emits a match with zero snippets', () => {
    const result = matchTracks(field('We sell artisanal candles to a loyal customer base.'))
    for (const match of result.matches) expect(match.snippets.length).toBeGreaterThan(0)
    expect(result.matches).toEqual([])
  })
})

describe('generic terms cannot carry a label on their own', () => {
  it('keeps every generic term below the label floor', () => {
    const generics = [...GENERIC_TERMS].join(' and ')
    const result = matchTracks(field(generics))
    expect(result.matches).toEqual([])
  })

  it('marks a generic match as generic in the snippet', () => {
    const result = matchTracks(field('We use React and TypeScript on our cloud platform.'))
    const swe = result.considered.find((m) => m.track === 'swe')!
    expect(swe.snippets.some((s) => s.generic)).toBe(true)
    expect(swe.snippets.some((s) => !s.generic)).toBe(true)
  })
})

describe('confidence', () => {
  it('rises with distinct specific terms, not with repetition', () => {
    const repeated = matchTracks(field('Swift Swift Swift Swift Swift Swift'))
    const varied = matchTracks(field('Swift, SwiftUI and Xcode'))
    const repeatedIos = repeated.considered.find((m) => m.track === 'ios_android')!
    const variedIos = varied.considered.find((m) => m.track === 'ios_android')!
    expect(variedIos.confidence).toBeGreaterThan(repeatedIos.confidence)
  })

  it('is damped, not vetoed, by counter-evidence', () => {
    const clean = confidenceFrom(4, 0, 0)
    const damped = confidenceFrom(4, 0, 2)
    expect(damped).toBeLessThan(clean)
    expect(damped).toBeGreaterThan(0)
  })

  it('stays inside 0..1', () => {
    expect(confidenceFrom(0, 0, 0)).toBe(0)
    expect(confidenceFrom(50, 50, 0)).toBeLessThanOrEqual(1)
  })

  it('needs more than one generic hit to reach the floor', () => {
    expect(confidenceFrom(0, 3, 0)).toBeLessThan(MIN_CONFIDENCE)
  })
})

describe('primary track (A12: the tie-break must be recorded)', () => {
  it('records why the winner won', () => {
    const result = matchTracks(field('Swift, SwiftUI, UIKit, Xcode and Core ML on iOS.'))
    expect(result.primary!.track).toBe('ios_android')
    expect(result.primary!.reason).toMatch(/highest confidence/)
  })

  it('is deterministic across runs on identical input', () => {
    const text = 'Backend Go and Postgres, plus a React frontend in TypeScript.'
    const a = matchTracks(field(text))
    const b = matchTracks(field(text))
    expect(a.primary).toEqual(b.primary)
    expect(a.matches.map((m) => [m.track, m.confidence])).toEqual(
      b.matches.map((m) => [m.track, m.confidence]),
    )
  })

  it('explains a tie rather than resolving it silently', () => {
    const result = matchTracks(field('We use PyTorch for inference and Kotlin for Android.'))
    if (result.matches.length > 1 && result.matches[0]!.confidence === result.matches[1]!.confidence) {
      expect(result.primary!.reason).toMatch(/tie at confidence/)
    }
  })
})

describe('word boundaries', () => {
  it('does not match a vocabulary term inside a longer word', () => {
    const result = matchTracks(field('Our HTML emails and going-concern notes.'))
    const matched = result.considered.flatMap((m) => m.snippets.map((s) => s.term))
    expect(matched).not.toContain('ml')
    expect(matched).not.toContain('golang')
  })

  it('matches terms containing regex metacharacters', () => {
    const result = matchTracks(field('We build with Next.js and run CI/CD on every commit.'))
    const swe = result.considered.find((m) => m.track === 'swe')!
    expect(swe.specificTerms).toEqual(expect.arrayContaining(['next.js', 'ci/cd']))
  })
})

/**
 * F5b: `Opportunity.description` reaches the matcher as its own field, weighted
 * below the title. These pin the two properties the weight exists to give — that a
 * long body cannot outvote a short title, and that the title-only path is exactly
 * the function it was before the weight existed.
 */
describe('per-field weighting (F5b: the posting body)', () => {
  const IOS_TITLE = 'Senior iOS Engineer — Bengaluru'
  // The shape a real 6,000-character body has: a company overview that describes
  // the employer's stack, not this role.
  const BACKEND_BODY = `
    COMPANY OVERVIEW. We run a distributed systems platform on Kubernetes and
    Docker across AWS and GCP, with Postgres, Kafka and Redis behind a gRPC and
    REST API layer. Our backend is written in Java with microservices.
    ABOUT THE ROLE. You will own our iOS app, written in Swift and SwiftUI, and
    ship it through Xcode to the App Store.
  `

  it('leaves an unweighted field set byte-for-byte as it was', () => {
    const withoutWeight = matchTracks([{ field: 'posting:x', text: IOS_TITLE }])
    const withExplicitOne = matchTracks([{ field: 'posting:x', text: IOS_TITLE, weight: 1 }])
    expect(withExplicitOne).toEqual(withoutWeight)
  })

  /**
   * The weight damps a long field; it does not by itself decide which track a
   * POSTING carries. That guarantee is `matchOnePosting` in `collect.ts`, which
   * only lets a title-supported track take the primary slot — and it is tested
   * there, because it is a fact about postings rather than about text.
   */
  it('damps a long body rather than letting it speak at title volume', () => {
    const sdeOf = (weight?: number) =>
      matchTracks([
        { field: 'posting:x', text: IOS_TITLE },
        ...(weight === undefined
          ? [{ field: 'posting-body:x', text: BACKEND_BODY }]
          : [{ field: 'posting-body:x', text: BACKEND_BODY, weight }]),
      ]).considered.find((m) => m.track === 'sde')!

    expect(sdeOf(0.3).confidence).toBeLessThan(sdeOf().confidence)
    // Thirteen backend phrases in one body are still evidence, just not thirteen
    // phrases' worth: at parity the body alone saturates the track.
    expect(sdeOf().confidence).toBeGreaterThan(0.9)
    expect(sdeOf(0.3).confidence).toBeLessThan(0.85)
  })

  it('still lets a body supply a label the title cannot', () => {
    const titleOnly = matchTracks([{ field: 'posting:x', text: 'Software Engineer II' }])
    expect(titleOnly.matches).toHaveLength(0)

    const withBody = matchTracks([
      { field: 'posting:x', text: 'Software Engineer II' },
      { field: 'posting-body:x', text: BACKEND_BODY, weight: 0.3 },
    ])
    expect(withBody.matches.map((m) => m.track)).toContain('sde')
  })

  it('counts a phrase once, at its best field, however often it is restated', () => {
    const once = matchTracks([{ field: 'posting:x', text: 'iOS' }])
    const restated = matchTracks([
      { field: 'posting:x', text: 'iOS' },
      { field: 'posting-body:x', text: 'iOS. iOS. iOS. iOS. iOS.', weight: 0.3 },
    ])
    const ios = (r: typeof once) => r.considered.find((m) => m.track === 'ios_android')!
    expect(ios(restated).confidence).toBe(ios(once).confidence)
  })

  it('weights counter-evidence the same way it weights evidence', () => {
    const inTitle = matchTracks([{ field: 'posting:x', text: 'Backend Engineer, Account Manager Tools' }])
    const inBody = matchTracks([
      { field: 'posting:x', text: 'Backend Engineer' },
      { field: 'posting-body:x', text: 'You will partner with an account manager.', weight: 0.3 },
    ])
    const sde = (r: typeof inTitle) => r.considered.find((m) => m.track === 'sde')!
    expect(sde(inBody).confidence).toBeGreaterThan(sde(inTitle).confidence)
    expect(sde(inBody).negativeTerms).toEqual(['account manager'])
  })
})
