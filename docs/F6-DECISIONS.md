# F6 — operator decisions and measured state

Written 2026-10-04 by the F6 orchestrator, after verifying `F6-ORCHESTRATOR-HANDOVER.md`
against the code and `outreach_dev`. For the **implementer**.

**Precedence.** `F6-HANDOVER.md` is still the design brief and its §4 deviations still
bind. Where this file and that one disagree on a *number* or a *decision*, this file
wins: every state figure in `F6-HANDOVER.md` is three weeks stale, and the four
decisions in §3 below were taken by the operator today.

---

## 1. Measured state, 2026-10-04

```
companies          3,085
qualified          154 companies / 249 lead rows   (lead.score >= 70)
contacts           126
  verified=true     17   careers_alias 14 · talent_alias 3, all page_published,
                         all 17 at qualified companies
  verified=false   109   lookup_provider, imported by contacts:import
drafts               4   1 approved (info@nanonets.com, stale file:// link) · 3 gate_failed
send_attempts        0
MILESTONE_STAGE    'F5'      SENDING_ENABLED / SEND_EXTERNAL_RECIPIENTS_ENABLED false
CI                 green on main (run 37148054922, commit aa45a34)
```

The 109 unverified contacts, by the provider verdict carried in each row's Evidence:

| provider | `valid` | `accept_all` | blank | total |
|---|---|---|---|---|
| hunter  | 17 | – | – | 17 |
| snov    | 20 | – | – | 20 |
| salesql | 39 | 6 | 27 | 72 |
| **all** | **76** | 6 | 27 | 109 |

`intel:run` re-scoring, which `F6-HANDOVER.md` §8.4 calls the cheapest high-value
action, has been done repeatedly since. Do not re-run it as an F6 task.

---

## 2. Corrections to the orchestrator brief

Recorded because each one changes what gets built.

1. **"Hunter and Snov returned `valid` for every imported row" is false.** Two thirds of
   the rows are from SalesQL, and 33 of those carry `accept_all` or no verdict at all.
   Provider-attested verification yields **76**, not 109.
2. **"`contacts:import` threw away `email_status`" is half true.** The importer never
   parses the column, but `import.ts` stores the operator's CSV line verbatim as the
   Evidence excerpt, and the verdict is the last field of that line. The backfill
   reads data already in the database: no CSV and no re-import needed.
3. **The missing `List-Unsubscribe` header is not a defect.** The architecture plan's H6
   reserves RFC 8058's header for bulk volume, which this system never reaches, and
   `src/outreach/draft/templates.ts` says so in a comment. The orchestrator brief's
   "deliverability problem" framing was wrong. See §3.2 for what the operator decided.
4. **The CI fix is committed and green.** No action needed.

---

## 3. The four decisions

### 3.1 Contact verification: provider `valid` verdicts become `verified = true`, SalesQL included

The operator chose to verify every row whose provider returned `valid`, SalesQL
included. That choice rests on the SalesQL rows coming from SalesQL's own search
database, **not** from browsing LinkedIn with its extension. Record that basis in the
F7 handover's deviations. It is the provenance claim the decision depends on.

What to build:

- **A one-shot backfill**, dry-run by default. For every `Contact` with
  `discovery_method = lookup_provider` and `verified = false`, parse its Evidence
  excerpt **with the project's own CSV parser** (`src/ingest/file/csv.ts`) against the
  import header plus `email_status`. Do not use `split(',')`: the `notes` field can
  contain quoted commas. Set `verified = true` **only** when the field is exactly
  `valid`. `accept_all`, blank and anything else stay false. `accept_all` means the
  domain accepts every address, which is no verdict at all.
- **No second Evidence row.** The existing one already holds the verdict verbatim, with
  its `operator-entry://<provider>/<operator>` source. Write one `audit_log` row per
  flip, naming the contact, the evidence id and the verbatim token.
- **The importer parses `email_status` from now on**, with the same exact-match rule, as
  an optional column, so a future import cannot regress this. Update the module comments
  in `src/outreach/contacts/import.ts` and `src/core/policy/outreach-case.ts` that say an
  imported row is never verified. Those comments become false.
