# F4 Handover — The Drafting Sandbox

**Written:** 2026-09-10, at the end of the F3 session.
**For:** the next implementation session, which builds F4 and nothing else.
**Status of the repo when this was written:** F3 complete, 11/11 exit criteria met, 357 tests passing, F0–F2 committed (3 commits on `main`), F3 uncommitted.

---

## 0. Read these first, in this order

| File | What it is | Binding? |
|---|---|---|
| `handover.md` | The original brief. **§1's non-negotiable policies are binding and are not restated anywhere else.** | Yes, except where the plan overrides |
| `docs/architecture-plan.md` | The approved architecture plan, verbatim. Defect ids (A1–A12), verification ids (B1–B7), design (Part D), build order (Part F), tests (Part G), decisions (Part H). | **Yes — this is the implementation contract** |
| `docs/F1-HANDOVER.md` | What F0 built, F0's nine deviations, and the F1 task. Its §4 deviations are all still in force. | Yes |
| `docs/F2-HANDOVER.md` | What F1 built, F1's fifteen deviations, and the F2 task. Its §4 deviations are all still in force. | Yes |
| `docs/F3-HANDOVER.md` | What F2 built, F2's fifteen deviations, and the F3 task. Its §4 deviations are all still in force. | Yes |
| `docs/F4-HANDOVER.md` | This file. What F3 actually built, every deviation from the plan and why, and the F4 task. | Yes |
| `docs/handoff-llm-gateway.md` | How the LLM role works. Now carries an **"As built (F3)"** section: the two-sided allow-set and `ResearchBrief` persistence. | Yes |
| `README.md` | Setup and the things that bite. | Informational |

Do not redesign the plan. Do not weaken its safeguards. Do not introduce scraping of gated platforms. Do not substitute unverified data sources for verified ones.

**Never edit `docs/architecture-plan.md`.** It is the original contract, reproduced verbatim so it stays auditable. Implementation decisions that depart from it are recorded in the handover for the milestone that made them — F0's in `F1-HANDOVER.md` §4, F1's in `F2-HANDOVER.md` §4, F2's in `F3-HANDOVER.md` §4, F3's in §4 below.

> **Read this before you `git add` anything.** Until F3, `.gitignore`'s blanket `*.md` rule made **the whole of `docs/` untrackable** — the architecture plan and every handover in the chain. `handover.md` survived only because it was tracked before the rule existed. Fixed in F3 (§4.9). If you are the first session to commit after that fix, `docs/` is what you are committing.

### The five rules that outrank convenience

Unchanged, and all five now have F0, F1, F2 and F3 code standing on them:

1. **Never automate LinkedIn or any gated platform.** `handover.md` §1.4. Enforced at the transport layer by `FetchPolicyGate`, with tests asserting zero sockets — including that a *redirect* into a denied host is refused exactly as a direct request is. F3 stores the operator's own LinkedIn URL as an `ApprovedClaim`; nothing fetches it, and the denylist refuses the host regardless of where the string came from.
2. **Never infer an email address, and never target founders/CEOs/executives.** §1.1, §1.2. **F3 still creates no `Contact` rows. F4 is the first milestone that may** — and it is the milestone this rule was written for.
3. **Every network request goes through `FetchPolicyGate`.** No exceptions. The AST scanner fails the build and now covers `app/` and `.tsx` as well (§4.6).
4. **Sending stays hard-disabled until F5** — enforced by `MILESTONE_STAGE` in source, not just an env var. It now reads `'F3'`; `resolveSendingEnabled()` still returns false. **Do not raise it past F4.**
5. **Provenance on every fact.** F3 added the second half: `Evidence` bounds what may be said about the **company**, `ApprovedClaim` bounds what may be said about the **candidate**, and both are enforced at a choke point rather than trusted (§4.1).

---

## 1. What this system is, in one paragraph

A local, review-first system that turns a broad universe of startups into a small queue of internship opportunities across four tracks (iOS/Android, AI Engineer, SDE, SWE), prioritising India then remote-viable US/UK/EU. **The terminal action is an application, not an email** (Part C). The system prepares application packets; the user submits them by hand. Cold outreach is permitted in exactly three named cases and never sends without per-message human approval. It is deliberately not a bulk-email system.

---

## 2. Where the project stands

### F3 is complete

```
npm test          → 31 files, 357 tests passed
npm run typecheck → clean (backend and UI configs both)
npm run lint      → clean
npm run build     → clean (Next 16.3.4, webpack)
npm run verify:f0 → 4/4 criteria met
npm run verify:f1 → 7/7 criteria met
npm run verify:f2 → 7/7 criteria met
npm run verify:f3 → 11/11 criteria met
```

| F3 exit criterion (Part F, F3 handover §8.5) | Evidence |
|---|---|
| 30 reviewable application packets | **37 packets across 17 companies** in `outreach_dev` |
| Every packet fully reconstructible from evidence | 37 packets walked; every answer traces to a live `ApprovedClaim`, every citation to an `Evidence` row; 0 problems |
| Prefilled answer coverage | 370 answers, 74 blanks — all ten deterministic questions answered, blanks are the two judgment questions per packet |
| Prefilled answers come only from `ApprovedClaim` | 21 policy tests. An answer with an empty `approvedClaimIds` fails **schema validation**, not review |
| Browser- and API-derived facts display identically | A test over the viewer's projection for all five `fetchedVia` values: identical key set, identical order, no tier-ranking field exists to render |
| `Opportunity.roleUrl` is the official application URL | 37 packets checked, 0 whose `officialUrl` differs from the employer-published `roleUrl` |
| Nothing auto-submits | 95 source files scanned, 0 ATS submission endpoints; `gate.postJson` called from exactly 1 module (`intel/research/firecrawl.ts`) |
| All F0/F1/F2 invariants intact | `verify:f0` 4/4, `verify:f1` 7/7, `verify:f2` 7/7 at `MILESTONE_STAGE=F3` |
| Milestone bumped honestly | `MILESTONE_STAGE = 'F3'`; `application_submitted` driven through the real generate → accept → submit path in `test/policy/reason-code-coverage.test.ts` |

