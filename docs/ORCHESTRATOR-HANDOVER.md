# Orchestrator handover

Paste the block at the end of this file into a fresh chat to continue as orchestrator. Everything above it is the reasoning behind that block, kept for when a decision needs to be revisited rather than rediscovered.

Written 2026-09-11, after F4 completed and during the 2,000-company ingest run.

---

## 1. What the operator is actually building

A cold outreach machine for internship hunting. Find companies, find people who work there, write a personalized email citing something real about the company, attach or link the resume matching that role, and ask whether they take interns.

The operator's own reference points, given as screenshots: one person sent 1,150 applications in 24 hours and got 1 rejection and 1,149 silences. Another scraped ~2,000 HR emails, personalized each, and got 2 interviews. **The measured reply rate for volume spray is 0.1%.** That number sets the strategy: the system needs contacts in the thousands, not the dozens.

The bet worth making is that evidence-cited personalization beats template spray. If per-company citation moves 0.1% to 0.5%, 400 contacts do the work of 2,000.

The architecture plan the project was built against is application-first — it treats cold email as a narrow exception and applying as the main road. **The operator has since overridden that.** Cold outreach is the primary path. The application funnel stays because Part C case 3 (emailing after you applied) converts better than pure cold, not because applying is the goal.

## 2. Your role

Orchestrator, not implementer. The operator runs **one milestone per chat** for context efficiency. Your job in the orchestrator chat is to:

- Decide what happens next and in what order
- Answer the AskUserQuestion screens the milestone chats surface, with a recommendation and the reasoning
- Verify claims against the code and the live database rather than accepting a milestone chat's summary
- Write the paste block that starts the next milestone chat
- Do small contained fixes yourself when a milestone chat is blocked or has already shipped

Do not implement a milestone in the orchestrator chat. Do verify one.

Verification has repeatedly mattered. Three examples, all caught by querying rather than reading a report:

- F2 reported "21 queue-band leads is short of Part F's 30 packets." Wrong unit — packets are per opportunity, and 73 tracked opportunities sat inside those 21 leads. No shortfall existed.
- `checkBudget` read a global counter that `recordSpend` never incremented for company-scoped work. The database showed global spent 0 against 1,015 actually spent. The ceiling was unenforceable.
- `Main resume.pdf` was wired to the `swe` track but is an iOS-flavoured document. 16 application packets were handing an iOS resume to generalist roles.

## 3. Non-negotiables, as amended by the operator

The original five, from `handover.md` §1:

1. Never automate LinkedIn or any gated platform. Unchanged and absolute.
2. Never infer an email address; never target founders, CEOs or executives. **Amended — see below.**
3. Every network request goes through `FetchPolicyGate`, enforced by an AST scanner that fails the build.
4. Sending stays hard-disabled until F5, enforced by `MILESTONE_STAGE` in source, not only an env var.
5. Provenance on every fact. A value that cannot be traced to an `Evidence` row with a verbatim excerpt and a source URL does not belong in the database.

**Operator amendments to rule 2, made deliberately across several exchanges:**

- **Seniority tiering is gone.** Any current employee is a valid contact — SDE1, SDE2, senior, staff, tech lead, EM. Founders, CEOs, C-suite and VPs stay excluded (`handover.md:18` unchanged).
- **Verified lookup providers are permitted** (Hunter, Apollo or equivalent) behind their own provider seam, host allow entry, fixtures, and a `verified` flag on the `Contact` row.
- **Blind pattern construction stays off by default** — `CONTACT_ALLOW_PATTERN_INFERENCE=false`, operator-flippable, logged per row. The reason is deliverability, not squeamishness: guessed addresses bounce 30–40% and burn a sending domain in days.
- **A fourth outreach case exists**, `intern_availability_inquiry`, permitted when a verified contact exists at a qualified company regardless of posting or prior application. It is the operator's primary path. Cases 1–3 keep their precedence; case 4 is checked last so an existing application still produces a case-3 follow-up.

If the operator reaffirms a direction after you raise a concern, that is their decision. Say so once, then build the full thing.

## 4. What is built

F0 through F4 complete and verified. `MILESTONE_STAGE = 'F4'`. Sending disabled.

| Milestone | What it delivered |
|---|---|
| F0 | Schema, `FetchPolicyGate`, envelope-encrypted secrets, closed `ReasonCode` enum, three-layer network enforcement, pg-boss, two-factor send lock |
| F1 | yc-oss seed loader, domain canonicalization, ATS detection with slug resolution, Greenhouse/Lever/Ashby adapters |
| F2 | Scorer summing to exactly 100 with `ScoreVersion`, research pipeline, `HandoffLlmGateway` proven end to end |
| F3 | `ApplicationPacket` generation, track-tailored resume selection, `ApprovedClaim` prefills, dashboard queues, evidence viewer |
| F4 | Contact classifier, executive filter, Tier A curator, Tier B provider seam with a fake, constrained composer with per-sentence citation, Quality Gate `f4-gate-v1`, `approval_hash` per A7, jurisdiction check, fourth outreach case |

