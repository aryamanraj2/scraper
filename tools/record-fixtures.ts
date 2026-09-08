#!/usr/bin/env tsx
/**
 * Captures one real response per source into `test/fixtures/`, so the suite can
 * replay them through undici's `MockAgent` forever after.
 *
 * `handover.md` §11: "never run uncontrolled live-source tests". This script is
 * the controlled exception — it is run deliberately by a human, never by `npm
 * test`, and it is the ONLY place in the project that touches a live source.
 *
 * It fetches through `FetchPolicyGate` like everything else. That is not
 * ceremony: it means a fixture cannot be recorded from a host the running system
 * would be refused, so the fixtures can never describe a capability the pipeline
 * does not actually have.
 *
 * Usage:
 *   npm run fixtures:record                 # every target
 *   npm run fixtures:record -- yc-meta      # named targets only
 *   npm run fixtures:record -- --url https://... --name scratch
 */
import 'dotenv/config'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { prisma, disconnectPrisma } from '../src/core/db/client.js'
import { env } from '../src/core/config/config.js'
import { FetchPolicyGate } from '../src/core/policy/fetch-policy-gate.js'
import { contentHashOf } from '../src/core/evidence/content-hash.js'

const FIXTURE_DIR = join(process.cwd(), 'test', 'fixtures')

type Target = {
  name: string
  url: string
  /** Trims a very large payload to a reviewable size, preserving item shape verbatim. */
  slice?: (parsed: unknown) => unknown
  /** Raised above the research-page default for the multi-megabyte YC feeds. */
  maxBytes?: number
  note: string
}

/**
 * The YC feeds are tens of megabytes. The research-page default would truncate
 * them mid-string, which now surfaces as `truncated` rather than as a parse error
 * far from the cause — see src/core/policy/http/raw-client.ts.
 */
const YC_FEED_MAX_BYTES = 96 * 1024 * 1024

/** ATS boards with full descriptions inline routinely exceed the page default. */
const ATS_FEED_MAX_BYTES = 16 * 1024 * 1024

/** Keeps `all.json` reviewable in git without altering the shape of any record. */
function firstN(n: number) {
  return (parsed: unknown): unknown => (Array.isArray(parsed) ? parsed.slice(0, n) : parsed)
}

/**
 * Same idea for a source that wraps its array in an envelope: the envelope and
 * every retained record stay exactly as published, only the count shrinks. Ashby
 * inlines full HTML descriptions, so an untrimmed board is megabytes of fixture
 * for no additional coverage.
 */
function firstNIn(key: string, n: number) {
  return (parsed: unknown): unknown => {
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>)[key])) {
      const envelope = parsed as Record<string, unknown>
      return { ...envelope, [key]: (envelope[key] as unknown[]).slice(0, n) }
    }
    return parsed
  }
}

const TARGETS: Target[] = [
  {
    name: 'yc-oss-meta',
    url: 'https://yc-oss.github.io/api/meta.json',
    note: 'yc-oss index metadata: counts and the list of published feeds.',
  },
  {
    name: 'yc-oss-companies-hiring',
    url: 'https://yc-oss.github.io/api/companies/hiring.json',
    slice: firstN(40),
    maxBytes: YC_FEED_MAX_BYTES,
    note: 'Currently-hiring YC companies. Sliced to the first 40 records; each record is verbatim.',
  },
  {
    name: 'yc-oss-companies-all',
    url: 'https://yc-oss.github.io/api/companies/all.json',
    slice: firstN(10),
    maxBytes: YC_FEED_MAX_BYTES,
    note: 'Full YC index. Sliced to the first 10 records purely to keep the fixture reviewable.',
  },
  {
    name: 'greenhouse-jobs',
    url: 'https://boards-api.greenhouse.io/v1/boards/razorpaysoftwareprivatelimited/jobs?content=true',
    note: 'Greenhouse public board API (B6). Razorpay: an Indian company on Greenhouse, per B7.',
  },
  {
    name: 'lever-postings',
    url: 'https://api.lever.co/v0/postings/leverdemo?mode=json',
    maxBytes: ATS_FEED_MAX_BYTES,
    note: "Lever postings API (B6). Lever's own documented demo board — stable, and the shape their docs describe.",
  },
  {
    name: 'ashby-job-board',
    url: 'https://api.ashbyhq.com/posting-api/job-board/ashby?includeCompensation=true',
    maxBytes: ATS_FEED_MAX_BYTES,
    slice: firstNIn('jobs', 20),
    note: "Ashby public posting API (B6). Ashby's own board, trimmed to the first 20 jobs; each job is verbatim.",
  },
]

