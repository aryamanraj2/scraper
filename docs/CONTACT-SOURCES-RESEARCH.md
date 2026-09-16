# Contact sources research — F5c candidate evaluation

Written 2026-09-12. Research pass only. No code, no schema, no adapters. Answers
the question the operator asked: is there a free or near-free route from 17
contacts to 500-800.

**Bottom line up front:** the strongest technical hit rate (GitHub commit
history) is closed — not by robots.txt, but by GitHub's own Acceptable Use
Policy, which names this exact use case as prohibited. The realistic free path
is stacked lookup-provider free tiers, and it is a slow drip, not a volume
source: **on the numbers measured here, nothing free reaches 500-800 in under
about a year.** The honest recommendation is at the bottom.

---

## 1. Public git history (candidate #1, most budget spent here)

### What it returns

Named individuals' real work email addresses, at the exact seniority band the
operator wants (SDE1/SDE2/senior engineers who commit code), plus the
company's email pattern as a free side effect. This is categorically better
than Tier A's generic aliases.

### Measured hit rate — 10 real corpus companies, queried live

```
psql outreach_dev -c "select display_name, canonical_domain from company c
  join lead l on l.company_id=c.id where l.status='qualified'
  order by l.score desc limit 10;"
```

returned: `deepgram.com, together.ai, braintrust.dev, mercury.com, inngest.com,
anyscale.com, supabase.com, sarvam.ai, fireworks.ai, eightsleep.com`.

For each, resolved the GitHub org (`gh api orgs/<name>`), picked an
actively-pushed repo, pulled up to 100 commits (`gh api
repos/<org>/<repo>/commits`), and filtered `commit.author.email` for anything
not `*noreply.github.com`:

| Company | Org found | Real address found | Count | Sample |
|---|---|---|---|---|
| deepgram.com | `deepgram` (117 repos) | **yes** | 3 | `dave.wainwright@deepgram.com`, `greg.holmes@deepgram.com`, `john.vajda@deepgram.com` |
| together.ai | `togethercomputer` (109 repos) | **yes** | 3 | `blaine@together.ai`, `frederickchu@together.ai`, `gleb@together.ai` |
| braintrust.dev | `braintrustdata` (106 repos) | **yes, off-domain** | 2 | `erin.mcnulty@braintrustdata.com`, `paul.tancre@braintrustdata.com` — legacy domain, not the canonical `braintrust.dev` |
| mercury.com | none found | no | 0 | org has 0 public repos |
| inngest.com | `inngest` (120 repos) | **yes** | 4 | `aaron@inngest.com`, `lakshmi@inngest.com`, `riley@inngest.com`, `shathar@inngest.com` |
| anyscale.com | `anyscale` (116 repos) | **yes** | 1 | `elliot.barnwell@anyscale.com` |
| supabase.com | `supabase` (169 repos) | **yes, off-domain** | 2 | `mattjo@supabase.io`, `prashansa.kulshrestha@supabase.io` — real corporate domain is `.io`, not the canonical `.com` |
| sarvam.ai | `sarvamai` (25 repos) | **yes** | 3 | `adityachaudhary@sarvam.ai`, `ankush@sarvam.ai`, `kurian@sarvam.ai` |
| fireworks.ai | `fireworks-ai` (5 repos) | no | 0 | all 5 repos are forks/mirrors of other projects (`txtai`, `booknlp`) — zero original commits by an employee in this org's own repos |
| eightsleep.com | no official org | no | 0 | only unofficial community wrapper repos by unrelated third parties |

**7 of 10 companies (70%) yielded at least one real, named-employee address.**
Median count among the 7 hits: **3**. Two of the seven hits are at a sibling
corporate domain rather than the canonical one recorded in the database
(`braintrustdata.com` vs `braintrust.dev`, `supabase.io` vs `supabase.com`) —
still the real company, worth flagging because a naive same-domain filter
would have missed both.

This is a dramatically higher hit rate, and a fundamentally different kind of
contact (named individual vs. generic alias), than Tier A's 17-18%.

