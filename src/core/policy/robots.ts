import robotsParser from 'robots-parser'
import type { Db } from '../audit/audit-log.js'
import { rawGet } from './http/raw-client.js'
import { normalizeHost } from './host-lists.js'
import { isSameSite } from './registrable-domain.js'

export type RobotsVerdict = {
  allowed: boolean
  crawlDelaySeconds: number | null
  /** False when the file was missing, errored, or could not be parsed. */
  parseOk: boolean
  source: 'cache' | 'network'
}

export type RobotsOptions = {
  userAgent: string
  ttlSeconds: number
  /** Explicitly allowlisted hosts tolerate a missing robots.txt; unknown hosts do not. */
  hostExplicitlyAllowed: boolean
  now?: () => Date
}

/**
 * D4 preflight step 2.
 *
 * robots.txt is fetched, cached with a TTL, and evaluated for OUR declared
 * user-agent against the EXACT path — not the origin, and not a prefix.
 *
 * The asymmetry that matters: a missing or unparseable robots file is treated as
 * restrictive, not permissive, for hosts that are not explicitly allowlisted. The
 * common default (absent robots means crawl freely) is wrong for this system,
 * because the hosts we reach without an explicit allow entry are exactly the ones
 * we know least about.
 *
 * That asymmetry only produces honest answers if we actually READ the file. A
 * `robots.txt` served with a 30x — overwhelmingly apex-to-`www` — was previously
 * recorded as unparseable and therefore refused, so `robots_disallowed` came to
 * mean "the host redirected" for 19 of the first 45 hosts F1 tried. Wrong twice
 * over: it silently dropped permitted sources, and it corrupted the very
 * refusal counter Part G relies on to notice a source disappearing behind a
 * policy change. Redirects are now followed, bounded, and only within the same
 * registrable domain — a `robots.txt` that points at somebody else's site does
 * not speak for this one, and is treated as restrictive.
 */
export async function checkRobots(
  db: Db,
  url: string,
  opts: RobotsOptions,
): Promise<RobotsVerdict> {
  const parsed = new URL(url)
  const host = normalizeHost(parsed.host)
  const now = (opts.now ?? (() => new Date()))()

  const cached = await db.robotsCache.findUnique({ where: { host } })
  const fresh =
    cached && now.getTime() - cached.fetchedAt.getTime() < cached.ttlSeconds * 1000

  if (cached && fresh) {
    return evaluate(cached.body, cached.parseOk, url, opts, 'cache')
  }

  const fetched = await fetchRobotsFollowingRedirects(
    `${parsed.protocol}//${parsed.host}/robots.txt`,
    opts.userAgent,
  )
  const { body, parseOk, statusCode } = fetched

  await db.robotsCache.upsert({
    where: { host },
    create: { host, body, parseOk, ttlSeconds: opts.ttlSeconds, fetchedAt: now, statusCode },
    update: { body, parseOk, ttlSeconds: opts.ttlSeconds, fetchedAt: now, statusCode },
  })

  return evaluate(body, parseOk, url, opts, 'network')
}

const ROBOTS_MAX_BYTES = 512 * 1024
const ROBOTS_MAX_REDIRECTS = 3
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308])

/**
 * Fetches `robots.txt`, following same-site redirects.
 *
 * Redirects are followed here rather than by an undici interceptor for the same
 * reason as everywhere else in this system: an automatically-followed redirect
 * lands somewhere nobody checked. Each hop is re-derived and re-checked against
 * the original host's registrable domain before it is issued, and a cross-site
 * hop ends the walk with `parseOk = false` — restrictive.
 *
 * A 4xx keeps its existing meaning: "no rules published", which `evaluate` treats
 * as permission ONLY for a host we already decided to allow explicitly.
 */
async function fetchRobotsFollowingRedirects(
  startUrl: string,
  userAgent: string,
): Promise<{ body: string; parseOk: boolean; statusCode: number | null }> {
  const originHost = new URL(startUrl).host
  let url = startUrl
  let statusCode: number | null = null

  for (let hop = 0; hop <= ROBOTS_MAX_REDIRECTS; hop += 1) {
    let res
    try {
      res = await rawGet(url, { userAgent, maxBytes: ROBOTS_MAX_BYTES })
    } catch {
      return { body: '', parseOk: false, statusCode }
    }
    statusCode = res.statusCode

    if (res.statusCode >= 200 && res.statusCode < 300) {
      // A truncated robots file is worse than none: the rule that would have
      // disallowed us may be in the part we did not read.
      if (res.truncated) return { body: '', parseOk: false, statusCode }
      return { body: res.body, parseOk: true, statusCode }
    }
    if (res.statusCode >= 400 && res.statusCode < 500) {
      return { body: '', parseOk: true, statusCode }
    }
    if (!REDIRECT_CODES.has(res.statusCode)) {
      return { body: '', parseOk: false, statusCode }
    }

    const raw = res.headers['location']
    const location = Array.isArray(raw) ? raw[0] : raw
    if (!location) return { body: '', parseOk: false, statusCode }

    let next: URL
    try {
      next = new URL(location, url)
    } catch {
      return { body: '', parseOk: false, statusCode }
    }
    if (next.protocol !== 'https:' && next.protocol !== 'http:') {
      return { body: '', parseOk: false, statusCode }
    }
    if (!isSameSite(next.host, originHost)) {
      return { body: '', parseOk: false, statusCode }
    }
    url = next.toString()
  }

  return { body: '', parseOk: false, statusCode }
}

function evaluate(
  body: string,
  parseOk: boolean,
  url: string,
  opts: RobotsOptions,
  source: 'cache' | 'network',
): RobotsVerdict {
  if (!parseOk) {
    return { allowed: false, crawlDelaySeconds: null, parseOk: false, source }
  }
  if (body.trim() === '') {
    // No rules published. Permissive only where we already made a deliberate
    // allow decision about the host.
    return {
      allowed: opts.hostExplicitlyAllowed,
      crawlDelaySeconds: null,
      parseOk: true,
      source,
    }
  }

  const robots = robotsParser(url, body)
  const verdict = robots.isAllowed(url, opts.userAgent)
  const delay = robots.getCrawlDelay(opts.userAgent)
  return {
    // robots-parser returns undefined when it cannot decide. Undecided is a
    // refusal here, for the same reason unparseable is.
    allowed: verdict === undefined ? opts.hostExplicitlyAllowed : verdict,
    crawlDelaySeconds: typeof delay === 'number' ? delay : null,
    parseOk: true,
    source,
  }
}