### The live corpus, after F3

| Measure | End of F2 | End of F3 |
|---|---|---|
| Companies | 150 | 150 |
| Scored leads | 69 | 69 |
| Queue-band leads | 21 | 21 |
| `ResumeVersion` | 0 | **5** (4 tracks; `ios_android` has an iOS and an Android flavour) |
| `ApprovedClaim` | 0 | **55** across 7 categories |
| `ApplicationPacket` | 0 | **37** across 17 companies |
| `ResearchBrief` | 0 | **1** (the one fulfilled F2 brief task, drained) |
| `LlmTask` | 21 | 21 (1 fulfilled, 1 rejected, 19 pending) |

Packet track split: `ai_engineer=16 swe=16 sde=4 ios_android=1`.
Answers: **370 prefilled, 74 deliberately blank** — all ten deterministic questions are
answered on every packet, and the 74 blanks are exactly the two judgment questions ×
37 packets, still queued for a Claude Code session. That is H10 visible in the data:
a packet is complete and usable with the LLM backlog untouched.

### Three numbers that should be read carefully

**1. By country: USA 34, United Kingdom 3, India 0.** The India gap F2 flagged as "the highest-value open question in the project" now reaches the payload. It is still upstream of everything: the corpus is 150 companies from the yc-oss `hiring` feed, of which 123 are USA and 6 are India, and none of the 6 has a detected ATS board with tracked postings. **No scoring or selection change can fix this. It is a corpus decision** — see §8.4.

**2. 15 of 37 packets are senior/staff/lead titles.** It was 20 before F3 added a seniority ranking key (§4.4); the remaining 15 are companies where *every* tracked posting is senior, so there was nothing to promote. These are valid packets — real URL, real provenance — that a second-year undergraduate probably cannot act on.

**3. Zero packets are internships, and that is not a bug in F3.** The corpus holds **19 early-career postings and not one carries a `roleTrackId`**, so none was eligible. Eighteen of the nineteen are genuinely non-software (FP&A, IT Operations, CAD, Mechanical, Power Electronics, Radiation Effects, Revenue Ops) and the matcher was right to refuse them a software label. The nineteenth — Eight Sleep's *"AI/ML Research Internship"* — is exactly on target and missed because F2 §4.13 marks `ai` and `ml` as generic terms worth a quarter each, so a title made only of generic terms lands below the confidence floor. See §8.3.

### Nothing about F3 is committed

`git log` shows the three commits F0–F2 were committed in. Everything F3 wrote is in the working tree. The user commits when they choose. **Note that `docs/` has never been committed at all** — see the callout in §0.

### What F3 deliberately did NOT build

No `Contact`, no `Draft`, no outreach-predicate wiring, no sending, no optional adapter, no browser layer, and no Firecrawl live call.

---

## 3. Environment — read before running anything

### New pins in F3

| Package | Pin | Why this version, and why not `latest` |
|---|---|---|
| `next` | `16.3.4` | `latest`. `engines.node >= 20.9.0`, so it clears this machine's 22.16.0. Part E names Next + server actions. |
| `react` / `react-dom` | `19.3.0` | `latest`, and what Next 16 peers on (`^19.0.0`). |
| `@types/react` / `@types/react-dom` | `19.3.0` | `latest`. Note the types package tracks React's minor, not its patch — `19.3.1` does not exist. |

Everything else is exactly as `F3-HANDOVER.md` §3 recorded it: `prisma`/`@prisma/client`/`@prisma/adapter-pg` `7.10.0`, `pg-boss` `12.30.0`, `undici` `7.29.1`, `tldts` `7.4.12`, `@mozilla/readability` `0.6.0`, `linkedom` `0.18.13`, `vitest` `4.1.11`, `typescript` `5.9.3`, `eslint` `10.10.0`, Node 22.16.0, PostgreSQL 17.

**The three new packages introduced no new advisories.** `npm audit` still reports the same 4 high-severity findings in `prisma`'s own transitive tree (`deepmerge-ts`, `mysql2`); `npm audit fix --force` still wants `prisma@6`, which breaks pg-boss's `fromPrisma`. Left alone deliberately.

No Firecrawl SDK is installed and none should be (`@mendable/firecrawl-js` owns its own HTTP transport).

### Environment traps

Everything from `F3-HANDOVER.md` §3 still applies — do not downgrade npm below 11.19.1; npm blocks install scripts (`allowScripts` in `package.json`, and none of the three new packages needed an entry); `prisma migrate dev` does not reliably regenerate the client, so run `npm run db:generate` after any migration; and `tsc --noEmit` is not run by `npm test`.

**New in F3, and it will bite you:**

- **`Cannot find type definition file for 'react 2'`.** An empty `node_modules/@types/react 2` directory (macOS duplicate debris from an interrupted install) is enough to fail `tsc`, because TypeScript treats *every* directory under `@types/` as an implicit type library and the root config does not pin `types`. The error names no file you wrote and no import you made. `rmdir "node_modules/@types/react 2"` — or reinstall. Check `ls node_modules/@types/` for a name containing a space.

- **`npm run typecheck` now runs two configs.** `tsc --noEmit -p tsconfig.backend.json && tsc --noEmit`. See §4.5 for why they are split — the short version is that the UI config needs `lib: DOM`, and letting that reach `src/` would silently remove one of the three layers keeping `FetchPolicyGate` the only network path.
- **`prisma migrate dev` cannot run non-interactively here.** It prompts on any warning (e.g. adding a unique constraint) and then aborts with *"Prisma Migrate has detected that the environment is non-interactive"*. The migrations in F3 were produced with `prisma migrate diff --from-config-datasource --to-schema … --script`, reviewed by hand, and applied with `prisma migrate deploy`. **Read the generated SQL before applying it** — `db push` is banned because it offers to drop D3's partial unique indexes, and a diff could in principle do the same. F3's diffs were checked and contained no `DROP`; the indexes were re-verified present afterwards.
- **`next build` rewrites `tsconfig.json`.** It sets `jsx: react-jsx` and appends `.next/dev/types/**/*.ts` to `include`. Expected; the comment block survives.
- **`next-env.d.ts` must stay out of the backend config.** It is a root-level `.d.ts` that `tsconfig.backend.json`'s `"*.ts"` include pattern matches, and pulling it in re-types `globalThis` and `process.env` — producing three errors in files that had not changed. It is in that config's `exclude` list for exactly this reason.

