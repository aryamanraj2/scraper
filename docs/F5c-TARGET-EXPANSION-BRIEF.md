# F5c — target expansion: companies that will actually reply

A gated mini-milestone between F5b and F6. Written 2026-10-03.
`MILESTONE_STAGE` stays at `F5`. Nothing here touches sending.

This brief is written for a chat with **zero prior context**. Everything it needs is
here. The sources named below were **verified live on 2026-10-03** before this brief
was written — three of them are closed, and the closures are recorded with the quoted
evidence so nobody spends a budget rediscovering them. That has happened four times
already in this project (SmartRecruiters, Darwinbox, Naukri, GitHub), every time
because a brief named a source nobody had checked.

---

## 1. What the system is

A local cold-outreach machine for internship hunting, at
`/Users/aryamanjaiswal/Documents/ChatGPT/scraper`. TypeScript, Postgres via Prisma,
Next.js dashboard. It finds companies, finds people who work there, writes an email
citing something real about the company, links the resume matching that role, and asks
whether they take interns.

The operator is a B.Tech student in India, graduating March 2028. **Budget is
effectively zero.** $34/month for a lookup tool is real money and the answer has been
no. Every proposal must be free, free-tier, or trivially one-time. "Just pay for it" is
not an available answer.

Measured reply rate for untargeted volume spray is 0.1%. Evidence-cited
personalization is the bet: if per-company citation moves 0.1% to 0.5%, 400 contacts do
the work of 2,000.

### Live state, re-queried 2026-10-04 after steps 1 through 4 ran

```
companies        3,085   (was 2,145 — the YC backfill added 940)
opportunities    5,084   (was 4,615 — board detection attached 469 postings)
qualified leads  249 rows / 154 companies   (was 194 / 99)
contacts         126     (was 17 — and 109 of them are named humans)
global credits   7,637 / 50,000   (every step so far has been free)
MILESTONE_STAGE  F5      (sending hard-disabled)
```

Contacts by type: `named_employee` 85 · `named_talent` 24 · `careers_alias` 14 ·
`talent_alias` 3. **Steps 1–4 cost zero credits and `main` is green at 604 tests.**

The `lead` table holds **company/track pairs**, so 194 rows across 99 distinct
companies. Both numbers are correct; quote the one that matches the question.

**`main` is currently RED.** `npm run check:no-raw-http` fails and `tsc` reports 20
errors, all from the two enrichment tools committed in `5e9fad1`. See §1.1.

### 1.1 What steps 1 and 2 actually produced — read before planning anything

Verified against the database on 2026-10-03, not taken from a report.

**Step 1, the backfill, worked exactly as specified.** `--backfill-band --seed-only`
with an `inGrowthBand` filter on batch year, team size and status. 943 matched, **940
created**, 2 already present and left untouched, 1 skipped (`Pragmatic Leaders`, whose
`website` field holds two URLs). Add-only, so no existing row was reset to
`normalized`. Two new tests in `test/integration/seed-loader.test.ts`, passing.

Regions as loaded: US 529, other 219, Europe 69, India 61, UK 45, no location 17 —
**704 in the target geographies**, against this brief's predicted 702. The difference is
classifier wording, not a defect. The 236 `other`/no-location rows were kept and
counted, not dropped, which is correct.

**Step 2, the free scoring pass, returned nothing usable, and this is the finding that
matters most in this document:**

```
940 new companies scored for free
  266 scored · 674 insufficient_evidence
  min 20 · mean 33 · max 46
  research floor 55 · qualify floor 70
  NEW QUALIFIED LEADS: 0
```

**The corpus grew 44% and the qualified-lead count did not move at all.** Not one of
the 940 cleared even the 55 research floor, let alone 70. The ceiling is structural:
yc-oss gives a one-liner, a long description, tags and a team size, and that text alone
cannot carry a company past 55. A company only climbs once it has **its own job
postings or researched pages** attached — which costs either hours of polite fetching
(board detection, free) or credits (research).

So the honest read of step 1: it bought 940 rows of *potential*, not 940 targets, and
every one of them is inert until something fetches their board. Do not describe the
backfill as having produced leads.

### 1.2 Step 4's result: a detected job board is close to decisive

Run on the 266 scored companies, verified against the database 2026-10-04.

```
boards found        61 of 266  =  23%     (Ashby 56 · Greenhouse 3 · Lever 2)
postings attached  469
refused by robots    9 companies, correctly
wall clock         ~33 min for 266 companies
```

Score lift, re-queried directly rather than taken from the report:

| | companies | min | mean | max |
|---|---|---|---|---|
| **with a board** | 61 | 33 | **82.5** | 97 |
| without one | 205 | 20 | 32.6 | 44 |

**55 of the 61 boarded companies now qualify (>= 70). Not one of the 205 unboarded
companies exceeded 44.** Qualified companies went 99 to 154. New leads by track: AI
engineer 22, SWE 21, SDE 12, **mobile 0** - exactly as section 3.3 predicted.

This is the most useful single fact the milestone produced: **feed text cannot qualify a
company and postings can.** A board is worth more than any amount of better filtering
upstream.

**Two predictions in this brief were wrong, both in the same direction:**

