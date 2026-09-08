import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GatedFetcher } from '../../src/core/interfaces/providers.js'

const FIXTURE_DIR = join(process.cwd(), 'test', 'fixtures')

export function readFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf8')
}

export function readFixtureJson<T = unknown>(name: string): T {
  return JSON.parse(readFixture(name)) as T
}

export function readFixtureMeta(name: string): { url: string; statusCode: number; note: string } {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.meta.json`), 'utf8'))
}

export type StubResponse = {
  statusCode?: number
  body: string
  truncated?: boolean
  /** Needed to exercise the redirect path: `{ location: '...' }`. */
  headers?: Record<string, string | string[] | undefined>
}

/**
 * A `GatedFetcher` that answers from a table instead of the network.
 *
 * Part G's test layers require every adapter to be exercised "against both
 * real-with-fixtures and fake adapters". This is the fake half: it records every
 * URL asked for, so a test can assert not just what an adapter parsed but that it
 * requested exactly one thing — the check that catches an adapter quietly adding a
 * second call.
 *
 * It deliberately implements the same surface `FetchPolicyGate` exposes to
 * adapters and nothing more. An adapter that needs anything else is an adapter
 * that has reached around the gate.
 */
export class StubFetcher implements GatedFetcher {
  readonly requested: string[] = []

  constructor(
    private readonly responses: Record<string, StubResponse>,
    private readonly refusals: Record<string, 'host_denied' | 'robots_disallowed' | 'terms_prohibited' | 'rate_limited' | 'budget_exhausted'> = {},
  ) {}

  async check(url: string): Promise<
    { allowed: true; rateDelayMs: number } | { allowed: false; reason: 'host_denied' | 'robots_disallowed' | 'terms_prohibited' | 'rate_limited' | 'budget_exhausted' }
  > {
    const refusal = this.refusals[url]
    return refusal ? { allowed: false, reason: refusal } : { allowed: true, rateDelayMs: 0 }
  }

  async fetchText(url: string): Promise<
    | { ok: true; response: { statusCode: number; body: string; headers: Record<string, string | string[] | undefined>; url: string; truncated: boolean } }
    | { ok: false; reason: 'host_denied' | 'robots_disallowed' | 'terms_prohibited' | 'rate_limited' | 'budget_exhausted' }
  > {
    this.requested.push(url)
    const refusal = this.refusals[url]
    if (refusal) return { ok: false, reason: refusal }

    const stub = this.responses[url]
    if (!stub) {
      return {
        ok: true,
        response: { statusCode: 404, body: 'not found', headers: {}, url, truncated: false },
      }
    }
    return {
      ok: true,
      response: {
        statusCode: stub.statusCode ?? 200,
        body: stub.body,
        headers: stub.headers ?? {},
        url,
        truncated: stub.truncated ?? false,
      },
    }
  }
}