### Setup from a clean clone

```bash
brew install postgresql@17 && brew services start postgresql@17
createdb outreach_dev && createdb outreach_test
cp .env.example .env      # set DATABASE_URL / TEST_DATABASE_URL with your pg user
npm install
npm run db:migrate && npm run db:generate
npm run seed:hosts
npm run seed:tracks
npm run seed:budget
npm run seed:operator     # the operator's resumes and approved claims (F3)
security add-generic-password -s outreach-intelligence -a kek \
  -w "$(openssl rand -base64 32)" -U
```

`.env` is gitignored. `SUPPRESSION_HMAC_SALT` is **write-once in practice**: rotating it orphans every existing `Suppression` row, which is how someone who asked never to be contacted becomes contactable again (A10).

---

## 4. Deviations from the plan — every one, with its reason

F0's nine (`F1-HANDOVER.md` §4), F1's fifteen (`F2-HANDOVER.md` §4) and F2's fifteen (`F3-HANDOVER.md` §4) are all still in force and none were reverted. These are F3's. **Do not silently revert any of them; if you disagree, raise it with the user.**

Three of them (§4.8, §4.9, §4.10) are latent defects in earlier milestones that F3 was the first to exercise. F1 found three in F0, F2 found two in F1; the pattern continued.

### 4.1 `ApprovedClaim` is the provenance table for candidate facts, and the citation rule is now two-sided

**The single most consequential design decision in F3.**

D5's citation invariant is stated for the employer: *"the drafting schema requires an `evidenceId` on every personalization sentence, so an unsupported claim is a schema error, not a review finding."* An application answer breaks that framing, because a single sentence asserts things about **both** parties — *"Your platform team writes Go, which is where my backend work sits"* is one claim about the company and one about the candidate, and only the first had a mechanism.

So `ApprovedClaim` became the candidate-side analogue of `Evidence`, with the same enforcement shape:

| | Company facts | Candidate facts |
|---|---|---|
| Provenance table | `Evidence` | `ApprovedClaim` |
| Bounded by | `LlmTask.allowedEvidenceIds` | `LlmTask.allowedApprovedClaimIds` |
| Refused in `fulfilTask` as | `uncited_evidence` | `uncited_claim` |
| Collected by | `collectCitedEvidenceIds` | `collectCitedApprovedClaimIds` |
| Source recorded on the row | `sourceUrl` | `sourceRef` (the resume the claim was lifted from) |

Two additions to the table, both load-bearing:

- **`key`** — a stable slug. The seeder upserts on it, so editing a claim's wording updates the row rather than leaving two versions of the same fact where a later milestone could cite either.
- **`sourceRef`** — which document the statement came from, e.g. `resumes/Resume_IOS.tex`, or `operator` for the four eligibility claims no resume asserts. A statement the system is about to make on the operator's behalf must be traceable to a document the operator wrote.

**A withdrawn claim is deactivated, never deleted.** A packet stores the claim ids its answers cite; deleting a row would strand a packet the operator already accepted. Provenance that pointed at something and now points at nothing is worse than provenance marked withdrawn.

**Enforcement happens twice, and the two checks answer different questions.** `llm:fulfil` asks *"did the session cite outside the set it was given"* — a question about the session. `validateAnswers` re-checks against the **live** `ApprovedClaim` rows at write time — a question about **time**. A task fulfilled last week may cite a claim the operator has since withdrawn, and the check that would have caught it ran before the withdrawal.

### 4.2 A deterministic answer is the concatenation of the claims it cites — never a rewording

`buildDeterministicAnswers` produces an answer whose text is exactly `claims.map(c => c.text).join(' ')`.

This is not fastidiousness; it is what makes the exit criterion mechanically checkable. If the answer text is precisely the union of the claims it cites, then *"every claim in a packet traces to an `ApprovedClaim`"* is verifiable by string containment rather than by a human reading for smuggled facts. A test asserts the reconstruction for every deterministic answer.

The visible consequence is that some answers read a little stiffly — the work-authorization answer is two sentences bolted together. That is the right trade: an answer this system generates about the operator's visa status must be provably the operator's own approved words.

### 4.3 A question with a missing claim is left blank, with its reason — never answered from the subset

`handover.md` §8 forbids falsely claiming work authorization, remote availability or a graduation date. Two questions the corpus asks constantly have no claim behind them, because the operator has not supplied one:

- **expected graduation date.** The resume says "Aug. 2024 – Present". Inferring "a four-year B.Tech starting 2024 graduates in 2028" is precisely the guess §8 forbids.
- **availability / internship window.**

`REQUIRED_CLAIM_KEYS` names both so the seeder reports the gap on every run rather than letting it pass unnoticed, and the packet records them as `unanswered` with the reason spelled out for the operator.

**The operator has since supplied both**, and the graduation date is the argument for the whole mechanism: the answer is **March 2028**, where "Aug. 2024 plus a four-year B.Tech" would have produced mid-2028. An inferred date would have been wrong on all 37 applications and nothing would have flagged it.

The two questions are now answered and the remaining 74 blanks are the judgment questions. The mechanism is unchanged and is tested by *withdrawing* a claim rather than by relying on a permanent gap — a test that depended on those two staying missing would have silently stopped testing anything the moment they arrived.

A question whose claims are only *partly* present is also left blank rather than answered from what exists — a partial answer to *"will you require sponsorship"* is worse than a blank one, because the operator would not know it was partial.

### 4.4 Seniority became a selection key, measured rather than assumed

The first generation run produced 37 packets of which **20 were titled Senior, Staff, Lead or Manager**. Every one was valid — real application URL, real provenance — and almost none was an application a second-year undergraduate could sensibly make. A review queue that is mostly unreachable roles wastes the ten-minute daily review `handover.md` §15 budgets.