- It predicted ~45% board detection, from F5a's 54-of-117. The real rate for this band
  is **23%** - half. Recent YC companies are on **Ashby** (56 of 61), which F5b
  identified as a minor vendor; the vendor mix shifted under us.
- It predicted step 3b would reach 138 contacts. The real figure is **126**: 12
  addresses appear in both CSVs and the two separate dry runs each counted them, so
  109 rows imported, not 121.

Treat every yield prediction in this document as an order of magnitude, not a number.
Both errors surfaced because a batch was measured before the whole was committed to.

### 1.3 The enrichment scripts were committed and pushed - the brief's earlier text is wrong

An earlier version of this section called them "uncommitted work in progress". They are
in `5e9fad1`, on `origin/main`, along with the widened `.gitignore`.

Verified: `git log --all -S` finds **no literal API key anywhere in history** — the
env-var fix landed before the commit, so nothing leaked. That part is fine.

What is not fine, and is now in public history:

- `tools/run-mobile-enrichment.ts` still carries `TECH_LEADERSHIP_REGEX`, which
  deliberately matches `cto`, `vp of engineering` and `technical founder`. That is
  non-negotiable #2 in the repository's public history.
- `main` fails `npm run check:no-raw-http` (8 raw `fetch` sites outside
  `FetchPolicyGate`) and fails `tsc` with 20 errors. Both were green before `5e9fad1`.

"Keep them as untracked local scratch" now means `git rm --cached` plus an ignore rule.
Either way the history keeps them; the point of removing them is to get `main` green
and stop the executive regex being live code.

**RESOLVED in `93db2bd`.** The executive branch of `TECH_LEADERSHIP_REGEX` is deleted,
both scripts are `git rm --cached`-ed and moved to an already-ignored `scratch/`, and
`scratch/**` is in the eslint ignores. Untracking alone was not enough - the AST scan
and `tsc` read `tools/` from disk, not from the index, so the files had to physically
leave that directory. `main` is green: 604 tests, lint and typecheck clean.

**Still true and unfixable:** the executive regex remains in public history at
`5e9fad1`. No API key was ever in that commit - verified with `git log --all -S`.

### Superseded — the original "uncommitted work in progress" note

The operator hand-built a mobile-company target list and ran two enrichment scripts
against Hunter and Snov.io free tiers. The results are real and good:

```
data/mobile-targets.csv      65 hand-picked app companies
data/mobile-contacts.csv     50 named contacts  -> 37 importable
data/salesql-targets.csv     30 companies
data/salesql-contacts.csv    89 named contacts  -> 84 importable
data/hunter-cache/           54 domains, 432 cached email objects
tools/run-enrichment.ts      Hunter driver
tools/run-mobile-enrichment.ts  Snov + Hunter-cache driver
```

**121 importable named contacts** are sitting in those CSVs, verified by
`npm run contacts:import -- --file <f> --dry-run`. Against 17 role aliases in
the database. This is the first time the system has had named individuals at all.

**But both scripts are red and must not be committed as they stand:**

- `npm run check:no-raw-http` fails — 8 raw `fetch` sites bypass `FetchPolicyGate`.
  The AST scanner covers `tools/`, so this fails `npm test` by design.
- `npx tsc --noEmit -p tsconfig.backend.json` fails — 20 errors, all in those two
  files. The repo was clean before them.
- `tools/run-mobile-enrichment.ts` has a `TECH_LEADERSHIP_REGEX` that deliberately
  matches `cto`, `vp of engineering` and `technical founder`. That is non-negotiable
  #2, never amended. The importer's `isExecutiveContact` caught 3 (`rahul@phonepe.com`
  Founder & CTO, `nishant.singh@groww.in` VP of Engineering, `jocelyn@duolingo.com`
  Global Head of Talent Brand), so the database stayed clean — but the regex will keep
  collecting executives on every run. **Delete that branch.**

Already fixed in the working tree: three live API keys were hardcoded in those two
files (Hunter, Snov id + secret). Verified via `git log --all -S` that they were
**never committed**, so nothing leaked. They are env-only now. `.gitignore` was also
widened — the old rule was `data/contacts*.csv`, anchored to one filename, and
`mobile-contacts.csv` / `salesql-contacts.csv` / `hunter-cache/` all slipped past it.
Now `data/*contacts*.csv`, `data/*targets*.csv`, `data/*-cache/`.

---

## 2. The problem this milestone exists to solve

The operator's own framing, and it is correct:

> the percentage of seeing some positive reply from Duolingo or Uber is very low

The corpus is why. **Queried and confirmed: the newest YC batch in the database is
Winter 2020, with 7 companies. There is nothing from 2021 onward.** The 1,975 YC
companies are all 2006–2020 vintage, which means the survivors are now
Duolingo/Uber/Instacart scale and the rest are dead. A corpus of fifteen-year-old
accelerator alumni is a corpus of companies with a recruiting org, an ATS, and no
reason to answer a cold email from a student.

The operator wants: **recently funded companies, with an app as a product, with decent
engineering teams, in India / US / Europe / UK.** That is the right instinct. The
measurements below say which parts of it are reachable and which are not.

### 2.1 The real bottleneck is a list of company domains, not YC and not an adapter

The operator pushed back on this brief's original framing and was right:

