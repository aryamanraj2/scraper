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

export type CompanySeed = {
  externalId: string
  name: string
  website: string | null
  batch?: string | undefined
  locations?: string[] | undefined
  teamSize?: number | undefined
  tags?: string[] | undefined
  oneLiner?: string | undefined
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
