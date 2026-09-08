import robotsParser from 'robots-parser'
import type { Db } from '../audit/audit-log.js'
import { rawGet } from './http/raw-client.js'
import { normalizeHost } from './host-lists.js'

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

  let body = ''
  let parseOk = false
  let statusCode: number | null = null
  try {
    const res = await rawGet(`${parsed.protocol}//${parsed.host}/robots.txt`, {
      userAgent: opts.userAgent,
      maxBytes: 512 * 1024,
    })
    statusCode = res.statusCode
    if (res.statusCode >= 200 && res.statusCode < 300) {
      body = res.body
      parseOk = true
    } else if (res.statusCode >= 400 && res.statusCode < 500) {
      // 404 means "no rules published". That is permission only for a host we
      // already decided to allow explicitly; see evaluate().
      body = ''
      parseOk = true
    }
  } catch {
    parseOk = false
  }

  await db.robotsCache.upsert({
    where: { host },
    create: { host, body, parseOk, ttlSeconds: opts.ttlSeconds, fetchedAt: now, statusCode },
    update: { body, parseOk, ttlSeconds: opts.ttlSeconds, fetchedAt: now, statusCode },
  })

  return evaluate(body, parseOk, url, opts, 'network')
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