- **Expected flips: 76** (hunter 17, snov 20, salesql 39). Print the dry-run counts by
  provider and stop for the operator before writing. If the measured count differs,
  explain why before going further. Every prediction in this project has been off.
- Hunter and Snov verdicts were cached around 2026-09-16, so they are three weeks old.
  SMTP verdicts decay, and pilot week one's bounce counts by provider measure exactly
  that. Keep the provider visible in every pilot report.

**The sendable population this produces, measured:** 36 qualified companies.

```
alias-only companies      15
named-only companies      19
both                       2   <- slots.ts TIER_ORDER puts aliases first, and both
                                  are under 100 people, so the alias wins there
first touches ≈ 17 alias + 19 named, plus any second slot at companies >= 100 people
```

**This is not 50 companies, and nothing in F6 should try to make it 50.** 36 is the
ceiling with the contacts that exist. The split is a natural two-arm comparison
(named human vs `careers@`) that B5 flagged as unmeasured. Report replies per arm.

### 3.2 Opt-out: no header, and no decline sentence. The mail should read as hand-written

The operator's words: *"I want our mails to look like human, as if I took time sending
those."*

- **No `List-Unsubscribe` header.** Consistent with H6 (see §2.3).
- **Remove the decline sentence from the sign-off.** `signoff.plain@1` renders
  *"If you'd rather I didn't write again, say so and I won't."* Add `signoff.plain@2`
  without that line and compose new drafts with it. **Keep `@1` registered**, so stored
  compositions that reference it still resolve and their approval hashes still
  recompute.
- **The opt-out mechanism is the reply.** Someone who answers "stop" or "not interested"
  is classified `opt_out` by the existing deterministic classifier (recall over
  precision, F6-HANDOVER §4.6), and suppressed. The design itself bounds exposure: one
  message per person from the system (§3.3), then nothing.
- **Record this as a deviation** from B4's voluntarily adopted decline line **and from
  H6**, which rejects the one-click header but says to "use a plain human opt-out line". The
  reasoning: one message per person, a reply classifier that suppresses, and the
  operator's call. The orchestrator raised it once and the operator decided.


### 3.3 Scope: the system sends the first message only. The operator does the rest by hand

The operator's words: *"Replies can be my own. I just need help sending the first
icebreaker mail, that's it."* They have Gmail notifications on their phone and will
handle every reply, and any follow-up, themselves from the thread.

So two of F6-HANDOVER §8.1's five items are **dropped**:

- **No automated follow-up.** Do not schedule anything on `QUEUES.followUp`. Each
  person receives exactly one message from the system. If the operator wants a
  follow-up, they write it by hand in the Gmail thread.
- **No LLM reply draft.** The operator writes their own replies.

Record both as deviations from Part F ("one follow-up at 7–10 business days") in the F7
handover. The orchestrator raised once that a single follow-up commonly brings in a
real share of cold-email replies. The operator can still send one by hand, and decided.

**What stays: inbox ingestion, for measurement and safety, not for replying.** Bounces
arrive as mailer-daemon messages and the operator will not log them by hand. The ramp in
§3.4 reads hard bounces and opt-outs, and suppression depends on them being ingested.
So `send:run` runs the existing inbox ingestion **before** it sends. If ingestion
cannot run (auth expired, API error), refuse the batch rather than send on stale counts.
The `findByMessageId` rule applies (F6-HANDOVER §4.14): a check that could not look
must never report that it looked and found nothing.

This also covers the one remaining in-thread risk: a company with two slots. If the
first contact there has replied, ingestion marks the lead before the second contact's
message goes out, and the existing gate's `replied` condition stops it.

### 3.4 Caps: the plan's ramp, signal-gated, ceiling 20

`capsForStage` keeps F6 week one at 5/day and 3/domain. The ramp is 5 → 10 → 20 on Part
G's first-party signals and never on a calendar:

