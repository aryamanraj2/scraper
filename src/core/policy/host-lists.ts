/**
 * D4 preflight step 1, seed lists.
 *
 * The denylist is permanent and beats every allow entry, including one a future
 * milestone derives from a Company row. It is enforced in FetchPolicyGate before
 * any request is constructed, so a gated platform is unreachable at the transport
 * layer rather than by adapter convention — handover.md §1.4 and §1.5, and Part G's
 * "assert zero HTTP requests to the host, at transport layer not adapter".
 *
 * The allowlist is only the sources F1 actually needs. Employer careers domains are
 * NOT listed here: they earn a `derived_company` allow entry when a Company is
 * normalized in F1, with provenance, and still have to pass robots, terms and rate
 * policy afterwards.
 */

export type SeedHostEntry = {
  host: string
  includeSubdomains: boolean
  note: string
  /**
   * D4 step 4: "a published rate limit or crawl-delay always wins over our default".
   *
   * Set only where a vendor publishes a figure we can cite. It is an override in both
   * directions — a published limit slower than our default would slow us down — and
   * every use records the source URL it came from on the `HostPolicy` row.
   */
  rateDelayMsOverride?: number
  sourceUrl?: string
}

/**
 * Gated platforms and aggregators we will not automate. Several are here because
 * their terms prohibit automated access; the rest because the plan excludes them
 * from v1 (B2, B7) and an excluded source must not be reachable by accident.
 */
export const SEED_DENY_HOSTS: SeedHostEntry[] = [
  { host: 'linkedin.com', includeSubdomains: true, note: 'Prohibits third-party crawlers and automated activity. handover.md §1.4. Never fetched, including via LeadHint.' },
  { host: 'wellfound.com', includeSubdomains: true, note: 'No official API; out of scope under the no-scraping-gated-platforms rule (B7).' },
  { host: 'angel.co', includeSubdomains: true, note: 'Wellfound predecessor domain.' },
  { host: 'internshala.com', includeSubdomains: true, note: 'No official API (B7).' },
  { host: 'instahyre.com', includeSubdomains: true, note: 'No official API (B7).' },
  { host: 'naukri.com', includeSubdomains: true, note: 'No official API (B7).' },
  { host: 'glassdoor.com', includeSubdomains: true, note: 'Terms prohibit automated collection.' },
  { host: 'indeed.com', includeSubdomains: true, note: 'Terms prohibit automated collection.' },
  { host: 'crunchbase.com', includeSubdomains: true, note: 'Free API tier withdrawn (B7); not a permitted source.' },
  { host: 'x.com', includeSubdomains: true, note: 'X excluded from v1 (B2). API-only if ever reconsidered; never the web interface.' },
  { host: 'twitter.com', includeSubdomains: true, note: 'See x.com.' },
  { host: 'facebook.com', includeSubdomains: true, note: 'Gated social platform.' },
  { host: 'instagram.com', includeSubdomains: true, note: 'Gated social platform.' },
  { host: 'tiktok.com', includeSubdomains: true, note: 'Gated social platform.' },
]

/**
 * Structured, public, no-auth sources the plan names as required for F1 (Part E),
 * verified in B6.
 */
