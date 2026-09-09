import type { RoleTrackKey } from '../../../generated/prisma/enums.js'

/**
 * The four role tracks from `handover.md` §6, as controlled vocabularies.
 *
 * These are seeded into `RoleTrack` rows rather than living only in code, because
 * F3's evidence viewer and F4's drafting both need to show the operator WHY a
 * track was assigned, and a vocabulary that exists only inside a function cannot
 * be displayed or diffed. The rows are the projection; this file is the source.
 *
 * ## The rule these exist to enforce
 *
 * `handover.md` §6: *"A YC company with 'AI' in its name is not automatically an
 * AI Engineer target: it needs technical/company/role evidence."* The matcher
 * therefore cannot apply a label unsupported by text — every assignment carries
 * the matched snippets that produced it. That is why the vocabularies are phrases
 * rather than single tokens wherever a single token would fire on marketing copy:
 * "ai" matches a company name, "pytorch" does not.
 *
 * Negative keywords do not veto a track outright. They are counter-evidence,
 * subtracted from the positive evidence, because a page that says "we are hiring
 * a sales engineer" and also "our backend is Go" is genuinely both.
 */

export type TrackVocabulary = {
  key: RoleTrackKey
  displayName: string
  /**
   * Phrases whose presence is evidence FOR the track. Matched case-insensitively
   * on word boundaries, so "go" does not match "going" and "ml" does not match
   * "html".
   */
  positive: string[]
  /** Phrases that are evidence AGAINST, per §6's "negative/low-value signals". */
  negative: string[]
}

/**
 * Phrases that fire on almost any technology company and therefore prove nothing
 * on their own. They are still matched and still recorded — a page that says "AI"
 * has said something — but at a fraction of a specific term's weight, and never
 * enough on their own to reach the label floor (`matcher.ts`).
 *
 * Every term here also appears in at least one track's positive list, asserted by
 * test. A generic term that no vocabulary matches would be inert decoration, and
 * the §6 rule it exists to enforce would be passing for the wrong reason.
 */
export const GENERIC_TERMS = new Set([
  'ai',
  'artificial intelligence',
  'ml',
  'model',
  'mobile',
  'app',
  'api',
  'cloud',
  'database',
  'infrastructure',
  'software engineer',
  'developer',
  'web',
  'platform',
])

export const ROLE_TRACKS: readonly TrackVocabulary[] = [
  {
    key: 'ios_android',
    displayName: 'iOS / Android',
    positive: [
      'ios', 'android', 'swift', 'swiftui', 'uikit', 'objective-c', 'kotlin',
      'jetpack compose', 'react native', 'flutter', 'mobile engineer',
      'mobile engineering', 'mobile app', 'mobile sdk', 'xcode', 'app store',
      'google play', 'on-device', 'core ml', 'coreml', 'arkit',
      'mobile', 'app',
    ],
    // §6: "generic consumer app with no mobile engineering evidence".
    negative: ['no mobile', 'web only', 'web-only', 'desktop only'],
  },
  {
    key: 'ai_engineer',
    displayName: 'AI Engineer',
    positive: [
      'pytorch', 'tensorflow', 'jax', 'llm', 'large language model', 'rag',
      'retrieval augmented', 'embeddings', 'vector database', 'inference',
      'model serving', 'fine-tuning', 'fine tuning', 'machine learning',
      'deep learning', 'computer vision', 'nlp', 'natural language processing',
      'ml platform', 'ml infrastructure', 'ml engineer', 'evaluation harness',
      'agents', 'transformers', 'hugging face', 'ai engineer',
      'ai', 'artificial intelligence', 'ml', 'model',
    ],
    // §6: "'AI-powered' marketing only, without engineering evidence".
    negative: ['ai-powered', 'ai powered', 'powered by ai', 'ai-driven', 'ai driven'],
  },
  {
    key: 'sde',
    displayName: 'SDE',
    positive: [
      'backend', 'back-end', 'distributed systems', 'microservices', 'golang',
      'java', 'node.js', 'nodejs', 'postgres', 'postgresql', 'mysql',
      'kafka', 'redis', 'grpc', 'rest api', 'scalability',
      'kubernetes', 'docker', 'aws', 'gcp', 'systems engineer',
      'integrations',
      // Deliberately NOT 'go': the language name is a common English word, and a
      // word-boundary match on it fires on ordinary prose. 'golang' is the
      // unambiguous spelling; a Go shop that never writes it is a miss we accept
      // over a false positive on every careers page that says "go".
      'api', 'cloud', 'database', 'infrastructure',
    ],
    // §6: "non-engineering operations/support roles".
    negative: ['customer support', 'operations associate', 'account manager', 'sales engineer'],
  },
  {
    key: 'swe',
    displayName: 'SWE',
    positive: [
      'frontend', 'front-end', 'full-stack', 'fullstack', 'full stack', 'react',
      'next.js', 'nextjs', 'typescript', 'javascript', 'python', 'product engineer',
      'platform engineer', 'web application', 'testing', 'test coverage',
      'ci/cd', 'developer experience',
      'software engineer', 'developer', 'web', 'platform',
    ],
    // §6: "only management, sales, or design roles".
    negative: ['engineering manager', 'director of engineering', 'vp of engineering', 'head of design'],
  },
]

export const ROLE_TRACK_BY_KEY: Record<RoleTrackKey, TrackVocabulary> = Object.fromEntries(
  ROLE_TRACKS.map((t) => [t.key, t]),
) as Record<RoleTrackKey, TrackVocabulary>

export const ROLE_TRACK_KEYS: readonly RoleTrackKey[] = ROLE_TRACKS.map((t) => t.key)
