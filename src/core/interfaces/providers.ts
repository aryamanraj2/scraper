import type { z } from 'zod'
import type { EvidenceSourceType } from '../../../generated/prisma/enums.js'
import type { FetchPolicyGate } from '../policy/fetch-policy-gate.js'

/**
 * D5. Every external dependency sits behind one of these, each with a
 * fixture-backed fake. No test touches a live source (handover.md §11).
 *
 * These are type-only seams at F0: F1 fills SeedProvider and AtsProvider, F2 fills
 * WebResearchProvider and HiringSignalProvider, F4 the LlmGateway, F5 MailProvider.
 * Declaring them now is what stops each milestone inventing its own shape.
 */

export type Evidence = {
  id: string
  sourceUrl: string
  sourceType: EvidenceSourceType
  /** Verbatim, <=500 chars, never paraphrased. */
  excerpt: string
  /** Change detection without a refetch. */
  contentHash: string
  observedAt: Date
  confidence: number
}

/**
 * What a seed source knows about a company, plus the provenance that makes it
 * usable.
 *
 * `source` is not optional and is not decoration: `handover.md` §11 requires every
 * stored field to be reconstructible from what the source actually said, so a seed
 * that arrives without its record cannot be written to the database at all. F1
 * writes one `Evidence` row per source key from `source.record`.
 */
export type SeedSourceRecord = {
  /** The feed URL this record came from. */
  url: string
  /** The record exactly as the source published it. Never normalized in place. */
  record: Record<string, unknown>
  observedAt: Date
  /** Stable hash of the whole record — see core/evidence/content-hash.ts. */
  contentHash: string
}

export type CompanySeed = {
  externalId: string
  name: string
  website: string | null
  batch?: string | undefined
  locations?: string[] | undefined
  countries?: string[] | undefined
  teamSize?: number | undefined
  tags?: string[] | undefined
  oneLiner?: string | undefined
  longDescription?: string | undefined
  isHiring?: boolean | undefined
  /** The source's own lifecycle string, retained verbatim (handover.md §6). */
  lifecycleStatus?: string | undefined
  source: SeedSourceRecord
}

export type Posting = {
  externalId: string
  title: string
  url: string
  location: string | null
  postedAt: Date | null
  content: string
}

export interface SeedProvider {
  listCompanies(since?: Date): AsyncIterable<CompanySeed>
}

export interface AtsProvider {
  readonly slug: string
  /**
   * Lever publishes no discovery endpoint, so slug resolution is part of
   * detection rather than an afterthought (B6).
   */
  detect(careersUrl: string): Promise<{ boardToken: string } | null>
  /**
   * The feed URL for a board. Part of the contract rather than an implementation
   * detail, because a board read produces an `Evidence` row about the board
   * ITSELF — the open-posting count behind B2's hiring signal — and that row has
   * to cite the feed it came from. Citing whichever posting happened to be first
   * would make provenance depend on the order of somebody else's array, and would
   * leave an empty board with nothing to cite at all.
   */
  boardUrl(boardToken: string): string
  listPostings(boardToken: string): Promise<Posting[]>
}

export interface WebResearchProvider {
  map(domain: string): Promise<string[]>
  fetch(url: string): Promise<{ text: string; evidence: Evidence }>
}

export type SignalQuery = { companyDomain: string; since?: Date }
export type SignalHit = { evidence: Evidence; weight: number }

export interface HiringSignalProvider {
  search(q: SignalQuery): Promise<SignalHit[]>
}

export type OutboundMessage = {
  to: string
  subject: string
  bodyText: string
  fromIdentity: string
  replyTo: string
  /** Set on a follow-up so it threads under the original. */
  inReplyToMessageId?: string | undefined
}

export type InboundMessage = {
  providerMessageId: string
  threadId: string
  from: string
  receivedAt: Date
  snippet: string
}

/**
 * A9. Gmail has no native idempotency-key parameter, so the key travels inside the
 * message: the implementation derives a deterministic RFC 5322 Message-ID from
 * `idempotencyKey` on the owned sending domain and sets it explicitly in the raw
 * MIME. Gmail must not generate one — a generated ID is unknowable after an
 * ambiguous failure, which is exactly when it is needed.
 *
 * `findByMessageId` is the reconciliation search (`rfc822msgid:` over Sent) that a
 * retry runs BEFORE considering another send. It is the reason the required scope
 * is `gmail.modify`: `gmail.metadata` cannot read the bodies reply classification
 * needs, and a send-only scope cannot perform this search at all.
 */
export interface MailProvider {
  send(m: OutboundMessage, idempotencyKey: string): Promise<{ providerMessageId: string }>
  findByMessageId(messageId: string): Promise<{ providerMessageId: string } | null>
  listReplies(threadIds: string[]): Promise<InboundMessage[]>
}

/**
 * H10: the LLM is optional. The system must degrade to manual drafting, never to a
 * broken pipeline — Claude API usage is the one separately-billed component, and it
 * must be switchable off.
 *
 * The schema requirement is not decoration: the drafting schema requires an
 * `evidenceId` on every personalization sentence, so an unsupported claim is a
 * SCHEMA error rather than a review finding. That is the mechanism behind
 * handover.md §11's golden test.
 */
export interface LlmGateway {
  readonly enabled: boolean
  complete<T>(s: {
    promptVersion: string
    schema: z.ZodType<T>
    input: unknown
    maxTokens: number
  }): Promise<{ value: T; costUsd: number }>
}

/**
 * Adapters receive a gate, never a client. This alias exists so that constructor
 * signatures across F1-F2 say so out loud.
 */
export type GatedFetcher = Pick<FetchPolicyGate, 'check' | 'fetchText'>