export const SEED_ALLOW_HOSTS: SeedHostEntry[] = [
  { host: 'boards-api.greenhouse.io', includeSubdomains: false, note: 'Greenhouse public job board API: GET /v1/boards/{token}/jobs, no auth (B6).' },
  { host: 'job-boards.greenhouse.io', includeSubdomains: false, note: 'Hosted board pages; migrated from boards.greenhouse.io — detection signatures updated (B6).' },
  { host: 'boards.greenhouse.io', includeSubdomains: false, note: 'Legacy hosted board host, retained for redirect handling during F1 detection.' },
  { host: 'api.lever.co', includeSubdomains: false, note: 'Lever postings API: GET /v0/postings/{slug}?mode=json, no auth. No discovery endpoint — slug resolution is part of detection (B6).' },
  { host: 'api.ashbyhq.com', includeSubdomains: false, note: 'Ashby public posting API: GET /posting-api/job-board/{name}, no auth, single call (B6).' },
  { host: 'yc-oss.github.io', includeSubdomains: false, note: 'yc-oss daily company index. H7: seed index only — re-verify every citable fact from the company site.' },
  { host: 'raw.githubusercontent.com', includeSubdomains: false, note: 'yc-oss raw JSON payloads.' },
  { host: 'api.firecrawl.dev', includeSubdomains: false, note: 'D4 tier 3 escalation: POST /v2/scrape, Bearer auth (B6a). Reached only through FetchPolicyGate.postJson, and only when FIRECRAWL_API_KEY is set.' },

  // --- F5: the mail transport -----------------------------------------------
  //
  // These are not research sources and nothing crawls them: they are the operator's
  // OWN mailbox, reached with the operator's own OAuth credentials. They are on the
  // allowlist for the same reason `api.firecrawl.dev` is — `FetchPolicyGate` is the
  // only path to the network, so an authenticated provider API goes through it like
  // everything else, and host policy, terms, robots, rate and budget all still run.
  //
  // robots.txt: both hosts answer 404, which F1 §4.9 defines as "no rules published" —
  // permission ONLY for a host with an explicit allow entry, which these have.
  // Verified 2026-09-11.
  //
  // Budget: the mail path declares `cost: 0`, which `checkBudget` short-circuits
  // before reading a row. A research cap must never abort an approved message.
  //
  // **No rate override on either**, and that is a correction rather than an omission.
  //
  // Google publishes 6,000 quota units per minute per user, and `messages.send` costs
  // 100 — one send per second, which is *faster* than this project's 5,000 ms default.
  // An override of 1,500 ms was written first and did nothing, because
  // `effectiveDelayMs` returns `max(default, override, crawlDelay)`: the override is
  // there so a host can slow us DOWN, never speed us up. Its own contract says so —
  // "a published rate limit always wins over our default — never the other way round."
  //
  // So the effective spacing is 5,000 ms, the conservative default, and the mail
  // adapter waits it out between its own calls rather than trying to shorten it
  // (`GmailProvider.spaceRequests`). Waiting is the only correct response to a rate
  // limit; reaching past the limiter would be evading one (`handover.md` §1.5).
  {
    host: 'gmail.googleapis.com',
    includeSubdomains: false,
    sourceUrl: 'https://developers.google.com/workspace/gmail/api/reference/quota',
    note: 'F5 mail transport: users.messages.send / list / get on the operator\'s own mailbox, gmail.modify scope. No override: the published limit (1 send/sec) is looser than our 5s default, and an override can only ever be more conservative.',
  },
  {
    host: 'oauth2.googleapis.com',
    includeSubdomains: false,
    sourceUrl: 'https://developers.google.com/identity/protocols/oauth2/native-app',
    note: 'F5: the OAuth 2.0 token endpoint. POST form-encoded only, through FetchPolicyGate.postForm, which audits no part of the body.',
  },

  // --- F5b: the seven `host_denied` redirect targets -------------------------
  //
  // F5a's seed ingest detected a board for 59 of 188 companies. Seven of the
  // failures were one allow entry away from working: the company's own careers
  // link 301s to a DIFFERENT registrable domain, the redirect is followed through
  // the gate as it must be, and the gate refuses the new host because nothing has
  // granted it. That is `derived_company` working as designed — an allow entry
  // earned by normalizing hasura.io does not extend to promptql.io.
  //
  // Three of the seven point at Workday, Workable and param.ai, which this system
  // has no adapter for, so an entry alone attaches no postings. It lets detection
  // RECORD which vendor the company uses, which is the input to deciding which
  // adapter to build next (F5a carry-forward #4). The other four are the company's
  // own site under a new name.
  //
  // An allow entry is OUR permission, not the publisher's. robots, terms, rate and
  // budget all still run at fetch time, and any of them can still refuse.
  //
  // Subdomains are included where the VENDOR puts the tenant in the hostname
  // (`fractal.wd1.myworkdayjobs.com`, `practo.app.param.ai`) — an exact entry there
  // would unblock exactly one company and teach nothing about the next one — and
  // where a company's own domain may or may not serve `www`. Workable puts the
  // tenant in the path, so its entry is exact.
  { host: 'promptql.io', includeSubdomains: true, note: 'F5b: hasura.io/careers redirects here. Hasura rebranded to PromptQL; same company, new registrable domain.' },
  { host: 'notion.com', includeSubdomains: true, note: 'F5b: notion.so redirects here. Same-company domain move, not a third party.' },
  { host: 'jobs.twilio.com', includeSubdomains: false, note: 'F5b: stytch.com/careers redirects here following the acquisition. Twilio\'s own careers host.' },
  { host: 'wise.jobs', includeSubdomains: true, note: 'F5b: wise.com/careers redirects here. Wise\'s own careers domain.' },
  { host: 'myworkdayjobs.com', includeSubdomains: true, note: 'F5b: Workday-hosted boards, tenant in the hostname (e.g. fractal.wd1.myworkdayjobs.com). NO ADAPTER — detection records the vendor, nothing ingests postings.' },
  { host: 'apply.workable.com', includeSubdomains: false, note: 'F5b: Workable-hosted boards, tenant in the path (e.g. /huggingface). NO ADAPTER — detection records the vendor only.' },
  { host: 'param.ai', includeSubdomains: true, note: 'F5b: param.ai-hosted boards, tenant in the hostname (e.g. practo.app.param.ai). An India-native ATS, and the only one this corpus has surfaced. NO ADAPTER yet.' },
]

/** Lowercased host with any port and trailing dot removed. */
export function normalizeHost(input: string): string {
  return input.trim().toLowerCase().replace(/\.$/, '').replace(/:\d+$/, '')
}

export function hostMatches(candidate: string, entryHost: string, includeSubdomains: boolean): boolean {
  const c = normalizeHost(candidate)
  const e = normalizeHost(entryHost)
  if (c === e) return true
  return includeSubdomains && c.endsWith(`.${e}`)
}