- **1 → 2:** zero hard bounces, zero opt-outs, zero wrong-contact reports.
- **2 → 3:** hard-bounce rate 0%, at least one positive reply or acknowledgement, no
  manual pause.

The operator's earlier "ramp to 50" is **not** built. With ~36 sendable companies, the
caps barely bind this pilot (about 7 sending days at 5/day). Revisit only when contact
supply exceeds what 20/day consumes.

---

## 4. Build order

Each step lands green before the next starts: `npm test`, both typecheck configs, lint.

1. **Verification backfill and importer change** (§3.1). Dry run, operator confirms,
   write, re-measure: verified count, and qualified companies with a sendable contact
   (expect 36).
2. **Sign-off `@2`** (§3.2) and the golden or hash tests that pin the sign-off.
3. **Re-compose the four existing drafts.** Do not re-approve them (F6-HANDOVER §4.4).
   Then compose drafts for the newly sendable companies. Every one still needs
   individual human approval, and there is still no bulk form.
4. **Ingestion before every send batch** (§3.3). Test it against the fake: an ingested
   hard bounce counts before the cap is read, and a failed ingestion refuses the batch.
5. **The signal-gated ramp** (§3.4), read from the existing first-party counters.
6. **The dashboard send queues** (F6-HANDOVER §8.1 item 4).
7. **`tools/verify-f6.ts`**: floors and `isAtOrAfter` only, no ceilings (F6-HANDOVER §4.9).
8. **The pilot switch, last, as its own reviewed commit:** `MILESTONE_STAGE = 'F6'`, plus
   the `'F5'` → `'F6'` reason-code test references (F6-HANDOVER §6). The operator sets
   both env flags themselves, after reviewing that commit.

---

## 5. How to read the pilot (agreed before any number exists)

With n ≈ 36 first touches, **zero replies is statistically consistent with a true reply
rate anywhere up to ~8%** (the rule of three: 3/n). The pilot therefore cannot tell
0.1% from 1%; that takes several hundred sends. Say so in every report rather than
quoting a rate.

What the pilot does decide:

- **Deliverability of provider-`valid` addresses**: hard and soft bounces per provider
  (hunter / snov / salesql) and per arm (named / alias).
- **Whether the machinery holds**: no double sends, every bounce ingested and suppressed,
  no second-slot message after a reply at the same company.
- **Whether the email is clearly working**: 2 or more genuine replies out of ~36 would be
  real signal. Zero or one is "not yet known", not "failed".

If replies come in near the spray baseline, the response is to fix the email, not to
widen the corpus.

Report every figure as measured counts with a floor and a ceiling. Never report a single
rate.

---

## 6. Operator pre-flight (code cannot do these)

- **Switch the Gmail OAuth app from Testing to In production.** Refresh tokens expire
  after 7 days in Testing, which would kill auth mid-pilot.
- **Run `npm run send:test -- --to <owned address on a non-Gmail provider>`** to see
  `Authentication-Results` (SPF/DKIM). F6-HANDOVER §8.2 lists this as a rollout
  criterion, and a same-account send cannot show it (§2.3).
- **Set both env flags only after reviewing the stage commit.**

---

## 7. Not F6

Corpus widening, board detection on the remaining 674, the HN "Who is hiring" source,
the Tier B provider seam, score-weight changes (A11, until ≥100 sends), a bulk approval
form, and the browser layer.

One note for after the pilot: Hunter and Snov's free quotas were spent on hand-picked
mobile companies: only 5 of Hunter's 12 companies and 3 of Snov's 13 qualify. Future free-tier lookups
should target the 154 qualified companies. That is F7-or-later work, not F6.

---

## 8. Progress log: read this first in a fresh chat

### Step 1 — DONE, commit `88d6e3f` (2026-10-04)

Measured after `--write`: 75 contacts flipped (hunter 17, snov 19, salesql 39), 1 retired
(the Rapido talent-acquisition contact, caught by the widened "Head" rule), 92 verified in
total. **33 sendable qualified companies**, not 36: 15 alias-only, 16 named-only, 2 both.
`jurisdiction.ts` refuses 8 lookup-provider contacts at Germany 5, Finland 2 and UK 1
companies, because no UK/EU review is recorded. **The operator decided to accept 33 and
not record a review.** `verify:f4` criterion 4 now asserts no executive is *targetable*.
619 tests green. Deviations are drafted in `docs/F7-HANDOVER.md` §4.1–§4.4 and §10.