> it's just not YC. 1000+ startups are on twitter, linkedin, you name it — just hiring

Correct, and the original framing was shaped by which feed happened to be wired up
rather than by what the right source is. Three facts settle where to go instead, all
verified 2026-10-03.

**First, the two surfaces where those startups are most visible are the two that are
structurally closed.** LinkedIn is non-negotiable #1, absolute, never amended. X/Twitter
is login-walled and its API starts around $100/month, which the budget rules out before
robots even comes up. "They are all visible there" is true and does not convert into
reachable.

**Second, the ATS job-board APIs are open, and we already have adapters for all three:**

| host | robots.txt | verdict |
|---|---|---|
| `boards-api.greenhouse.io` | `Disallow: /embed/` only | **allowed** |
| `api.lever.co` | `Allow: /`, `Crawl-delay: 1` | **allowed** |
| `api.ashbyhq.com` | 401 → no rules published | **allowed** |

(Note `jobs.ashbyhq.com/robots.txt` *does* say `Disallow: /api/` — but our Ashby
adapter targets `api.ashbyhq.com/posting-api/job-board`, a different host, so it is
clear. Also note `signatures.ts` references `boards.greenhouse.io/embed/job_board/js`
as a *detection signature it looks for in HTML*, never a URL it fetches; if anything
ever fetches that URL it would be robots-disallowed.)

**Third — and this is the structural point — none of those APIs has a discovery
endpoint.** Our own code says so, at `src/core/policy/host-lists.ts:61`:

> `'Lever postings API: GET /v0/postings/{slug}?mode=json, no auth. No discovery`
> `endpoint — slug resolution is part of detection (B6).'`

You cannot ask Lever to list every company using it. You need the company's domain
first, then detect its board, then read its postings.

**Therefore: the bottleneck was never YC, never the ATS, and never a missing adapter.
It is a list of company domains.** Every pipeline stage downstream of a domain already
works and is already allowed. yc-oss is one domain list that happened to be plumbed in
first — and §1.1 shows what a 940-company domain list is worth on its own without
board detection: zero qualified leads.

So the milestone to run is **domain-list acquisition**, and the open sources for it are:

| domain list | size | status |
|---|---|---|
| yc-oss | 6,269 total, 940 just loaded, ~2,400 pre-2021 still unused | plumbed, free, exhausted of its best band |
| HN "Who is hiring" archive | ~250 companies/month, and 23% publish an address | **open, unexploited — §3.5** |
| operator hand-curated CSV | 188 companies → produced all 139 named contacts | **highest yield per company of anything measured** |
| open-licensed company datasets | unquantified | **not yet checked — see §3.6** |

### 2.2 Adzuna is closed. Two handover documents currently point at it

F5a carry-forward #3 and F5b carry-forward #3 both name **Adzuna or data.gov.in** as
the answer to India coverage. Adzuna has been assumed viable across three milestones
and was never checked. Checked 2026-10-03:

```
$ curl -s https://api.adzuna.com/robots.txt
User-agent: *
Disallow: /
```

**Closed**, on the same grounds as SmartRecruiters, Common Crawl and the iTunes Search
API. Under non-negotiable #3 the gate refuses it and there is nothing to build.

This is the fifth time a source named in a brief turned out closed when someone finally
read its robots.txt. **Read robots before writing the sentence that recommends a
source.** `data.gov.in` is the surviving half of that carry-forward and has not been
checked either; check it before planning around it.

---

## 3. Measured findings — do not re-measure these

### 3.1 The corpus is missing 3,796 recent YC companies, and the loader already exists

`https://yc-oss.github.io/api/companies/all.json`, fetched live 2026-10-03,
`last_updated: 2026-10-03T02:59:55Z`, 10.5 MB:

```
total companies in the feed    6,269
in our database                1,975
newest batch in our database   Winter 2020
companies in batches >= 2021   3,796   <- entirely absent from the corpus
```

The feed already carries `batch`, `team_size`, `status`, `all_locations`, `regions`,
`tags`, `industries`, `one_liner`, `long_description`, `isHiring`. `src/ingest/yc/yc-oss.ts`
already parses every one of those fields and `YC_SOURCE_KEYS` already maps them to
Company columns with per-field Evidence. **The host is already allowed, the adapter is
already written and fixture-tested, and the data is already free.** This is the single
cheapest action available in the whole project.

`meta.json` publishes only 9 feeds (`all`, `top`, `hiring`, `nonprofit`,
`black-founded`, `hispanic-latino-founded`, `women-founded`, `app-video-public`,
`demo-day-video-public`). **There are no per-batch feeds** — batch filtering happens
after fetching `all.json`, not by picking an endpoint.

### 3.2 Filter on team size, not on batch year

The operator caught an error here and it is worth recording as the rule rather than
just the corrected number. An earlier draft of this brief recommended a "2021–2023
band". **That was wrong: batch year adds nothing that `team_size` 10–250 does not
already do, and cutting at 2023 discarded 207 usable companies for free.**

Per batch year, over the live feed:

