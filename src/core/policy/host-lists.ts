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