const argv = process.argv.slice(2)
const urlFlag = argv.indexOf('--url')
const nameFlag = argv.indexOf('--name')

let targets: Target[]
if (urlFlag !== -1) {
  const url = argv[urlFlag + 1]
  const name = nameFlag !== -1 ? argv[nameFlag + 1] : 'scratch'
  if (!url || !name) throw new Error('--url requires a value, and --name defaults to "scratch"')
  targets = [{ name, url, note: 'Ad-hoc capture.' }]
} else {
  const wanted = argv.filter((a) => !a.startsWith('--'))
  targets = wanted.length > 0 ? TARGETS.filter((t) => wanted.includes(t.name)) : TARGETS
  const unknown = wanted.filter((w) => !TARGETS.some((t) => t.name === w))
  if (unknown.length > 0) throw new Error(`Unknown target(s): ${unknown.join(', ')}`)
}

mkdirSync(FIXTURE_DIR, { recursive: true })

const config = env()
const gate = new FetchPolicyGate(prisma(), {
  userAgent: config.USER_AGENT,
  robotsTtlSeconds: config.ROBOTS_CACHE_TTL_SECONDS,
  defaultRateDelayMs: config.DEFAULT_HOST_RATE_DELAY_MS,
})

/**
 * The gate REFUSES a request that would breach the per-host spacing rather than
 * queueing it, so the recorder has to wait rather than retry. Waiting the full
 * default delay between every target is deliberately blunt: it is correct without
 * having to reason about which targets share a host, and this script runs by hand.
 */
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

let failures = 0
let first = true
for (const target of targets) {
  if (!first) await pause(config.DEFAULT_HOST_RATE_DELAY_MS)
  first = false
  const result = await gate.fetchText(target.url, {
    ...(target.maxBytes === undefined ? {} : { maxBytes: target.maxBytes }),
  })
  if (!result.ok) {
    failures += 1
    console.error(`  REFUSED  ${target.name}  ${result.reason}  ${target.url}`)
    continue
  }
  const { statusCode, body, truncated } = result.response
  if (truncated) {
    failures += 1
    console.error(`  TRUNCATED  ${target.name}  raise maxBytes; a partial body is not a fixture`)
    continue
  }
  if (statusCode < 200 || statusCode >= 300) {
    failures += 1
    console.error(`  HTTP ${statusCode}  ${target.name}  ${target.url}`)
    continue
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (err) {
    failures += 1
    console.error(`  UNPARSEABLE  ${target.name}  ${String(err)}`)
    continue
  }

  const stored = target.slice ? target.slice(parsed) : parsed
  const payloadPath = join(FIXTURE_DIR, `${target.name}.json`)
  const metaPath = join(FIXTURE_DIR, `${target.name}.meta.json`)

  writeFileSync(payloadPath, `${JSON.stringify(stored, null, 2)}\n`)
  writeFileSync(
    metaPath,
    `${JSON.stringify(
      {
        url: target.url,
        statusCode,
        recordedAt: new Date().toISOString(),
        sliced: Boolean(target.slice),
        note: target.note,
        contentHash: contentHashOf(stored),
      },
      null,
      2,
    )}\n`,
  )
  const size = Array.isArray(stored) ? `${stored.length} records` : `${body.length} bytes`
  console.log(`  OK       ${target.name}  ${size}`)
}

await disconnectPrisma()
process.exit(failures === 0 ? 0 : 1)