`looksSenior` ranks those last, **above** the track match in priority: for an intern a "Software Engineer" one track over is a better application than a "Senior Backend Engineer" dead on track, because the second is not an application they can make. Senior count fell 20 → 15.

Three things this deliberately is not:

- **Not a score change.** A11 freezes the weights and thresholds during the pilot. Seniority is a property of one posting, not evidence about a company, so it belongs to ranking within a company — which is exactly what that ranking exists for.
- **Not an exclusion.** A senior role at a strong company is still worth seeing when nothing better exists there, and dropping all 20 would have taken the corpus under Part F's 30.
- **Not hidden.** `seniorityMismatch` travels with the candidate so the UI can label it.

The full ranking, in order: early-career → not-senior → posting track matches the lead's primary track → freshest `postedAt` (nulls last, because null is *unknown*, not "posted at the epoch") → id, so a re-run selects the same packets rather than reshuffling.

### 4.5 The TypeScript config is split, and the split is a security boundary

Next reads `tsconfig.json` at the repo root and rewrites it, and it needs `lib: DOM`, `jsx`, and `moduleResolution: bundler`. The backend is `module: NodeNext` with `lib: ["ES2023"]` and no DOM.

Merging them looked harmless and is not. **`lib: DOM` makes `fetch`, `XMLHttpRequest` and `WebSocket` typed globals.** In backend code, a bare `fetch` is currently caught three times: by ESLint's `no-restricted-globals`, by `tools/check-no-raw-http.ts`, and — because DOM is absent — by the type checker. Letting the UI's DOM lib reach `src/` would quietly delete the third layer, and F0 built three precisely because any one alone is escapable.

So: `tsconfig.backend.json` holds F0–F2's config unchanged (minus `app/`), root `tsconfig.json` is Next's, and `npm run typecheck` runs both. The UI itself issues no HTTP — server actions reach Postgres through Prisma directly — and both remaining layers were extended to cover `app/` and `.tsx` (§4.6) so the ban survives DOM being available there.

### 4.6 The AST scanner and ESLint now cover `app/` and `.tsx`

Consequence of §4.5, and stated separately because it is the mitigation that makes §4.5 safe. `SCAN_DIRS` gained `app`, the walker accepts `.tsx`, and ESLint's rule block matches `**/*.tsx`. `ts.createSourceFile` infers `ScriptKind.TSX` from the extension, so no parser change was needed.

### 4.7 `--webpack`, because NodeNext's explicit `.js` specifiers are unresolvable to a bundler

Every import in `src/` carries an explicit `.js` extension resolving to a `.ts` file. That is mandatory under NodeNext and it is how F0–F2 were written. A bundler resolving with `moduleResolution: bundler` takes `./y.js` literally and fails — the first `next build` produced `Module not found: Can't resolve '../src/core/config/stage.js'`.

`resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] }` maps the specifier back onto the TypeScript source. It is a **webpack** resolver feature, so `dev` and `build` pass `--webpack`; Turbopack is Next 16's default and is faster, but this is a single-operator local dashboard where build time is irrelevant and resolution correctness is not.

The alternative was rewriting several hundred imports across `src/` to suit the UI, which would be the tail wagging the dog on a milestone that must keep 355 tests green.

### 4.8 `.gitignore` made the entire `docs/` directory untrackable *(latent F0 defect — the most serious one found so far)*

`.gitignore` carried a blanket `*.md` with a single `!README.md` exception, intended to keep assistant scratch notes out of the repo. It also excluded:

- `docs/architecture-plan.md` — **the implementation contract**, which every handover instructs the next session to preserve verbatim "so it stays auditable"
- `docs/F1-HANDOVER.md`, `docs/F2-HANDOVER.md`, `docs/F3-HANDOVER.md` — the entire deviation chain, 39 recorded decisions with their reasoning
- `docs/handoff-llm-gateway.md` — the LLM design spec

`git ls-files` showed only `README.md` and `handover.md` tracked, and `handover.md` survived only because it predated the rule. **Three milestones of design rationale, plus the contract they are all measured against, were one `rm -rf` from being unrecoverable** — and no session could have committed them even deliberately.

Fixed by adding `!handover.md` and `!docs/**/*.md`. Root-level scratch `.md` files are still ignored, which was the original intent.

**Generalise this: an invariant that depends on a file existing should have something that checks the file is tracked.** F0 verified that migrations apply and that secrets never reach a log; nothing verified that the documents describing why any of it works were in the repository.

### 4.9 `recordSpend` never charged the global research envelope *(latent F2 defect)*

`checkBudget` reads the global envelope — the `ResearchBudget` row with a null `companyId` — on every call. `recordSpend` only ever incremented the row matching the caller's `companyId`. The two disagreed silently: after F2's live backfill the 150 per-company rows summed to **1,015 credits spent** while the global row still read **0 of 1,000**.

The global ceiling was being enforced against a counter nothing incremented, so it could never be reached. A12 exists to make spend *"visible and bounded rather than discovered on an invoice"*; a cap that cannot be hit does neither.

A company-scoped spend now charges **both** rows; a spend with no company charges the global row once, not twice. The query uses an explicit `OR` rather than `in: [companyId, null]`, because SQL `IN (NULL)` never matches and the shorter spelling would have reintroduced the identical bug.

`recordSpend` still does **not** create a missing row. F1 §4.2 established that a budget created lazily on first spend does not bound the first spend; seeding happens at ingestion, and that reasoning is unchanged.

**The 1,015 historical credits were deliberately not backfilled onto the global row.** Doing so would put September 2026 at 1,015/1,000 and refuse all further research for the month — for work that cost nothing. It is an open question for the user (§10.2).

### 4.10 The research-credit unit is now split free from paid

F2 §4.7 asked F3 to split the accounting. `ResearchBudget.vendorCreditsSpent` counts the subset of `creditsSpent` that consumed a **paid** vendor allowance (Firecrawl), and `GateContext.vendorCost` carries it from the call site; the Firecrawl escalation is the only caller that sets it.