446 tests, typecheck clean, lint clean. `verify:f0` through `verify:f4` all green.

### The `HandoffLlmGateway`

The app queues `LlmTask` rows and a Claude Code session fulfils them through a schema-validating CLI. The session never fetches. Zero marginal API cost. Built in F2, proven end to end in F4 — one real draft, 2 evidence rows, 3 approved claims, gated and approved with a frozen hash.

## 5. Live state

As of the handover being written, mid-ingest:

```
companies      1,975
with a board   46 and climbing (ingest running)
opportunities  893
tracked opps   73
leads          69
contacts       4      <- the wall
packets        37
global budget  1,122 / 50,000
```

**Contacts is the bottleneck.** Four, all generic `info@`/`hello@` switchboards. F4's measured Tier A yield across 21 companies: 19 read, 4 with a usable address, **zero with a dedicated recruiting alias**. Modern startups route everything through Greenhouse/Lever and publish no address at all.

Scaled honestly: 2,000 companies at 21% is roughly 420 generic inboxes, which at 0.1–0.5% is under two replies. **Tier A cannot reach volume.** The vendor question is answered by data — buy Hunter (~$34/mo for 500 lookups). The seam is built and tested against a fake.

## 6. Operator assets

- **Domain** `aryamanj.in`, portfolio on Vercel, registrar looks like GoDaddy.
- **Resume PDFs live and verified** — all four return 200, `application/pdf`, inline, no viewer interception, no auto-download. The operator's portfolio has a PDF viewer that auto-downloads; these deliberately bypass it, because a page that auto-downloads gets flagged by mail security that pre-fetches links.

  | Track | URL |
  |---|---|
  | `swe` | `https://aryamanj.in/resume/backend.pdf` |
  | `sde` | `https://aryamanj.in/resume/backend.pdf` |
  | `ios_android` default | `https://aryamanj.in/resume/ios.pdf` |
  | `ios_android` alt | `https://aryamanj.in/resume/android.pdf` |
  | `ai_engineer` | `https://aryamanj.in/resume/ai.pdf` |

  `swe` and `sde` are two rows over one file, since `trackKey` is single-valued. They share a `fileSha256`, which A7's approval hash must tolerate.

- **Gmail OAuth** in `.env` as `GMAIL_OAUTH_CLIENT_ID` / `GMAIL_OAUTH_CLIENT_SECRET`. Desktop app client on a personal gmail, publishing status Testing, loopback flow, no registered redirect URI. Scope `gmail.modify`. Testing-mode refresh tokens expire after 7 days — once auth succeeds, the operator should set Publishing status to In production, which stops the expiry.

- **Sending identity: personal Gmail first.** Free Gmail allows ~500 recipients/day and the target is 50 — 10% of the limit. It is already DKIM-signed by Google and already warmed by years of real history, which a fresh domain spends three weeks earning. The tradeoff is perception, not deliverability. Set up Workspace on `aryamanj.in` in parallel and migrate in about three weeks once the approach is proven.

- **DNS as found:** no MX, no SPF, no DKIM, and `DMARC p=quarantine` (a GoDaddy default). Sending from `aryamanj.in` today would fail both alignment checks and be quarantined by the operator's own policy. If migrating to the domain: Workspace, Google's MX records, `v=spf1 include:_spf.google.com ~all`, the Workspace DKIM key, and DMARC relaxed to `p=none` during warmup.

- **University email was considered and rejected.** Better inbox placement in principle, but no DNS control, university AUPs almost always ban bulk automated sending, third-party OAuth is often blocked on student accounts, and the penalty is losing an account tied to coursework and transcripts. The credibility signal goes in the body instead: "i'm a B.Tech student at X, graduating March 2028."

## 7. Carry-forwards, in priority order

**1. Split the research budget counter.** No longer optional. The global envelope was 1,000 to match Firecrawl's free tier, but the same counter charges free static fetches. The 1,975-company ingest exhausted it in about an hour, and every gated fetch afterwards returned `budget_exhausted` for 50 minutes while the run kept spinning. The cap is temporarily at 50,000. `billedUsdCap` is 0 but `checkBudget` reads credits only, so the money guard is currently decorative. F3 §4.7 asked for this split; F4 did not do it. It must land before any vendor key exists.

**2. Store the Greenhouse posting body.** F1 stores a posting's title, location and URL but discards the `content` body Greenhouse already returns. Only 73 of 893 postings carry a `roleTrackId`, and zero of the corpus's early-career postings do — including an "AI/ML Research Internship" that is exactly on target. It also blocks the operator's Android-vs-iOS resume rule, which needs the job description, not the title. At ~2,000 companies this wastes most of what was just ingested. F1-owned migration over data already fetched.

**3. Buy Hunter.** Contacts are 4. The seam is built. The measured Tier A yield says a provider is required, not optional.