| batch year | all | team 10–250 | + active | + target geo | median team size |
|---|---|---|---|---|---|
| 2021 | 726 | 383 | 321 | **215** | 10 |
| 2022 | 631 | 307 | 260 | **166** | 10 |
| 2023 | 494 | 144 | 136 | **114** | 5 |
| 2024 | 590 | 125 | 119 | **111** | 4 |
| 2025 | 621 | 82 | 80 | **73** | 3 |
| 2026 | 732 | 27 | 27 | **23** | 2 |
| 2027 | 2 | 0 | 0 | 0 | 2 |
| | | | | **702** | |

**The rule: take every batch from 2021 to the latest, and filter on
`team_size` 10–250 and `status = active`. 702 companies in India / US / UK / Europe,
none of them in the corpus today.**

What the median column shows is why recent batches *contribute* less rather than why
they should be excluded: median team size falls 10 → 2 across the span, so 2026 has 732
companies but only 27 clear the size floor. Those 27 are still valid targets — a
2026-batch company that already has 10+ people is usually a second-time founder team,
and recency is a point in favour for "recently funded", not against. The size filter
removes the 3-person companies on its own, by name, without a proxy.

### 3.2a Why the size floor is the one that matters

Median `team_size`, by batch band, over the live feed:

| band | companies | median team size (of those > 0) |
|---|---|---|
| batch >= 2024 | 1,945 | **3** |
| batch 2021–2023 | 1,851 | **8** |
| batch <= 2020 | 2,463 | 11 |

`team_size` is populated — 1,874 of the 1,945 post-2024 companies carry a positive
value, so the 3 is real and not a missing-data artifact.

**A 3-person YC company is not a target.** It has no intern programme, no mobile team,
and the only people to email are the founders, who non-negotiable #2 excludes. That is
the reason for the size floor — and the reason the floor is sufficient on its own.

The full filter cascade over every batch from 2021 to the latest:

```
batch >= 2021, in the feed       3,796     <- none of these are in the corpus
  + team_size 10-250             1,068
  + status active                  943
  + target geography               702     <- the target set
  of which isHiring                424
  of which any mobile signal        30
```

Geography of the 943 that clear size and status:

```
US 528 · other 231 · Europe 66 · India 62 · UK 46 · blank 10
```

For comparison, the band immediately before this one — batch 2018–2020, already partly
in the corpus — contributes 438 active size-qualified companies, 350 in target geos. It
is not off-limits, but those are the companies closest to the Duolingo problem this
milestone exists to escape, so take the 702 first and judge the result before reaching
further back.

### 3.3 YC is not a mobile-app source, and this is the hard finding

**Only 30 of the 702 target companies carry any mobile signal** — searching
`ios|android|mobile|swift|kotlin|flutter|react native|app store|play store` across
`one_liner`, `long_description`, `industry`, `subindustry`, `tags` and `industries`.

The reason is structural: YC's recent portfolio is overwhelmingly B2B AI and developer
tools. The most common tags in the mobile-signal set are `B2B`, `AI`,
`Artificial Intelligence`, `Developer Tools`, `Enterprise Software`.

This confirms F5b carry-forward #7 at the source level rather than the posting level —
there, only 38 of 4,615 postings mentioned a mobile technology in the title. **The
`ios_android` ceiling is not the matcher and not the weights. It is that YC does not
fund many consumer mobile companies any more.** No amount of re-filtering the YC feed
produces a mobile corpus.

**Which means the app-company track cannot come from an automated YC pass, and the
operator has already found the thing that does work:** `data/mobile-targets.csv` is 65
app companies picked by hand — Headspace, Superhuman, Strava, Calm, AllTrails, Hinge,
Turo, ClassPass, Groww, PhonePe, Rapido, ShareChat, Dream11, INDmoney — and running
Hunter and Snov over that hand-built list produced 50 contacts including named iOS
engineers. **The scalable version of that is a longer hand-built list, not a new
crawler.** A human browsing the App Store, reading Entrackr and Inc42, and typing
domains into a CSV is allowed, costs nothing, and is the only thing measured in this
project that has produced a named mobile engineer.

### 3.4 Closed sources — quoted, so nobody re-checks

**iTunes / App Store Search API — CLOSED on robots.**
It looked ideal: free, no key, documented, and it returns `sellerName` plus `sellerUrl`
(the developer's own website, i.e. the company domain) for any app. Verified working
live. But `https://itunes.apple.com/robots.txt` says:

```
User-agent: *
...
Disallow: /search*
Disallow: /*/lookup?
```

The Search API endpoint *is* `/search?...` and the lookup endpoint *is* `/lookup?...`.
Both are explicitly disallowed for all user agents. Under non-negotiable #3 this is
refused, the same way SmartRecruiters and Common Crawl were. Do not build an adapter;
do not propose a user-agent exception.

**GitHub commit history — CLOSED on terms, not robots.**
Measured in `docs/CONTACT-SOURCES-RESEARCH.md`: 7 of 10 corpus companies yielded real
named-engineer `@company.com` addresses from `/repos/{org}/{repo}/commits`, median 3
each. Best hit rate of anything tested. But GitHub's Acceptable Use Policies say:

> "You may not use information from the Service (whether scraped, collected through our
> API, or obtained otherwise) for spamming purposes, including for the purposes of
> sending unsolicited emails to users or selling personal information, such as to
> recruiters, headhunters, and job boards."

It covers API-collected data explicitly and names this exact pattern. The operator's own
authenticated `gh` account would be the one breaching it. Closed.

