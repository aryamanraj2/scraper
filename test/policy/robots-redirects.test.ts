import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { checkRobots } from '../../src/core/policy/robots.js'
import { closeTestDb, testDb, truncateAll } from '../helpers/db.js'
import { mockAgent } from '../setup.js'

const USER_AGENT = 'outreach-intelligence-research/0.1 (+https://example.invalid/about)'

const opts = {
  userAgent: USER_AGENT,
  ttlSeconds: 86_400,
  hostExplicitlyAllowed: true,
}

beforeEach(async () => truncateAll())
afterAll(async () => closeTestDb())

function serve(origin: string, status: number, body: string, headers?: Record<string, string>) {
  mockAgent
    .get(origin)
    .intercept({ path: '/robots.txt', method: 'GET' })
    .reply(status, body, headers ? { headers } : undefined)
    .persist()
}

/**
 * The failure this covers was measured, not imagined: on the first live detection
 * run, 19 of 45 hosts served `robots.txt` with a 30x — overwhelmingly apex-to-www
 * — and every one came back `robots_disallowed`.
 *
 * That is wrong twice. It silently drops sources we are permitted to read, and it
 * makes the `robots_disallowed` counter mean "this host redirected", which
 * destroys the Part G signal that is supposed to reveal a source disappearing
 * behind a policy change.
 */
describe('robots.txt served through a redirect', () => {
  it('follows apex to www and honours the rules it finds there', async () => {
    serve('https://redir.example', 301, '', { location: 'https://www.redir.example/robots.txt' })
    serve('https://www.redir.example', 200, 'User-agent: *\nDisallow: /private\n')

    const allowed = await checkRobots(testDb(), 'https://redir.example/careers', opts)
    expect(allowed).toMatchObject({ allowed: true, parseOk: true })

    await truncateAll()
    const denied = await checkRobots(testDb(), 'https://redir.example/private/x', opts)
    expect(denied).toMatchObject({ allowed: false, parseOk: true })
  })

  it('carries a crawl-delay found after a redirect', async () => {
    serve('https://delayed.example', 302, '', { location: 'https://www.delayed.example/robots.txt' })
    serve('https://www.delayed.example', 200, 'User-agent: *\nCrawl-delay: 20\nAllow: /\n')

    const verdict = await checkRobots(testDb(), 'https://delayed.example/careers', opts)
    expect(verdict).toMatchObject({ allowed: true, crawlDelaySeconds: 20 })
  })

  /**
   * A `robots.txt` on somebody else's domain does not speak for this one. Honouring
   * it would let any host hand us a permissive policy it does not own.
   */
  it('refuses a cross-site redirect rather than trusting it', async () => {
    serve('https://sneaky.example', 302, '', { location: 'https://elsewhere.example/robots.txt' })
    serve('https://elsewhere.example', 200, 'User-agent: *\nAllow: /\n')

    const verdict = await checkRobots(testDb(), 'https://sneaky.example/careers', opts)
    expect(verdict).toMatchObject({ allowed: false, parseOk: false })
  })

  it('stops on a redirect loop', async () => {
    serve('https://loop.example', 302, '', { location: 'https://www.loop.example/robots.txt' })
    serve('https://www.loop.example', 302, '', { location: 'https://loop.example/robots.txt' })

    const verdict = await checkRobots(testDb(), 'https://loop.example/careers', opts)
    expect(verdict).toMatchObject({ allowed: false, parseOk: false })
  })
})

describe('robots.txt behaviour that must not change', () => {
  it('treats 404 as "no rules published", permissive only for an allowlisted host', async () => {
    serve('https://norules.example', 404, 'not found')

    const allowlisted = await checkRobots(testDb(), 'https://norules.example/careers', opts)
    expect(allowlisted).toMatchObject({ allowed: true, parseOk: true })

    await truncateAll()
    const unknown = await checkRobots(testDb(), 'https://norules.example/careers', {
      ...opts,
      hostExplicitlyAllowed: false,
    })
    expect(unknown).toMatchObject({ allowed: false })
  })

  it('treats a 5xx as restrictive — an unavailable policy is not permission', async () => {
    serve('https://broken.example', 503, 'upstream error')
    const verdict = await checkRobots(testDb(), 'https://broken.example/careers', opts)
    expect(verdict).toMatchObject({ allowed: false, parseOk: false })
  })

  it('caches the followed result, so the redirect is walked once', async () => {
    serve('https://cached.example', 301, '', { location: 'https://www.cached.example/robots.txt' })
    serve('https://www.cached.example', 200, 'User-agent: *\nDisallow: /nope\n')

    const first = await checkRobots(testDb(), 'https://cached.example/ok', opts)
    expect(first.source).toBe('network')

    const second = await checkRobots(testDb(), 'https://cached.example/ok', opts)
    expect(second).toMatchObject({ source: 'cache', allowed: true })

    const row = await testDb().robotsCache.findUnique({ where: { host: 'cached.example' } })
    expect(row?.parseOk).toBe(true)
    expect(row?.body).toContain('Disallow: /nope')
  })
})