**4. India is 0 of 37 packets.** Genuinely upstream, and `--feed all` does not fix it — yc-oss is a US accelerator feed, so 13× the corpus still gives roughly 4% India. Only an India-specific source moves it: Adzuna or data.gov.in, as F2a, behind its own verification gate. Should be its own gated mini-milestone, never bolted into another.

## 8. What happens next

**F5 — Send readiness.** `docs/F5-HANDOVER.md` exists, written by the F4 chat, 913 lines. SPF/DKIM/DMARC, test inbox, Gmail adapter on `gmail.modify` with deterministic `Message-ID` derivation and `rfc822msgid:` reconciliation (A9), bounce and reply ingestion with hardness classification, first-party deliverability counters, caps and breaker, resume linked not attached (B5/H3). Exit: verified sends to owned inboxes only, kill switch cancels scheduled jobs, crash-mid-send reconciliation passes with no second send.

F5 needs no real contacts — it sends to the operator's own inboxes.

**F6 — Controlled pilot.** Enable sending. 5/day week one, 10/day week two, 20/day ceiling in the plan; the operator wants to ramp to 50. One follow-up at 7–10 business days, then stop.

**Decisions the operator still owes F5:** the opt-out mechanism (legally required, and reply-to-decline needs no infrastructure), who reads the inbox and how fast (a reply answered in three days is a dead lead), and the daily cap.

## 9. Reference

Read in this order when picking up a milestone:

```
handover.md                    the policy spine
docs/architecture-plan.md      the contract, never edited
docs/F5-HANDOVER.md            the current milestone's brief
docs/handoff-llm-gateway.md    how the LLM layer works
docs/ORCHESTRATOR-HANDOVER.md  this file
```

Earlier milestone handovers (`F1` through `F4`) record deviations and traps and are worth reading when a specific decision needs archaeology.

### Operational notes

- Tests run against `outreach_test`; everything else uses `outreach_dev`. They do not collide, so a long ingest and a milestone's test cycle can run at the same time.
- `prisma db push` must never be run. It reports the hand-written partial unique indexes on `send_attempt` as drift and offers to drop them.
- The ingest is resumable and now isolates per-company failures, but it re-fetches every company whose detection previously failed, so a restart costs a full pass.
- Milestone verifiers use `isAtOrAfter` and must keep passing at later stages. A verifier that asserts on a lifecycle state a later milestone advances will fail by construction — this happened to `verify-f1.ts`.

---

## The paste block

```
You are the orchestrator for a local internship outreach system at
/Users/aryamanjaiswal/Documents/ChatGPT/scraper.

Read docs/ORCHESTRATOR-HANDOVER.md first — it has the full context. Then
handover.md and docs/architecture-plan.md as needed.

WHAT I AM BUILDING
A cold outreach machine. Find companies, find people who work there, write a
personalized email citing something real about the company, link the resume
matching that role, ask if they take interns. Measured reply rate for volume
spray is 0.1%, so I need contacts in the thousands. The bet is that
evidence-cited personalization beats template spray.

The architecture plan is application-first. I have overridden that — cold email
is the primary path. Applying stays because emailing after applying converts
better, not because applying is the goal.

YOUR ROLE
Orchestrator, not implementer. I run one milestone per chat. You decide what
happens next, answer the AskUserQuestion screens those chats surface with a
recommendation and reasoning, verify their claims against the code and the live
database rather than trusting their summaries, and write the paste block that
starts the next chat. Small contained fixes you do yourself. Milestones you do
not.

Verifying has mattered repeatedly — a milestone reported a packet shortfall that
did not exist because it counted the wrong unit, a budget ceiling was
unenforceable because the counter it read was never incremented, and 16 packets
were handing an iOS resume to generalist roles. All three were found by querying,
not by reading a report.

STATE
F0-F4 complete and verified. MILESTONE_STAGE='F4'. Sending disabled. 446 tests,
typecheck and lint clean, verify:f0 through verify:f4 green. Everything is
committed.

Contacts is the bottleneck: 4, all generic info@ switchboards. F4's measured
Tier A yield was 4 usable addresses from 19 companies read, zero dedicated
recruiting aliases. A verified lookup provider is required, not optional. The
seam is built and tested against a fake.

NEXT
F5 — send readiness. docs/F5-HANDOVER.md is written. It needs no real contacts;
it sends to my own inboxes. Then F6, the controlled pilot.

Carry-forwards in priority order: split the research budget counter (a free
static fetch and a paid vendor credit currently share one counter, which
exhausted the global envelope mid-ingest); store the Greenhouse posting body
(discarded today, which is why only 73 of 893 postings carry a role track and why
the Android-vs-iOS resume rule cannot work); buy Hunter; India is 0 of 37 packets
and needs its own gated mini-milestone, never bolted into another.

Be direct. Correct me when I am wrong about my own system. When I reaffirm a
direction after you have raised a concern, say so once and then build the full
thing.
```