**Do not put a real contact's name or address in any committed file.** The repo is
public. Use invented addresses in tests and descriptions ("the Rapido contact") in docs.

### Decisions already taken for the remaining steps

The operator approved these in the step-1 chat. Do not re-ask.

**Step 3, re-composing.** Add a single-draft "revoke approval" command: by `--id`,
audited, moving approved → composing only, never forward, no bulk path. It exists for
the one approved draft, `compose.ts` skips anything with `approvedAt` set. The 3
`gate_failed` drafts were never approved and re-compose in place. They still need their
sentences written through the LLM gateway and must pass the Quality Gate. **The
approval view must show the contact's title prominently,** so the operator can skip
non-recruiter, non-engineer rows (some verified SalesQL rows are, for example, an IT
Asset Manager). Directors are deliberately not excluded.

**Step 4, ingestion, plus four defects found in the step-1 chat. Fix all of them in this
step:**

1. *Double counting.* `Bounce` and `OptOut` have no provider-message-id uniqueness
   (`Reply` does). With a 7-day read window running before every batch, one real bounce
   becomes several rows, trips the breaker's absolute limit of 3, and corrupts the
   counters. Add a unique `provider_message_id` to both. Generate the migration with
   `prisma migrate diff --script`, read the SQL, then `migrate deploy`. **Never db push.**
   Both tables currently have 0 rows. Pin it with a test: the same bounce ingested 3 times
   gives 1 row, and the breaker is not tripped.
2. *Truncated listing.* `tools/run-inbox.ts:85` calls `listInbox(query, 50)` with no
   pagination. Restrict the query to threads we sent plus mailer-daemon/postmaster,
   paginate, and **refuse the send batch if the listing was cut off.** A check that
   could not look must not report "nothing found".
3. *Counters cannot express the ramp.* There is no wrong-contact count, and `replies`
   includes auto-replies and opt-outs. Break counts down by reply classification. No
   migration needed.
4. *Dead matching routes.* In `matchSendAttempt` (`src/outreach/send/ingest-outcomes.ts`),
   both the `In-Reply-To` route and the body-scan fallback look for our `<oi.…>`
   Message-ID, which Gmail rewrites (F6-HANDOVER §2.3). Only thread matching works
   today. Make the body scan match the `X-Outreach-Ref` value, and if it is cheap, store
   Gmail's rewritten Message-ID after the send so `In-Reply-To` can match it. Record
   whichever you do.

Then `send:run` runs ingestion before every batch, as §3.3 says.

**Step 8, the stage commit.** `test/policy/owned-inbox.test.ts`'s test "the build we ship
cannot reach an external recipient by config alone" reads `MILESTONE_STAGE` and will fail
at F6. Rewrite it in the same commit to the property that survives (both factors are still
required), in the F6-HANDOVER §4.9 shape.

### Step 2 — DONE (2026-10-04)

`signoff.plain@2` renders only the operator's name. `@1` stays registered and its text is
pinned, because the Quality Gate and `verify:f4` re-validate stored compositions against
the registry. (The approval hash covers stored sentence text plus the template id, not a
fresh rendering.) New drafts use `@2`. Three new tests: exact text of both versions, a
new draft carries `@2` with no decline line, and an approved `@1` draft still validates
and its hash still matches. The deviation is in F7-HANDOVER §4.5 (B4 and H6). 622 tests
green, `verify:f4` 13/13.

### Remaining, in order

3 re-compose and revoke → 4 ingestion and the fixes above → 5
signal-gated ramp → 6 dashboard send queues → 7 `verify-f6` → 8 stage commit. The operator
chose to build all of them, step by step. Stop after each step for an orchestrator
checkpoint. **Do not commit.** The operator commits.