It is deliberately **not** a second cap. Part G's proving test is *"cap zero → all research no-ops with `budget_exhausted`"*, and that only holds because the free tier is metered by the same counter the cap reads. One ceiling, two counters.

### 4.11 An accepted packet is immutable, and `packetHash` is A7 rehearsed a milestone early

The F3 handover asked that the approved artefact stay immutable so F4 can hash an equivalent structure without redesigning the table. `packetHash` is A7's field list translated:

| A7 (a `Draft`) | here (a packet) |
|---|---|
| `subject`, `body_text` | `prefilledAnswers` — the text the human read |
| `recipient_email_normalized` | `officialUrl` — the route the artefact is for |
| `resume_version_id` | same |
| `attachment_sha256[]` | `resumeSha256` — the **file**, not just its row id |
| `cited_evidence_ids[]` | same, sorted |
| `sender_identity` | (none: F3 sends nothing) |
| `prompt_version` | same |

Two details that are the whole point:

- **The resume's file hash, not only its row id.** A7 hashes `attachment_sha256[]` for exactly this reason: the operator edits their resume in place, so a row id is stable across a document that changed. An approval must not survive that. `seedResumeVersions` recomputes the hash on every run.
- **Citation arrays are sorted; answers are not.** Citation arrays are sets whose order carries no meaning, and a re-derivation could reorder them, breaking a comparison that should have passed. Answer order is display order, which the human saw, so it is part of what they approved. **Blank questions are hashed too** — approving a packet with "expected graduation" unanswered is not the same act as approving one where it has since been filled in.

The hash is computed on every regeneration but **frozen only at accept**. Until then it is a fingerprint of the current draft, not a record of an approval. Once accepted, `generateApplicationPackets` and `applyPacketAnswers` both refuse to touch the packet.

### 4.12 Accept / defer / reject are `Lead` states; the packet's own status is the application outcome

`ApplicationPacketStatus` is `prepared | submitted | acknowledged | interview | rejected | no_response` — those are **post-submission outcomes**, and `rejected` there means *the employer rejected the application*. Conflating that with *the operator declined to apply* would make two very different facts share a value.

So `LeadStatus` gained `accepted` and `deferred` (migration `20260910000000_f3_application_funnel`). The scorer decides whether a lead is `qualified`; the human decides whether to act on it. F4's outreach predicate has to tell those apart.

`deferred` carries `insufficient_evidence`, which D1 defines as re-entrant and a budget decision rather than a verdict — which is exactly what deferring means: not now, still eligible, come back with more research.

### 4.13 `markPacketSubmitted` requires an accepted packet

`application_submitted` is recorded against the **lead**, because that is where F4's predicate looks, and the lead stays `accepted` — applying is not a rejection, and the follow-up Part C case 3 permits is only available while the lead is live.

The transition requires `acceptedAt` to be set first. `packetHash` is a claim about what the human approved; a submission with no approval behind it would make that claim vacuous. The audit row records `submittedBy: 'human, through the employer's own application form'` — stated in the record rather than only in a comment, because H8 is the one decision in Part H marked irreversible.

### 4.14 A queue a later milestone fills renders as "not built", never as `0`

`handover.md` §9 names twelve queues; F3 can populate five of them plus its own four. The rest belong to F4 and F5.

Rendering those as `0` would be the failure B3 warns about — *"Do not build a reputation chart that renders empty and implies health."* A zero beside "Bounced" reads as *"nothing has bounced"*. Each queue carries the milestone that fills it and an `available` flag; `count` is `null`, never `0`, when unavailable.

The same reasoning put `contactRoute: null` on the packet row as an explicit field rather than an omission: §9 requires every queue row to expose *"why this contact was selected"*, and at F3 the honest answer is "no contact exists, and F4 is the first milestone permitted to create one". A missing panel is something a reviewer has to notice; a stated absence is not.

### 4.15 The evidence viewer has no field a UI could use to rank one tier over another

`handover.md` §16 requires browser- and API-derived facts to display identically. `projectEvidence` returns one type with every field always present, and the **only** value that varies with `fetchedVia` is a display label from a table that is total over the union — so a new tier cannot render as a blank.

There is deliberately no `isTrusted`, no `tierRank`, no `warning`, no `reliability`. A test asserts those keys are absent. The moment such a field exists someone renders it, and a reviewer starts discounting an escalated fact whose excerpt is just as verbatim as a feed's — or, worse, over-trusting a feed-derived one because it looks more official. Provenance is the excerpt and the URL, not the pipe the bytes came down.

`fetchedVia` itself is still returned and shown. Hiding it would be the opposite error: D4 wants an auditor to see which tier produced a row. The requirement is that the viewer treat the tiers alike, not that it conceal them.

---

## 5. F3 as built — the map