**Common Crawl — CLOSED on robots.** `https://index.commoncrawl.org/robots.txt` is
`Disallow: /` with a seven-line allow list that does not include the
`/CC-MAIN-<crawl>-index?url=` query path. Also impractical: the CDX index returns WARC
offsets, not content, so extracting `mailto:` links means pulling multi-GB segments.

**SmartRecruiters** (F5a §3), **Darwinbox** (key is generated in each employer's own
admin console), **Naukri** (`Disallow: /` for AI crawlers, and a third-party
republication rather than an employer-published fact): all closed, all recorded.

### 3.5 Open sources — verified, with measurements

**Hacker News "Ask HN: Who is hiring?" via the Algolia API — OPEN, and the best new
find here.**

`https://hn.algolia.com/robots.txt` returns **404** — no rules published. The API is
free, documented, needs no key. Measured against the September 2026 thread
(`https://hn.algolia.com/api/v1/items/49522897`, 489 KB):

```
top-level job posts                     253
posts containing an email address        60   (23%)
posts mentioning iOS/Android/mobile      20
  of those, carrying an email             6
```

Real examples pulled: `arnav@stpkr.in` (Noida, India), `jobs@thisdot.co` (Senior
Android / React Native), `info@newtonstree.com` (London, UK), `jobs@proxybase.xyz`.

Why this is better provenance than anything else evaluated: **the employer posted the
address themselves, in a thread whose entire purpose is inviting applications.** That is
an employer-published fact with a citable source URL and a verbatim excerpt, which is
precisely what non-negotiable #4 requires — and unlike GitHub, nobody's terms are
violated by writing to an address someone published asking to be written to.

Threads run monthly and the archive is open. At ~253 posts and ~60 addresses per month,
**twelve months of archive is roughly 3,000 job posts and ~700 addresses**, skewed to
small actively-hiring startups across US, Europe, UK and India — which is the exact
population this milestone wants. This is the largest free contact source found in the
entire project and it has never been touched.

**Entrackr and Inc42 — robots permit article pages.** India funding news, which is the
one thing yc-oss structurally cannot supply (India is 62 of the 943 size-qualified YC companies).

```
entrackr.com:  User-agent: *  /  Disallow: /static/*          <- articles allowed
inc42.com:     User-agent: *  /  Allow: /  /  Disallow: /*?*  <- articles allowed, query strings not
```

Unstructured prose, so extraction is harder than a JSON feed, and each would need its
own host allow entry. Worth scoping only after the YC backfill and HN are done.

**TechCrunch — allowed for a generic agent, but read this first.** The `*` group only
blocks `/wp-admin/`, `/wp-json/`, `/search/` and `/?s=`. But the file also contains:

```
User-agent: anthropic-ai
Disallow: /
User-agent: Applebot-Extended
Disallow: /
```

Our crawler is not `anthropic-ai`, so the `*` group governs and article pages are
technically permitted. But they have explicitly excluded AI crawlers, and the spirit of
non-negotiable #3 is not "find the group that lets you in". Put this to the operator
rather than deciding it in an adapter.

**Product Hunt** — the GraphQL API at `api.producthunt.com/v2/api/graphql` is not
covered by the robots disallow list (`/search*`, `/auth/*`, `/my/*` and friends are).
Needs a free OAuth token and its own terms-of-service pass, which has **not** been
done. Do not build it on the strength of this paragraph.

**How the gate treats an unreadable robots.txt** — worth knowing, because several
candidate hosts return 4xx to an undeclared user agent. `src/core/policy/robots.ts:116`:

```ts
if (res.statusCode >= 400 && res.statusCode < 500) {
  return { body: '', parseOk: true, statusCode }
}
```

A 4xx (403 or 404) is treated as **no rules published, therefore allowed**. A 5xx or a
network failure returns `parseOk: false` and fails closed. So `hn.algolia.com` (404),
`sec.gov` (403) and `eu-startups.com` (403) are all allowed by the gate. SEC
additionally requires a declared `User-Agent` carrying a contact email as published
policy — complying with that is honest identification, not spoofing, and is fine.

### 3.6 Domain-list candidates that have NOT been checked

§2.1 reframes the milestone as domain-list acquisition. These are the remaining
candidates, and **none of them has been verified** — they are named here so the next
pass knows where to look, not as recommendations. Read each one's robots.txt and terms
*before* writing a sentence that recommends it. That rule exists because five sources
have now died at that step.