Cross-checked against npm registry metadata (`package.json` `author`/
`maintainers`, free, `registry.npmjs.org/<pkg>/latest`) for 5 of these
companies: corroborates the same population and adds more named addresses at
the same domains (`etienne@supabase.io`, `katerina.skroumpelou@supabase.io`,
`linell@inngest.com`). PyPI's JSON API (`pypi.org/pypi/<pkg>/json`) has the
same `author_email`/`maintainer_email` fields but returned mostly personal
gmail/outlook addresses in this sample, plus one real hit
(`leonardo.santiago@supabase.io`), and carries a **false-positive risk**: the
package `mercury-python` is an unrelated Cisco networking tool, not
`mercury.com` the fintech. Both registries draw from essentially the same
population as GitHub (people who publish open-source packages) — not an
independent source, and not worth a separate probe pass.

### robots and FetchPolicyGate verdict

`https://api.github.com/robots.txt` returns `404` — no crawl directives
published, because it is a documented JSON REST API meant to be called with a
token, not a page meant to be spidered. `gh api rate_limit` confirms
5,000 requests/hour authenticated. Mechanically, this clears rule 3 and would
need one new `FetchPolicyGate` host allow entry for `api.github.com`.

### Why it's closed anyway — GitHub's Acceptable Use Policy

Fetched `https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies` directly. It draws an explicit line between scraping and API use, then closes the exact gap that distinction would otherwise leave open:

> "Scraping does not refer to the collection of information through our API."

> "You may not use information from the Service (whether scraped, collected
> through our API, or obtained otherwise) for spamming purposes, including for
> the purposes of sending unsolicited emails to users or selling personal
> information, such as to recruiters, headhunters, and job boards."

That is not a generic anti-scraping clause that a documented API sidesteps —
it explicitly covers API-collected data, and it names "recruiters" and
"headhunters" as illustrative examples of the exact prohibited pattern: taking
an address off GitHub and sending an unsolicited email to the person behind
it. The operator's own authenticated `gh` session (account `aryamanraj2`) is
what would make each request; violating this is a ToS breach on the
operator's own account, not an abstract policy question.