New in F3 (everything F0, F1 and F2 built is unchanged and listed in their handovers' §5):

```
prisma/migrations/
  20260910000000_f3_application_funnel/    lead_status += accepted/deferred; approved_claim
                                           key + source_ref; application_packet lead_id,
                                           approved_claim_ids, packet_hash, accepted_at,
                                           unique(opportunity_id, resume_version_id);
                                           llm_task.allowed_approved_claim_ids
  20260910000100_research_budget_vendor_split/   research_budget.vendor_credits_spent (§4.10)
src/core/policy/
  budget.ts                    MODIFIED: §4.9 — recordSpend charges every envelope
  fetch-policy-gate.ts         MODIFIED: GateContext.vendorCost
src/core/llm/
  tasks.ts                     MODIFIED: packet_answers kind; collectCitedApprovedClaimIds
  handoff-gateway.ts           MODIFIED: allowedApprovedClaimIds + uncited_claim (§4.1)
src/core/config/stage.ts       MODIFIED: MILESTONE_STAGE = 'F3'
src/apply/
  claims/claims-data.ts        53 ApprovedClaims, each with sourceRef (§4.1)
  claims/seed-claims.ts        idempotent on key; withdrawn claims deactivate, never delete
  resumes/resumes-data.ts      5 ResumeVersions and the track mapping
  resumes/seed-resumes.ts      sha256 per file; wires RoleTrack.defaultResumeVersionId
  packet/questions.ts          12 questions, deterministic vs judgment
  packet/answers.ts            PrefilledAnswers schema + the ApprovedClaim-only choke point
  packet/select.ts             eligibility, ranking (§4.4), per-company cap, capped-out audit
  packet/hash.ts               packetHash over A7's field shape (§4.11)
  packet/generate.ts           packet generation; idempotent; accepted packets immutable
  packet/queue-answers.ts      the packet_answers LlmTask
  packet/apply-answers.ts      merges a fulfilled task; re-validates against live claims
  packet/lifecycle.ts          accept / defer / reject / markSubmitted / recordOutcome
  brief/persist-brief.ts       fulfilled research_brief -> ResearchBrief (§7)
  viewer/projection.ts         §16's identical projection + the stored score reasons
  viewer/queues.ts             §9's queues; later ones "not built", never 0 (§4.14)
app/
  layout.tsx  page.tsx         the review queue
  packets/[id]/page.tsx        packet detail: score reasons, answers, evidence viewer, history
  actions.ts                   6 server actions, all delegating to lifecycle.ts
  lib/db.ts                    `server-only`; the UI's single data source
  globals.css
next.config.mjs                §4.7 — extensionAlias, serverExternalPackages
tsconfig.backend.json          §4.5 — the no-DOM config for src/test/tools
test/
  unit/packet-selection.test.ts        18 tests: early-career, seniority, ranking, packetHash
  policy/application-packet.test.ts    21 tests: the exit criteria as red-team attempts
  integration/packet-llm.test.ts       10 tests: two-sided allow-set, merge, brief persistence
  integration/budget-envelopes.test.ts  7 tests: §4.9's regression cover
tools/
  seed-operator-data.ts        LOCAL. Resumes (hashed from disk) + approved claims
  run-packets.ts               the F3 artifact. No network. --drain, --cap, --queue-answers
  verify-f3.ts                 the eleven exit criteria, reported individually
  check-no-raw-http.ts         MODIFIED: scans app/ and .tsx (§4.6)
```

### The invariants F3 adds

Alongside every F0, F1 and F2 invariant:

**Nothing submits an application.** H8 is the one Part H decision marked irreversible. No code path posts to an ATS; a test scans every source file for submission endpoints and asserts `gate.postJson` has exactly one caller, which is the Firecrawl escalation. `markPacketSubmitted` records that a human already applied.

**An answer citing no `ApprovedClaim` cannot be constructed or stored.** `.min(1)` in the schema, plus a live re-check against active rows at write time.

**An accepted packet is immutable.** Generation and answer-merge both refuse it. `packetHash` is frozen at accept over the artefact as it stood.

**A deterministic answer is exactly the text of the claims it cites.** No rewording, which is what makes traceability checkable by containment.

**A missing fact is a blank with a reason, never a guess.** Graduation date and availability are absent from the claim set and stay absent from the answers.

**The evidence viewer cannot distinguish tiers except by label.** No ranking field exists to render.

**A queue a later milestone fills reports "not built", not `0`.**

**`npm run packets:run` touches no network.** Only three commands still do: `ingest:seed`, `fixtures:record`, and `intel:run -- --research N`.

---

## 6. The reason-code mechanism — you WILL need to touch this

`src/core/reason-codes/registry.ts` maps all 39 codes to the milestone that owns them, and two tests make Part G's coverage rule mechanical:

- `test/unit/reason-codes.test.ts` asserts registry↔Prisma-enum bijection in both directions, plus an **explicitly enumerated list** of the codes reachable at `'F3'` (and, still, at `'F2'`, `'F1'` and `'F0'` — bumping the stage adds codes, it never reclassifies one that already shipped).
- `test/policy/reason-code-coverage.test.ts` holds a `scenarios` table that drives each reachable code through its **real code path** and asserts the produced reason, then asserts `Object.keys(scenarios) === reachableReasonCodes('F3')`.

Both hardcode `'F3'` on purpose, so bumping the stage cannot silently pass.

### F4's obligation here

F4 owns **four** codes:

`executive_only_contact` · `legal_policy_mismatch` · `no_public_recruiting_route` · `outreach_not_permitted`

So F4 must:

1. Set `MILESTONE_STAGE = 'F4'` in `src/core/config/stage.ts`.
2. Add a scenario for each of the four to `test/policy/reason-code-coverage.test.ts`, driving the **real** contact-curator and outreach-predicate code — not a hand-constructed call to a helper.
3. Change the hardcoded `'F3'` references to `'F4'` and extend the expected list in `test/unit/reason-codes.test.ts`.

If you skip step 1, the coverage test still passes and the milestone is a lie. If you do step 1 without 2 and 3, the tests fail loudly — which is the intent.

`outreach_not_permitted` deserves a note. The predicate that raises it (`src/core/policy/outreach-case.ts`) was written and fully unit-tested in **F0**, and it has been sitting unreachable ever since because nothing creates a draft. It is Part G's single most important policy test — *"Posted-role lead with no application → `outreach_not_permitted`"* — and F4 is where it finally runs against a real path. Its `applicationSubmitted` input is now a real state: `Lead.statusReason === 'application_submitted'`, written by `markPacketSubmitted`.

### Ownership of all 39 codes

| Milestone | Codes |
|---|---|
| **F0** ✅ | `budget_exhausted` `host_denied` `kill_switch_account` `kill_switch_domain` `kill_switch_global` `rate_limited` `robots_disallowed` `sending_disabled` `terms_prohibited` |
| **F1** ✅ | `content_unchanged` `duplicate` `source_unavailable` |
| **F2** ✅ | `injection_detected` `insufficient_evidence` `low_relevance` `outdated_role` `weak_evidence` |
| **F3** ✅ | `application_submitted` |
| **F4** ← you | `executive_only_contact` `legal_policy_mismatch` `no_public_recruiting_route` `outreach_not_permitted` |
| **F5** | `approval_hash_mismatch` `breaker_open` `cap_exceeded` `duplicate_company` `duplicate_contact` `hard_bounce` `opt_out` `profile_incomplete` `replied` `soft_bounce` `stale_at_send` `suppressed` `user_paused` `wrong_contact` |
| **F7** | `browser_blocked` `browser_needs_user` `browser_policy_rejected` |

---

## 7. `HandoffLlmGateway` — what F3 changed

**Full spec, now with an "As built (F3)" section: `docs/handoff-llm-gateway.md`. Read it — do not re-derive it.**

Three things F3 resolved:

1. **`ResearchBrief` persistence is done.** `src/apply/brief/persist-brief.ts` drains fulfilled `research_brief` tasks, copying `citedEvidenceIds` straight from the validated output rather than re-deriving them, and is idempotent per `(companyId, promptVersion)`. `npm run packets:run -- --drain` runs it.
2. **The allow-set is two-sided** (§4.1). `allowedApprovedClaimIds` bounds candidate claims the way `allowedEvidenceIds` bounds company facts, with a `uncited_claim` failure in `fulfilTask`. An omitted or empty set means *cite none*, never *cite anything* — which is what made it safe to add to a kind that predates it.
3. **H10 held and was measured.** 37 complete packets were produced with the LLM backlog untouched — eight prefilled answers each and the judgment questions listed as unanswered with a reason. Draining upgrades a packet; it never unblocks one.

**F4 is where the citation rule stops being a convenience and becomes the Quality Gate.** The draft schema needs an `evidenceId` per personalization sentence *and* an `approvedClaimId` per candidate sentence — both mechanisms now exist and both are enforced in the same place.

19 `research_brief` tasks are still pending. Drain them with `npm run llm:next`.

---

## 8. F4 — the task

> **Plan, Part F, verbatim:** *F4 — Drafting sandbox. Contact curator (role aliases default, published University Recruiting second); `ResearchBrief`; constrained composer with per-sentence `evidenceId`; Quality Gate with versioned checks; approval flow computing `approval_hash`; three-case outreach predicate. → 30 citation-backed drafts, zero external sends; the outreach-case predicate rejects every path outside Part C.*

### 8.1 What to build

1. **Contact curator.** The first milestone permitted to create a `Contact` row, and the one `handover.md` §1's non-negotiables were written for. H2: role aliases (`careers@`, `jobs@`, `talent@`, `recruiting@`) are the default; a **publicly published** University Recruiting or Talent named contact is the second tier. **Never a founder, CEO or executive. Never an inferred address.** Every row needs `evidenceId` pointing at the public page the address was published on, with the excerpt and capture timestamp. B5 found the `careers@`-first premise unverified — record the yield gap as an open question, do not assume it.
2. **`ResearchBrief`** — the table and the writer exist (§7). F4 consumes them.
3. **Constrained composer** with a per-sentence `evidenceId` for company facts and a per-sentence `approvedClaimId` for candidate facts. Both mechanisms are built; wire the draft schema to them.
4. **Quality Gate** with versioned checks. Failed drafts return to research or are rejected with a reason code.
5. **Approval flow computing `approval_hash`** — A7's exact field list. `src/apply/packet/hash.ts` is the rehearsal; see §4.11 for the mapping and the two details that matter (hash the resume **file**, sort citation arrays but not sentence order).
6. **The three-case outreach predicate.** `src/core/policy/outreach-case.ts` has existed since F0 and is fully unit-tested; F4 wires it to real rows. Its `applicationSubmitted` input reads `Lead.statusReason === 'application_submitted'`.

### 8.2 Do NOT build in F4

No sending (F5 — and do not raise `MILESTONE_STAGE` past `F4`), no Gmail adapter, no optional adapter (F2a, each behind its own verification gate, default off), no browser layer (F7).

### 8.3 What F3 learned that changes F4

- **`ApprovedClaim` is modelled and populated.** 53 claims, 7 categories, each with a `sourceRef`. F4's drafts draw candidate facts from exactly this table and nowhere else. Do not add a parallel source.
- **`packetHash` is A7 rehearsed** (§4.11). Reuse the shape; the two non-obvious decisions are already made and tested.
- **`application_submitted` is a real state transition**, on the lead, written with an audit row. Part C case 3 reads it.
- **The resume `linkUrl` values are `file://` paths and F4 must replace them.** H3 ("link on first contact, attach after reply") is a *deliverability* rule about email, which F3 does not send — an ATS upload is a local file. The moment a draft exists, a `file://` link in an email body is useless to the recipient. Ask the operator to host the four PDFs and re-run `npm run seed:operator` with real URLs.
- **The `ios_android` track has two resumes** (iOS default, Android second). The seam for switching per draft exists but no UI selects it yet.
- **`npm run typecheck` runs two configs now** (§4.5). Both must pass.
- **Store the posting body if you need better per-posting track assignment.** Still unfixed, still the cheapest lever: F1 stores a posting's title, location and URL but not the `content` Greenhouse already returns. **73 of 815 postings carry a `roleTrackId`, and 0 of the corpus's 19 early-career postings do** — including one, Eight Sleep's "AI/ML Research Internship", that is exactly on target and missed only because F2 §4.13 marks `ai`/`ml` as generic terms. That is an F1-owned change: do it deliberately, with a migration, and note that F2 §4.1's per-key `Evidence` rule applies to the body.
- **A verifier for a shipped milestone must keep passing at later stages** (F2 §4.9). `verify-f3.ts` uses `isAtOrAfter` and counts packets as *generated*, never as *still prepared* — because the operator accepting and submitting them is the milestone working.

### 8.4 The corpus question, now unavoidable

F2 raised it, F3 confirms it reaches the payload: **of 37 application packets, 34 are USA, 3 are United Kingdom, and 0 are India.** India is priority #1.

The cause is entirely upstream. The corpus is 150 companies from the yc-oss `hiring` feed at `--limit 150`: 123 USA, 6 India — and none of the 6 has a detected ATS board with tracked postings. The scorer gives India the full geography component and gave the one Indian company that cleared the bar a top-band score. **The ranking works; the input is thin, and no change to scoring or selection can fix it.**

The three options from F2 §8.4 are unchanged, and one of them should now be taken:

1. **Ingest more of the feed.** `npm run ingest:seed -- --feed all --limit 600` — ~90 minutes unattended, resumable, ~6 companies/minute. Cheapest, and it widens the internship supply as well as the India supply.
2. **Enable an India-specific optional adapter** — Adzuna or data.gov.in (F2a, B7). Each needs its own verification gate, fixtures and host allow entry first.
3. **Accept that India converts more slowly**, which is what B7 told us to expect.

### 8.5 F4 exit criteria

| Criterion | How to demonstrate |
|---|---|
| 30 citation-backed drafts | Count in `outreach_dev` after a real run |
| Zero external sends | `resolveSendingEnabled()` false; no Gmail adapter exists |
| Every personalization sentence cites evidence | A test that a sentence with no `evidenceId` is refused |
| Every candidate sentence cites an `ApprovedClaim` | Same mechanism, candidate side (§4.1) |
| No founder/CEO/executive contact can be created | A policy test per contact type |
| No inferred email address can be created | A policy test: a `Contact` without an `evidenceId` is impossible |
| The outreach predicate rejects every path outside Part C | Part G's most important policy test: posted-role lead with no application → `outreach_not_permitted` |
| `approval_hash` is frozen and compared byte-for-byte | A test that editing any hashed field after approval invalidates it |
| All F0/F1/F2/F3 invariants intact | `npm test`, `verify:f0`–`verify:f3` all green |
| Milestone bumped honestly | `MILESTONE_STAGE = 'F4'`, all four F4 codes reachable through real paths |

Add a `verify:f4` script alongside the other four, following the same shape, with `isAtOrAfter`.

---

## 9. What F4 must hand to F5

Write `docs/F5-HANDOVER.md` at the end of the F4 session, following this file's structure:

1. **§0 read-first list** — add `docs/F4-HANDOVER.md`. Never edit `docs/architecture-plan.md`.
2. **§2 status** — F4 exit criteria with real numbers (how many drafts, how many contacts, how many the operator approved), plus `npm test` and every `verify:*` output.
3. **§3 environment** — any new pins and *why not `latest`*, in the same table shape.
4. **§4 deviations** — every decision where the plan was ambiguous or wrong, with reasoning. **This section is the most valuable one; do not compress it.** Include latent defects in earlier milestones that F4 was the first to exercise — F1 found three in F0, F2 found two in F1, F3 found three (one of them in `.gitignore`), and the pattern will continue.
5. **§5 map** — new modules and the invariants they add.
6. **§6 reason codes** — F5 owns fourteen. Spell out the same three-step obligation.
7. **§7 `HandoffLlmGateway`** — update `docs/handoff-llm-gateway.md` if F4's use resolves anything, particularly around the draft-composition task kind and the Quality Gate.
8. **§8 the F5 task** — from Part F, plus what F4 learned that changes it.

### F5 preview, so F4 can prepare the ground

Part F: SPF + DKIM (+ DMARC `p=none`), test inbox, Gmail adapter on `gmail.modify` with deterministic `Message-ID` derivation and `rfc822msgid:` reconciliation (A9), bounce/reply ingestion with hardness classification, first-party deliverability counters, caps and breaker, resume **linked not attached** (B5/H3). → Verified sends to owned inboxes only.

Things F4 can get right for F5:

- **`approval_hash` must be frozen at approval, not recomputed at send.** A7 is explicit that recomputing from live data "always matches and proves nothing".
- **D3's two partial unique indexes are already in the database** and are the thing `db push` would drop. F5 relies on them for A2.
- **`SendAttempt` is written before the provider call**, never after (A9).
- **The resume must be a real hosted URL by then** (§8.3).

---

## 10. Open questions for the user

Carry these forward until answered.

1. **India coverage: 0 of 37 packets** (§8.4). Still the highest-value open question in the project, and now visible in the payload rather than only in the scores. It is a corpus decision, not a code decision.
2. **New: backfill the 1,015 historical research credits onto the global envelope?** §4.9 fixed the charging bug going forward but did not rewrite history. The global row reads 0/1,000 while the per-company rows sum to 1,015. Backfilling is the accurate record, but it would immediately refuse all further research for September 2026 — for work that cost nothing, since none of it was Firecrawl. Options: backfill and raise the cap, backfill `vendorCreditsSpent` only (it is genuinely 0), or leave the gap documented.
3. ~~Two operator facts missing~~ — **closed.** Expected graduation **March 2028**; internship window **December 2026 – January 2027, or June – August 2027**. Both are `ApprovedClaim` rows with `sourceRef: 'operator'`, and all ten deterministic questions now answer on every packet.
4. **New: resume URLs are `file://` paths.** Fine for F3, where the operator uploads a PDF into an ATS by hand. **F4 must have real hosted URLs before composing any draft** (§8.3).
5. **Firecrawl student credits — still unclaimed, and still the only untested path in F2.** Built, flag-gated, budget-charged and fixture-tested, but it has never spoken to the live API. When the key lands: set `FIRECRAWL_API_KEY`, run `npm run intel:run -- --research 5` against companies whose pages came back unusable, and record the result. `vendorCreditsSpent` now exists to measure what it costs.
6. **Git — F0–F2 are three commits on `main`; all of F3 is uncommitted, and `docs/` has never been committable at all** until §4.8's fix. The user commits on their own schedule.
7. **Two duplicate `company_page` `Evidence` rows exist per page researched before F2 §4.1 landed.** Both are verbatim and harmless; cleanup is a one-line delete if the noise ever matters.
8. **New: 15 of 37 packets are senior/staff titles** (§4.4) and **0 are internships** (§8.3). Both are corpus symptoms. Widening the feed (option 1 in §8.4) is the single action that addresses India coverage, internship supply and seniority spread at once.
9. ~~`ResearchBrief` persistence~~ — **closed.** Built in F3 (§7).
10. ~~The research-credit unit conflates free and paid~~ — **closed.** Split in F3 (§4.10).