- **`data.gov.in`** — the surviving half of the India carry-forward now that Adzuna is
  closed (§2.2). India is the weakest geography in the corpus (61 of 940 in the
  backfill, 5 of 71 detectable boards in F5a's measurement) and it is the operator's
  own country, so this is the highest-value unchecked item.
- **Open-licensed company datasets.** Public datasets listing companies by ATS, by
  funding, or by sector exist as plain data files. Reading an openly-licensed dataset
  is **not** the GitHub problem from §3.4 — that clause prohibits using GitHub data to
  send unsolicited email to GitHub users, not reading a published dataset of company
  domains. Check the licence on each; an unlicensed scrape dump is all-rights-reserved
  compiled data and gets treated the way H7 treats yc-oss: seed index only.
- **Free remote-job boards with public JSON.** `remoteok.com` robots is `Allow: /`
  with `Crawl-delay: 1`, but **explicitly disallows `?action=get_jobs`**, which is one
  of its JSON endpoints — so check the exact path, not the host. `arbeitnow.com`
  returned a 301 and `remotive.com` a 403 on robots; neither was followed up.
- **Entrackr and Inc42** — already robots-checked and permitted (§3.5), unstructured
  prose, India funding news. The extraction problem is the work, not the access.
- **Product Hunt** — API path not disallowed, needs a token and a terms pass (§3.5).

---

## 4. Non-negotiables. These are not suggestions

1. **Never automate LinkedIn or any gated or login-walled platform.** Absolute. The
   operator browsing LinkedIn by hand is fine and is part of the plan; a crawler is not.
2. **Never target founders, CEOs, C-suite or VPs.** Any other current employee is
   valid — SDE1, SDE2, senior, staff, tech lead, EM. `isExecutiveContact`
   (`src/outreach/contacts/executive-filter.ts`) enforces it, reads both the title and
   the local part, and fails closed on an unparseable title. Call it; never route
   around it.
3. **Every network request goes through `FetchPolicyGate`.** An AST scanner
   (`tools/check-no-raw-http.ts`, run by `npm test`) scans `src`, `test`, `tools` and
   `app` and fails the build on a bare `fetch`, `XMLHttpRequest` or `WebSocket`.
   **robots is unconditional.** No user-agent spoofing, no robots override, no
   "this subdomain happens to serve no robots.txt" technicality.
4. **Provenance on every fact.** Every stored value needs an `Evidence` row with a
   source URL and a verbatim excerpt. A value that cannot be traced to one does not
   belong in the database.
5. **No blind pattern guessing.** `CONTACT_ALLOW_PATTERN_INFERENCE=false`. Guessed
   addresses bounce 30–40% and burn the sending domain. Pattern construction is
   permitted only per-company, derived from at least one confirmed address at that
   company.
6. **Sending stays disabled.** `MILESTONE_STAGE = 'F5'` in `src/core/config/stage.ts`,
   enforced in source and not only by an env var. This milestone does not change it.

---

## 5. What to do, in order

**Steps 1 through 4 are DONE and cost zero credits.** §1.1 and §1.2 record what they
produced and what they did not. Commits `6c8e814`, `45b41cb`, `93db2bd` — three ahead
of `origin/main` and not yet pushed as of 2026-10-04.

| step | state | outcome |
|---|---|---|
| 1 — YC growth-band backfill | done | 940 companies, add-only |
| 2 — free scoring pass | done | 266 scored, **0 qualified** |
| 3a — get `main` green | done | executive regex deleted, scripts in `scratch/`, 604 tests green |
| 3b — import gathered contacts | done | **17 → 126 contacts**, 109 named humans |
| 4 — board detection on the 266 | done | 61 boards, **99 → 154 qualified companies** |

### Step 5 — Board detection on the remaining 674. Run it, but sample first.

**Worth running: yes.** It is free, it needs no attention, and §1.2 proved a board is
the single thing that qualifies a company. All 674 have a `website` value, so there is
nothing structurally blocking detection on them — verified by query.

**But do not run all 674 in one pass, and do not trust the yield estimate.** The
estimate on the table is 23% × 674 ≈ 155 boards ≈ 140 new leads. Two reasons to
distrust it:

- This brief's last two yield predictions were wrong by roughly half (§1.2). The
  prediction that produced the 23% was itself a prediction of 45%.
- The 674 scored *nothing*, meaning their feed text was too thin to produce evidence.
  Whether thin feed text correlates with a thin careers page is unknown, not measured.
  It is plausible either way.

**Run ~150 of them first (~20 minutes at the measured pace), re-run the free scoring,
and measure the board rate and the qualify rate on that sample.** Then extrapolate to
the remaining ~520 with a number instead of a guess. This is the same discipline that
caught both earlier errors, and it costs twenty minutes to avoid an hour and a half
spent on a wrong premise.

Implementation is a one-line widening of `--detect-band-scored` to include
`insufficient_evidence` companies. Add a limit flag while you are in there, so the
sample is a flag and not an edit.

### Step 6 — Scope the HN "Who is hiring" source. This is now the critical path.

**Do this in parallel with step 5, not after it.** Step 5 is wall-clock time with
nobody watching; step 6 is engineering attention. They do not compete.

And step 6 is the one that moves the actual goal. §5's arithmetic makes the reason
plain: **qualified companies are no longer the bottleneck — contacts at them are.** 154
qualified companies against 126 contacts, and another 140 qualified companies would add
roughly 17% × their count in generic role aliases and nothing else. The 500–800 target
runs through HN and the monthly provider drip, not through more companies.

253 posts and ~60 published addresses per month, open archive, free, no key,
robots-clear, and the addresses are employer-published invitations to write. Needs: one
host allow entry for `hn.algolia.com`, an adapter reading a thread's children, a
company resolver (post text → domain, the hard part), and the existing executive filter
on the way in.

### Step 7 — Then pick the next domain list.

§3.6 holds the unchecked candidates, `data.gov.in` highest-value because India is the
weakest geography — **1 of the 55 new qualified leads is Indian.** Read robots and
terms *before* writing the sentence that recommends one.

### The arithmetic, updated with measured values

| source | contacts | kind | state |
|---|---|---|---|
| role aliases from F5b | 17 | generic | banked |
| CSVs gathered by hand | **109** | **named humans** | banked — 126 total |
| Tier A over the 55 new qualified companies, at 17% | ~9 | generic | not yet run |
| step 5, if it yields ~60–140 more qualified companies, Tier A at 17% | ~10–24 | generic | pending |
| **HN archive, 12 months at the measured rate** | **~700** | mixed, employer-published | **unexploited** |
| Hunter + Snov free tiers | 40–60/month | named + patterns | monthly, by hand |

**126 banked of a 500–800 target.** Everything measured so far has moved the company
count hard and the contact count once. Only two sources remain that can move contacts at
scale: HN, and the monthly provider drip. Note what this means for sequencing — running
detection on the 674 is free and worth doing, but it is not progress toward the target;
it is preparation for a drip that still has to be run by hand, 100 lookups at a time.


## 6. What to avoid

**Do not re-measure what is already measured.** Tier A's yield is 17% floor, 18%
ceiling over 99 companies, converged (F5b §7). The `ios_android` ceiling is the corpus,
not the matcher. GitHub, Common Crawl, iTunes, SmartRecruiters, Darwinbox and Naukri are
closed, with quoted evidence in §3.4 and in `docs/CONTACT-SOURCES-RESEARCH.md`.

**Do not chase the newest YC batches.** Median team size for batch ≥ 2024 is 3 people.
The instinct that "newer is better" is wrong here and §3.2 has the numbers.

**Do not try to build a mobile-app corpus out of the YC feed.** 30 of 702. §3.3.

**Do not recommend a source before reading its robots.txt and its terms.** The count is
now five: SmartRecruiters, Common Crawl, the iTunes Search API, GitHub commit emails
(terms, not robots) and Adzuna — the last of which two handover documents had been
recommending for three milestones. This is the single most repeated mistake in the
project's history.

**Do not treat a bigger corpus as progress.** The backfill grew the corpus 44% and
produced zero qualified leads (§1.1). Companies are not targets until something has
fetched their board or their pages. Report what a step failed to achieve, not only its
row count.

**Do not treat qualified companies as progress either, now that they are not the
bottleneck.** 154 qualified companies against 126 contacts. A step that adds companies
without adding contacts has not moved the goal; say so when reporting it.

**Do not trust a yield prediction in this document.** Two were wrong by half (§1.2):
45% predicted board detection against 23% measured, 138 predicted contacts against 126.
Measure a sample, then extrapolate.

**Do not propose LinkedIn or X as a source, in any form.** They are where these
companies are most visible and they are the two that are structurally closed (§2.1).

**Do not run `prisma db push`.** It reports the hand-written partial unique indexes on
`send_attempt` as drift and offers to drop them. Use `prisma migrate`.

**Do not parse CSVs with `.split(',')`.** `src/ingest/file/csv.ts` is a hand-written
reader that exists because a quoted comma shifts every column after it, which in these
files surfaces as a wrong domain or a wrong email address rather than as an error. Both
new enrichment tools use `.split(',')`; it happens not to bite today only because the
two fields they read sit left of the first quotable column.

**Do not hardcode credentials.** `origin` is a public GitHub repository. Env only.

**Do not widen a `.gitignore` rule by adding one more exact filename.** The rule that
failed was `data/contacts*.csv`, which stopped covering the next file the moment a run
named its output differently.

**Do not write a `CompanySignal` for a fact nobody observed.** `CompanySignalType` is a
closed enum of things observed about a company (`yc_profile`, `careers_page`,
`job_posting`). Filing a typed line or a feed row under the nearest value puts a false
claim about origin into the table the scorer reads.

**Do not bump `ScoreVersion` for nothing, and do not fail to bump it when the
derivation changes.** F5b went `f2-v1` → `f5b-v2` with byte-identical weights, because
the *inputs* changed and leaving the label alone would have put two different totals for
one company under one version label in the audit trail. Backfilling companies changes
no derivation, so step 1 alone needs no bump.

**Do not collapse a measurement into a verdict the operator did not ask for.** F5a and
F5b both got this right: report the floor and the ceiling and say which is which. Two
bounds one point apart is a measurement; two bounds 25 points apart is not.

**Do not spawn subagents.** A previous research attempt fanned out into nine children
and burned the account's spend limit twice plus the entire web-search budget. One
session, one worker.

**Do not write code in a research pass, and do not research in an implementation pass.**
This project's milestones stay clean because they do one of the two.

---

## 7. Reference

Read in this order:

```
handover.md                          the policy spine
docs/architecture-plan.md            the contract, never edited
docs/ORCHESTRATOR-HANDOVER.md        system context and the operator's amendments
docs/CONTACT-SOURCES-RESEARCH.md     what is closed and why, with quotes
docs/F5a-MANUAL-INGEST-HANDOVER.md   the CSV seed and import paths
docs/F5b-POSTING-BODY-HANDOVER.md    the matcher, and the India/ATS measurements
docs/F5c-TARGET-EXPANSION-BRIEF.md   this file
```

Operational notes: tests run against `outreach_test`, everything else against
`outreach_dev`, and they do not collide. Milestone verifiers use `isAtOrAfter` and must
keep passing at later stages. The ingest is resumable but re-fetches every company whose
detection previously failed, so a restart costs a full pass.

---

## The paste block

```
You are continuing F5c of a local internship outreach system at
/Users/aryamanjaiswal/Documents/ChatGPT/scraper.

Read docs/F5c-TARGET-EXPANSION-BRIEF.md FIRST and in full. It was written for a chat
with zero context: measurements, closed sources with quoted evidence, the
non-negotiables, and the live step order. Then handover.md for the policy spine. Do not
re-measure anything it records as measured, and do not re-propose anything it records
as closed.

WHERE THINGS STAND (verified against the database 2026-10-04)
Steps 1 through 4 are DONE and every one of them was free.
  companies    3,085   (YC growth-band backfill added 940)
  postings     5,084   (board detection attached 469)
  qualified      154 companies / 249 company-track rows   (was 99 / 194)
  contacts       126   (was 17; 109 of them named humans)
  credits      7,637 / 50,000 - nothing spent this milestone
main is GREEN: 604 tests, lint and typecheck clean. Three commits ahead of
origin/main, unpushed: 6c8e814, 45b41cb, 93db2bd.

THE FINDING THAT MATTERS - brief section 1.2
A detected job board is close to decisive. Of the 266 scored companies, 61 had a board:
mean score 82.5, and 55 of the 61 now qualify. The 205 without a board average 32.6 and
NOT ONE exceeded 44 against a 70 threshold. Feed text cannot qualify a company;
postings can. Recent YC companies are on Ashby, not Greenhouse - 56 of the 61 boards.

Mobile is still 0 and will stay 0. The YC feed cannot supply app companies (30 of 702
carry any mobile signal). That track is hand-built lists plus the provider free tiers,
and the brief says so in section 3.3.

THE REFRAME - brief section 2.1
The bottleneck is NOT YC, NOT the ATS, NOT a missing adapter. It is a LIST OF COMPANY
DOMAINS. Greenhouse, Lever and Ashby board APIs are all robots-allowed and all three
adapters already exist, but none has a discovery endpoint - our own code says so at
src/core/policy/host-lists.ts:61. You need a domain first, then detect the board.

And as of now the bottleneck has moved AGAIN: qualified companies are no longer scarce,
contacts at them are. 154 qualified companies against 126 contacts. A step that adds
companies without adding contacts has not moved my goal. Tell me that when it happens.

LinkedIn and X are closed - non-negotiable #1, and a login wall plus a ~$100/month API.
Adzuna is closed: api.adzuna.com/robots.txt is "User-agent: * / Disallow: /", which
makes two handover docs wrong. Do not propose any of these.

DO, IN THIS ORDER - and 1 and 2 run in parallel
1. Board detection on the remaining 674 insufficient-evidence companies, but SAMPLE
   FIRST: run ~150, re-score for free, measure the board rate and qualify rate, then
   extrapolate to the rest. All 674 have a website, so nothing blocks it. Do not trust
   the 23% estimate - this brief's last two yield predictions were both wrong by half.
   Implementation is a one-line widening of --detect-band-scored plus a limit flag.
   It is wall-clock time, not attention, so start it and work on 2 while it runs.
2. Scope the HN "Ask HN: Who is hiring?" source. THIS IS THE CRITICAL PATH, because it
   is one of only two sources left that can move the contact count at scale. Free
   Algolia API, robots 404, no key. Measured on one thread: 253 job posts, 60 carrying
   an email address, employer-published in a thread whose purpose is inviting contact.
   ~700 across the open archive. The hard part is resolving post text to a domain.
3. Only then pick the next domain list, from brief section 3.6. data.gov.in is the
   highest-value unchecked one because India is my weakest geography - 1 of the 55 new
   qualified leads is Indian. Read its robots.txt and terms BEFORE recommending it.
   Five sources have now died at exactly that step.

NON-NEGOTIABLES
No automating LinkedIn or any login-walled platform. Never target founders, CEOs,
C-suite or VPs; every other current employee is valid - SDE1, SDE2, senior, staff, tech
lead, EM. Every request goes through FetchPolicyGate and robots is unconditional: no UA
spoofing, no overrides, no "this host serves no robots.txt" technicalities. Every stored
value needs an Evidence row with a source URL and a verbatim excerpt. No blind pattern
guessing - only per-company, from a confirmed address at that company. MILESTONE_STAGE
stays F5; sending stays disabled. Never run prisma db push. No subagents - a previous
attempt fanned out to nine and burned the spend limit twice.

HOW TO WORK
I am a B.Tech student in India and the budget is zero. Free, free-tier or trivially
one-time only; "just pay for it" is not an answer. Verify claims against the code and
the live database rather than trusting a summary - three separate bugs in this project
were found by querying rather than by reading a report. Measure a sample before
committing to a whole batch; that habit has now caught two wrong predictions. Report a
floor and a ceiling rather than collapsing a measurement into a verdict, and tell me
what a step did NOT achieve, not only what it did. Be direct and correct me when I am
wrong about my own system - I was wrong about chasing the newest YC batches and right
that YC was too narrow, and both corrections came from pushing back.
```