**Verdict: closed.** Not by `FetchPolicyGate`, not by robots — by the
publisher's terms, which the system's own provenance rule (non-negotiable #4)
and the operator's instruction to check "whether its terms permit this use"
(candidate #4 of the brief) both require respecting. Building an adapter here
would be the SmartRecruiters situation again, one layer up: technically
open, contractually shut.

**A narrower question worth naming, not resolving:** could the *pattern*
learned from a GitHub-sourced address (e.g., `first@inngest.com`) be used
without the specific address, to construct a guess for a different person
found by the operator manually browsing LinkedIn? The AUP's language — "using
information from the Service ... for spamming purposes" — plausibly reaches a
pattern derived from that information too, not only the literal address. This
is genuinely gray rather than clearly closed, and it is the operator's call,
not a policy this document resolves. Given that stacked lookup providers
(§4) supply the same pattern **without touching GitHub's data at all**, there
is no reason to take this risk — the same output is available cleanly
elsewhere.

---

## 2. Common Crawl

### robots verdict — closed, mechanically

`https://commoncrawl.org/robots.txt` disallows a couple of specific bot names
and `/search?*`; unremarkable. But the actual query surface — the CDX index
server used to look up what a domain has been crawled — lives on a different
host, and its robots is not permissive:

```
$ curl -s https://index.commoncrawl.org/robots.txt
User-agent: *
Disallow: /

Allow: /$
Allow: /index.html$
Allow: /web-graphs-index.html$
Allow: /collinfo.json$
Allow: /graphinfo.json$
Allow: /ccbot.json$
Allow: /.well-known/*.txt$
```

Everything is disallowed except a short list of static pages. The actual query
path used for a domain-scoped lookup — `/CC-MAIN-<crawl>-index?url=<domain>*`,
confirmed live to work and return real hits for `inngest.com*` — is **not** on
that allow list. Under rule 3 ("robots is unconditional"), this closes the
same way SmartRecruiters did: a real, useful, free endpoint that this
system's own gate refuses to call.

### Independently, it would not have been practical anyway

Even setting robots aside: the CDX index only tells you *that* a URL was
crawled and where its bytes sit inside a named WARC segment — it does not
return page content. Reading `mailto:` links out of a domain means then
fetching the actual WARC segment(s) (each a compressed multi-GB archive
covering many unrelated sites) and grepping inside, per hit, per crawl. That
is an infrastructure job (S3 byte-range reads or Athena over the columnar
index), not a laptop task, and the free CDX layer only gets you to "here is
where to look," not an address.

**Verdict: closed** on robots, and would have been a poor fit for a laptop
even if it weren't.

---

## 3. Stacked lookup-provider free tiers

This is the one candidate whose entire business model is providing exactly
what the operator wants — a named or pattern-level address, for cold
outreach — so there is no scraping/AUP tension to reason through the way
there is for GitHub or npm. The tradeoff is scale: free tiers are small and
capped per month.

Live-checked two of the eight named in the brief (pricing pages only — an API
key requires signup, which is outside what this research pass can measure
without creating operator accounts):

| Provider | Free tier, as published | Source |
|---|---|---|
| **Hunter.io** | 50 credits/month. 1 credit = one email found, 0.5 credit = one verification. Basic Discover DB filters only. | `hunter.io/pricing`, fetched live |
| **Snov.io** | 50 credits/month, "renew every 30 days," no bulk search, no export, no API access on the free tier. The page itself states: *"Trial plan has been created to offer a peek into what Snov.io can do and is not meant to help grow sales."* | `snov.io/pricing`, fetched live |
| **Apollo.io** | Free "Starter" plan exists but its exact monthly allocation is not stated on the public pricing page (only trial-plan numbers — 50 credits, 5 mobile credits — are listed). Needs a live signup to pin down. | `apollo.io/pricing`, fetched live, inconclusive |
| RocketReach | Pricing page returned `403` to an unauthenticated fetch — not measured this session. | not verified |
| Prospeo, Skrapp, FindThatLead, Anymail Finder | Not fetched this session — would cost more budget for tools structurally identical to Hunter/Snov (a monthly credit allowance, domain search + verify). Not expected to change the arithmetic below by more than another 30-50 credits/month if added. | not verified |

What a "credit" returns, per Hunter's and Snov's own product design: a
**domain search** returns the company's email pattern plus whatever named
addresses are already indexed for that domain (zero for a small or obscure
company, several for a company with public-facing staff). This is exactly
what non-negotiable #5 requires before a pattern can be used — a confirmed
address at that specific company — and it is the intended, licensed use of
the product, unlike GitHub's incidental exposure of the same fact.

**Terms verdict:** these products are marketed for sales/recruiting outreach
as their primary use case. There is no equivalent of GitHub's "not for
recruiters" clause to find, because recruiters and sales teams are the
customer. (Hunter's own `/terms` path 404'd on a live fetch this session, so
this is stated from the product's well-established public positioning, not a
quoted clause — flagged as the one item here not pinned to a source URL.)

**Arithmetic:** Hunter (50/mo) + Snov (50/mo), stacked = **100 domain lookups
per month**, recurring, free, forever. Not every lookup returns a hit — small
or India-based companies (most of this corpus, per F5b §8) are exactly the
population least likely to be indexed by a US-centric lookup provider. Call
it a 40-60% domain-lookup hit rate optimistically (this session could not
measure it live against the actual corpus, since that requires the
operator's own API key) — **40-60 usable contacts a month**, mixing named
individuals and confirmed patterns.

**This fits `FetchPolicyGate` as-is only if built as the Tier B provider
seam that already exists** (per `ORCHESTRATOR-HANDOVER.md` §4, F4 built this
seam against a fake). It needs one host allow entry per provider and a real
API key — the seam, fixtures and `verified` flag are already there waiting
for one.

---

## 4. Everything else in the brief's "anything else" list

Engineering blog author bylines, conference speaker/CFP pages, OSS
contributor pages, meetup organiser listings: all are the same shape as Tier
A — read one page, find zero-to-few named people, subject to the target
site's own robots on a host-by-host basis with no blanket answer. None of
these indexes at company scale the way GitHub or a lookup provider does; each
would be worth at most a handful of addresses per company visited, and
visiting them one company at a time does not compound the way a monthly
recurring credit allowance does. Not measured individually — doing so for
each of five idea categories across a meaningful company sample would have
cost most of the remaining budget for a source class that, by its own
description, tops out around Tier A's ceiling. Worth operator-manual use
opportunistically (an engineering blog turns up while reading a company's
site for other reasons), not worth building.

---

## 5. Recommendation

**Nothing free reaches 500-800 quickly. Say so plainly, as asked.**

What's actually available, combined:

| Source | Ceiling | Contact kind | Status |
|---|---|---|---|
| Tier A (already measured, F5b) | ~370 across full 2,145-company corpus at 17-18% | generic role alias, 1/company | Closed, already built, already run |
| GitHub commit history | 70% hit rate, median 3/company in this sample | named individual | **Closed — GitHub AUP explicitly forbids this use** |
| npm/PyPI metadata | same population as GitHub, lower yield | named individual | Gray-area ToS (npm), not independently worth building |
| Common Crawl | — | — | **Closed — robots.txt on the query host, plus impractical at laptop scale** |
| Stacked free-tier lookups (Hunter+Snov, and similar) | ~100 lookups/mo, maybe 40-60 hits/mo | named + pattern | **Open. The one real lever.** |

**The combination that reaches the target, and its real cost:**

Tier A's ~370 generic aliases already exist or are one `contacts:curate --all`
away (it has been run; F5b's number stands). Add the stacked-provider drip —
40-60 new contacts a month, mixing named people and confirmed patterns — and
reaching the bottom of the 500-800 range (500 total, ~130 more needed beyond
Tier A's ceiling) takes **roughly 2-3 months** of monthly free-tier renewal,
manually run through the `contacts:import --file` path F5a already built (no
new code needed — the CSV importer, the executive filter, and the
`verified=false` no-send-without-verification guard are all live). Reaching
800 (430 more needed) takes **5-7 months** on the same drip, or faster if
Prospeo/Skrapp/FindThatLead genuinely add another 30-50/month combined once
actually signed up for and measured (not verified this session).

**What the operator has to do by hand, every month:** sign into Hunter and
Snov (and any additional free tier added), run domain searches against the
qualified-company list the system already produces, save hits to a CSV, and
run `contacts:import`. This is exactly the workflow F5a built and already
proved safe (`verified=false`, no send path, executive filter, off-domain
filter) — it just needs real provider accounts instead of the fake.

**If the operator wants 500-800 sooner than a few months, the honest
options are:** widen the corpus faster (more companies means more Tier A
denominator and more provider lookups worth spending, per company, on
higher-scoring leads only), accept that named-individual volume at this
speed is not available for free, or pay for it — Hunter's paid tier is the
one line item in the entire brief that this research does not get around,
and the operator has already said no to that. This document does not
relitigate that no; it just confirms there is no free substitute that clears
500-800 in a timeframe shorter than several months of the stacked-tier drip.

**One thing not to build, even though it measured the best:** the GitHub
adapter. It has the best hit rate of anything tested here and it is the one
this document recommends against, on ToS grounds the operator's own
provenance and terms-of-service instincts (rule 4, and the explicit ask to
check "whether its terms permit this use" for the stacked-tier candidates)
already anticipated.

---

## 6. What fits `FetchPolicyGate` as-is vs. needs a new entry

- **GitHub API** — would need one new host allow entry (`api.github.com`).
  Moot given §1's ToS verdict; not recommending the entry be added.
- **npm/PyPI registries** — same: mechanically buildable, one host entry
  each, not recommended as a primary source given redundancy with GitHub and
  npm's own gray-area terms.
- **Common Crawl CDX** — refused by `FetchPolicyGate` as designed; robots
  disallows the query path. No entry to add; it would be refused on arrival.
- **Lookup providers (Hunter, Snov, etc.)** — this is exactly what the
  existing Tier B seam (`ORCHESTRATOR-HANDOVER.md` §4) was built for. One
  host allow entry and one real API key per provider, against code and
  fixtures that already exist.
