import { registrableDomain } from '../../core/policy/registrable-domain.js'

/**
 * Which `Evidence` rows a message about a company is allowed to cite.
 *
 * ## The failure this exists to stop, found on live data
 *
 * `tempo.fit` (a fitness company) was detected as using Greenhouse board token
 * `tempo` — which belongs to **Tempo Energy**, a solar company. So `tempo.fit`
 * carries eight `Opportunity` rows whose URLs are all on `tempoenergy.com`:
 * "Engineering Technician - Electrical, San Diego", "Staff Materials Engineer", and
 * so on.
 *
 * Through F3 that was survivable — a wrong application packet is one the operator
 * looks at and discards. F4 is where it becomes an **email to a stranger**
 * confidently describing a company that is not theirs, and citing evidence for it.
 * That is the single most embarrassing thing this system could send, and unlike most
 * failures here it would be invisible to every check that existed: the citation is
 * real, the excerpt is verbatim, the URL resolves. Everything is provably true about
 * somebody else.
 *
 * ## The rule
 *
 * A draft may cite evidence from:
 *
 *   1. the company's **own registrable domain**, including subdomains — the employer
 *      speaking about themselves, which is what H7 asks for ("re-verify every citable
 *      fact from the company's own site") and what §8's personalized opener needs;
 *   2. an **ATS host**, where a posting genuinely belongs to the board it was read
 *      from.
 *
 * Everything else is foreign, and the `tempoenergy.com` rows are foreign by this rule
 * even though they came down the same pipe as the good ones.
 *
 * ## What this deliberately does not do
 *
 * It does not fix the detection bug — that is F1's, it needs a migration and a
 * re-detect, and it is recorded for F5. This only stops a message being written from
 * the contaminated half. A company whose evidence is entirely foreign composes no
 * draft at all, which is the correct outcome: there is nothing true we can say.
 *
 * yc-oss hosts are **not** on the list, deliberately. H7 makes the seed index a
 * discovery source whose facts must be re-verified from the company's own site before
 * being cited, and a draft is exactly the place that rule is for.
 */
const ATS_HOSTS = new Set([
  'boards-api.greenhouse.io',
  'job-boards.greenhouse.io',
  'boards.greenhouse.io',
  'api.lever.co',
  'jobs.lever.co',
  'api.ashbyhq.com',
  'jobs.ashbyhq.com',
])

export type ScopedEvidence = { id: string; sourceUrl: string }

/** Whether one evidence row may be cited in a message about this company. */
export function isEvidenceInScope(sourceUrl: string, canonicalDomain: string): boolean {
  let host: string
  try {
    host = new URL(sourceUrl).host.toLowerCase()
  } catch {
    // An unparseable source URL cannot be shown to be about this company, and the
    // failure direction that matters is asserting something false to a stranger.
    return false
  }
  if (ATS_HOSTS.has(host)) return true

  const evidenceDomain = registrableDomain(host)
  const companyDomain = registrableDomain(canonicalDomain)
  return evidenceDomain !== null && companyDomain !== null && evidenceDomain === companyDomain
}

export function partitionEvidenceByScope<T extends ScopedEvidence>(
  evidence: T[],
  canonicalDomain: string,
): { inScope: T[]; foreign: T[] } {
  const inScope: T[] = []
  const foreign: T[] = []
  for (const e of evidence) {
    if (isEvidenceInScope(e.sourceUrl, canonicalDomain)) inScope.push(e)
    else foreign.push(e)
  }
  return { inScope, foreign }
}
