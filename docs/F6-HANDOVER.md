# F6 Handover — The Controlled Pilot

**Written:** 2026-09-11, at the end of the F5 session.
**For:** the next implementation session, which builds F6 and nothing else.
**Status of the repo when this was written:** F5 complete, **15/15 exit criteria met**,
538 tests passing, typecheck, lint and build clean. F0–F4 committed; **all of F5 is
uncommitted.**

> ### If you read nothing else
>
> 1. **`MILESTONE_STAGE` now reads `'F5'`.** That unlocks less than it sounds like.
>    Sending still needs `SENDING_ENABLED`, and the send gate refuses every recipient
>    that is not on `OWNED_INBOXES`. **F6 is the milestone that lifts that**, and
>    lifting it takes the stage bump *and* `SEND_EXTERNAL_RECIPIENTS_ENABLED` — two
>    acts, deliberately.
> 2. **Read §4.4 before you trust an `approval_hash`.** F5 measured a case where the
>    hash matched over a message containing a dead link. It is fixed; the reasoning is
>    the useful part.
> 3. **The corpus was widened to 1,975 companies** during this session, by the
>    operator. Scoring has **not** been re-run over the new 1,825, so every downstream
>    number below still describes the old 150-company corpus.
> 4. **A9 does not hold on Gmail, and §2.3 is the measurement.** Gmail rewrites a
>    client-supplied `Message-ID`, so the reconciliation matches an `X-Outreach-Ref`
>    header instead. Read it before touching the send path.

---

## 0. Read these first, in this order

| File | What it is | Binding? |
|---|---|---|
| `handover.md` | The original brief. **§1's non-negotiable policies are binding and are not restated anywhere else.** §1.2 is amended by the operator — see `docs/F4-HANDOVER.md` §10.3. | Yes, except where the plan overrides |
| `docs/architecture-plan.md` | The approved architecture plan, verbatim. Defect ids (A1–A12), verification ids (B1–B7), design (Part D), build order (Part F), tests (Part G), decisions (Part H). | **Yes — this is the implementation contract** |
| `docs/F1-HANDOVER.md` | What F0 built, F0's nine deviations. | Yes |
| `docs/F2-HANDOVER.md` | What F1 built, F1's fifteen deviations. | Yes |
| `docs/F3-HANDOVER.md` | What F2 built, F2's fifteen deviations. | Yes |
| `docs/F4-HANDOVER.md` | What F3 built, F3's fifteen deviations, **and §10, the operator's volume-outreach scope amendment**, still binding. | Yes |
| `docs/F5-HANDOVER.md` | What F4 built, F4's twelve deviations, the Tier A yield number. | Yes |
| `docs/F6-HANDOVER.md` | This file. What F5 actually built, its deviations, and the F6 task. | Yes |
| `docs/handoff-llm-gateway.md` | How the LLM role works. Carries an **"As built (F5)"** section recording the one place F5 declined to use it, and why. | Yes |
| `docs/F6-PREPROMPT.md` | The session prompt for F6. Says which of the above to read first and in what order. | Informational |
| `README.md` | Setup and the things that bite. | Informational |

Do not redesign the plan. Do not weaken its safeguards. Do not introduce scraping of
gated platforms. Do not substitute unverified data sources for verified ones.

**Never edit `docs/architecture-plan.md`.** It is the original contract, reproduced
verbatim so it stays auditable. Implementation decisions that depart from it are
recorded in the handover for the milestone that made them — F0's in `F1-HANDOVER.md`
§4, F1's in `F2-HANDOVER.md` §4, F2's in `F3-HANDOVER.md` §4, F3's in
`F4-HANDOVER.md` §4, F4's in `F5-HANDOVER.md` §4, F5's in §4 below.

### The rules that outrank convenience

Unchanged, and all of them now have F0–F5 code standing on them:

1. **Never automate LinkedIn or any gated platform.** `handover.md` §1.4. Enforced at
   the transport layer by `FetchPolicyGate`, with tests asserting zero sockets.
2. **Never target founders, CEOs, C-suite or VPs.** §1.1 is **not** amended.
   `src/outreach/contacts/executive-filter.ts` fails closed on ambiguity.
3. **Never infer an email address as a targeting method.** Pattern inference is
   flag-gated OFF, writes `verified = false`, and an unverified contact opens **no**
   outreach case.
4. **Every network request goes through `FetchPolicyGate`** — including, as of F5, the
   mail transport. `gmail.googleapis.com` and `oauth2.googleapis.com` are ordinary
   allowlist entries, exactly as `api.firecrawl.dev` is — and carry no rate override,
   because an override can only ever slow us down (§4.10).
5. **Provenance on every fact, on both sides, per sentence.**
6. **Every message needs individual human approval.** §1.6 is unamended. There is
   deliberately no bulk approval form and `send:run` has deliberately no `--all`.
7. **The system prepares applications; it never submits them** (H8, irreversible).
8. **New in F5: the system sends only to owned inboxes.** Lifting that is F6's job and
   it takes two independent acts. See §8.2 before you do it.

---

## 1. What this system is, in one paragraph

A local, review-first system that turns a broad universe of startups into a queue of
internship opportunities across four tracks (iOS/Android, AI Engineer, SDE, SWE),
prioritising India then remote-viable US/UK/EU. The terminal action is an
**application**; cold outreach is permitted in four named cases and never sends without
per-message human approval. Per the operator's F4 amendment the outreach half targets
volume — 1,000–2,000 verified contacts — with per-sentence evidence citation as the
stated edge over template spray.

---

## 2. Where the project stands

### F5 is complete

```
npm test          → 38 files, 538 tests passed
npm run typecheck → clean (backend and UI configs both)
npm run lint      → clean
npm run verify:f0 → 4/4     npm run verify:f1 → 7/7
npm run verify:f2 → 7/7     npm run verify:f3 → 11/11
npm run verify:f4 → 13/13   npm run verify:f5 → 15/15
```

| F5 exit criterion | Evidence |
|---|---|
| Verified sends to owned inboxes only | The send gate's tenth condition. Demonstrated against the live database: the one approved draft, to `info@nanonets.com`, is refused with `recipient_not_owned` even at `MILESTONE_STAGE=F5` with `SENDING_ENABLED=true` |
| Deterministic handle persisted before the call | `verify:f5` re-derives every stored `rfc822_message_id` from its idempotency key and compares. The handle the reconciliation actually matches on is derived from the same key (§2.3) |
| A verified send to an owned inbox | Three, to `+f5a`/`+f5b`/`+f5c`, on 2026-09-11. The `send.test` audit row is what `verify:f5` reads |
| Crash mid-send issues no second send | Part G's row 1, driven through the real `sendApprovedDraft` with the worker killed between the provider call and the outcome write. `test/policy/send-gate.test.ts` |
| Same human never emailed twice in a cycle | D3's per-contact partial unique index, untouched by the slot change; plus the gate's readable refusal |
| A soft bounce does not permanently suppress | A12. `test/policy/outcome-ingestion.test.ts`, and `verify:f5` re-checks it over stored rows |
| `approval_hash` mismatch aborts the send | Seven red-team edits, each invalidating the approval — including the one F5 found was NOT covered (§4.4) |
| Kill switch cancels scheduled jobs | `cancelScheduledSends` (F0), read by the breaker |
| First-party counters only | `verify:f5` scans for any reputation source and asserts the complaint signal reports `unavailable`, never `0` |
| Milestone bumped honestly | `MILESTONE_STAGE = 'F5'`; all **15** F5 codes driven through real paths |

### 2.1 The live corpus, after F5

| Measure | End of F4 | Now |
|---|---|---|
| Companies | 150 | **1,975** |
| With a detected ATS board | 43 | **149** |
| `Opportunity` | 815 | **2,086** |
| `Evidence` | 3,041 | **27,839** |
| Scored leads | 69 | 69 |
| Qualified leads | 21 | 21 |
| `Contact` | 4 | 4 |
| `Draft` | 4 (1 approved) | 4 (1 approved · 3 gate_failed) |
| `CandidateProfile` | 0 | **1** |
| `SendAttempt` | 0 | 0 — `send:test` writes none, by design (§4.12) |

**Read the corpus row carefully.** The operator ran §9.1's `--feed all` ingest during
this session, so the universe is now 13× larger — and **`intel:run` has not been
re-run over it**. Scored leads, qualified leads and contacts all still describe the
original 150 companies. Every downstream number in this document, including the Tier A
yield, is measured on that old corpus. Re-scoring is the single highest-value thing
available before the pilot and it needs no network: `npm run intel:run` scores from
stored rows, and `-- --research N` is the only flag that fetches.

### 2.2 The Tier A yield, unchanged and still the binding constraint

F4 measured it and nothing in F5 changed it: **19 of 21 qualified companies were
actually read, 4 published a usable address, and not one published a dedicated
recruiting alias.** All four are general `info@`/`hello@` inboxes. §10 carries this
forward as the open question it still is.

### 2.3 The live send, and the A9 measurement — **A9 does not hold on Gmail**

Three diagnostics were sent to owned inboxes (`+f5a`, `+f5b`, `+f5c`) on 2026-09-11.
The send, the From header, plus-address delivery and the body all worked first time.
The reconciliation did not, and the reason is the most important finding in F5.

**Gmail replaces a client-supplied `Message-ID` and keeps no original:**

```
we set:        <oi.90ffa8e402a69d41a19ec505ec038af2@aryamanj.in>
Gmail stored:  <CAGBX58siJOdRioW4btcyYmV4-_oo5XFHkPNx+OMtpuvhVL46DQ@mail.gmail.com>
x-google-original-message-id:  absent
```

So A9 step 2 — *"search the Sent mailbox for `rfc822msgid:<message-id>` before
attempting another send"* — cannot work. The operator is on the API, and the search
operator itself is fine; the id it would look for does not exist. Left as specified,
**every reconciliation would report "not sent" for a message sitting in the
recipient's inbox, and the retry would deliver a second copy** — exactly the failure
A9 exists to prevent, and one that would have passed every test written against a fake
that preserves the header.

**A custom header does survive.** `X-Outreach-Ref`, carrying the same derivation,
came back intact on the same account in the same run:

```
x-outreach-ref   oi.b0b677ec727c462e23b35ed377d7da1b
```

So the reconciliation is: a bounded candidate search (`in:sent`, the recipient, a short
window) followed by an **exact match on that header**. The search is a filter, never
the answer — Gmail exposes no `header:` operator, and it would be easy to assume a
custom header lands in the full-text index and search the bare token, but relying on
undocumented provider behaviour is what just cost A9 its mechanism. It is not done
twice.

Everything A9 actually depends on is intact: the handle is still a pure function of
`SendAttempt.idempotencyKey`, still persisted before the API call, still recoverable
from the stored row alone after a crash. **Only the field it lives in changed.**

Final state, measured:

```
rfc822msgid: (A9 as written)  0 hit(s)  <- provider rewrote the Message-ID
X-Outreach-Ref (as built)     1 hit(s)
```

`send:test` prints both, deliberately, so the deviation stays evidenced in the output
rather than remembered in a comment.

#### SPF / DKIM / DMARC — not applicable to the pilot, and a same-account test cannot show them

Gmail merges a message sent to another address on the **same account** into one message
carrying both `SENT` and `INBOX`, and short-circuits delivery. There is no
`Authentication-Results` header, because no receiving server evaluated one.

More important: the F5 handover's §8.5 item 2 asked for *"SPF, DKIM and DMARC `p=none`
on the sending domain"*. **The operator changed the plan under it** — the pilot sends
from a personal `gmail.com` mailbox, which Google already DKIM-signs and whose SPF and
DMARC records are Google's. There is no sending domain of ours to configure, and
nothing for F5 to verify. It becomes real at the Workspace migration on `aryamanj.in`
around F6, which is the point at which those records are ours to set.

To see `Authentication-Results` before then, send to an owned mailbox **on a different
provider**: `npm run send:test -- --to <owned address not on this account>`.

### 2.4 Nothing about F5 is committed

`git log` shows the five commits F0–F4 were committed in. Everything F5 wrote is in the
working tree. The user commits when they choose.

**Four modified files in the working tree are the operator's, not F5's:**
`src/ingest/fetch-json.ts`, `src/ingest/fetch-page.ts`,
`test/policy/redirect-following.test.ts` and `tools/run-seed-ingest.ts`. They turn a
transport *throw* into a recorded `source_unavailable` outcome on the ingest path —
F1's invariant that *"a skipped source is an OUTCOME, not an exception"*, applied where
the 1,975-company run found it missing. They were made during the ingest and are
correct; F5 left them alone.

---

## 3. Environment — read before running anything

**No new dependencies in F5.** The Gmail adapter, the MIME builder, the OAuth flow and
the send gate are all first-party code over packages F0–F4 already pinned. There is
deliberately **no `googleapis` SDK and no `nodemailer`**: both own their own HTTP
transport, and putting a second network-capable client into the tree is precisely the
hole the three-layer raw-HTTP ban exists to close. The same reasoning kept
`@mendable/firecrawl-js` out in F2 and `jsdom` out in F2.

Pins are exactly as `F5-HANDOVER.md` §3 recorded them.

### Environment traps

Everything from `F5-HANDOVER.md` §3 still applies, and all of it still bites:

- **`npm run typecheck` runs two configs**, and the split is a security boundary.
- **`tsc --noEmit` is not run by `npm test`.** Run both. F5 hit this again: the
  `CandidateProfile` seeder ran correctly under `tsx` while failing `tsc` on Prisma's
  nullable-Json typing.
- **A green suite does not mean the CLI works**, and tsc clean does not mean the suite
  passes.
- **Never run `prisma db push`.**
- **`prisma migrate dev` cannot run non-interactively here.** Use `migrate diff
  --from-config-datasource --to-schema … --script`, read the SQL, then `migrate deploy`.
- **Prisma's generator reads `tsconfig.json`, which `next build` rewrites.**
- Run `npm run db:generate` after any migration before trusting a failure.
- **Run the `verify:*` scripts individually.** Did not recur in F5, but the F4 report
  of a spurious `6/7` stands as a warning.

**New in F5, and worth knowing:**

- **`prisma migrate diff` will happily drop an index you did not mean to lose.** F5's
  migration legitimately drops two — one plain lookup index (because the composite
  widened) and one of D3's *partial unique* indexes (replaced in the same transaction
  by a strictly-bounded successor). The generated SQL contained only the first; the
  second was hand-written below the generated block, with the reason. Read the SQL.
- **A zero-cost `GateContext` is meaningful and is not the default.** `cost: 0` makes a
  request non-refusable by the budget and uncharged. That is how the mail transport
  passes through the gate without a research cap being able to abort an approved
  message. Do not "tidy" it to the default of 1.

---

## 4. Deviations from the plan — every one, with its reason

F0's nine, F1's fifteen, F2's fifteen, F3's fifteen and F4's twelve are all still in
force and none were reverted. These are F5's. **Do not silently revert any of them; if
you disagree, raise it with the user.**

Four of them (§4.2, §4.4, §4.8, §4.9) are defects found by running the code against
live data or by a test, which is the pattern every milestone has repeated.

### 4.1 The send gate has eleven conditions, not D6's nine — and one of them is a new reason code

**The most consequential thing in this milestone, and the reason raising
`MILESTONE_STAGE` is not the same act as starting the pilot.**

D6 enumerates nine conditions. Every one of them **passes** for the approved draft
sitting in `outreach_dev`, whose recipient is `info@nanonets.com` — a real person at a
real company. So at F5, with D6 implemented exactly as written, finishing the milestone
*is* starting the pilot: the two independent factors F0 built (a reviewed source
constant plus an env flag) would both be satisfied by the act of completing the work.

That cannot be right, and Part F says so — the F5 deliverable is *"verified sends to
owned inboxes **only**"*, and F6's is *"Enable sending"*. Those are two milestones.
D6 is not wrong; it describes the steady state after the pilot has started.

So `src/outreach/send/recipient-policy.ts` adds a tenth condition, and it is the only
thing standing between a one-line stage bump and a live email to a stranger. Three
properties make it load-bearing rather than decorative:

- **Lifting it takes two independent acts.** `resolveRecipientPolicy` returns `any`
  only when the stage has reached F6 **and** `SEND_EXTERNAL_RECIPIENTS_ENABLED` is set.
  Setting the flag today does nothing at all, which is what makes it safe for the
  variable to exist before it is wanted. Same two-factor shape as
  `resolveSendingEnabled`, one level in.
- **It fails closed in every direction.** An empty allowlist refuses every recipient
  rather than admitting all of them; an unparseable address is refused rather than
  handed to the provider to interpret.
- **Plus-tagging folds one way only.** An untagged entry admits `+tag` variants of
  itself, because `aryamanj250+f5a@gmail.com` is not a similar address to
  `aryamanj250@gmail.com` — it is the same inbox, which is what "owned" means. A
  *tagged* entry never admits the untagged base. Gmail's dot folding is deliberately
  not implemented: it is provider-specific trivia, and `normalizeEmail`'s own
  reasoning — that collapsing addresses a provider treats as distinct is unrecoverable
  — applies with more force to a matching rule.

**The eleventh condition is `user_paused`.** `handover.md` §8 requires an immediate
stop for *"reply, bounce, rejection, opt-out, wrong contact, application submitted, or
user pause"*, and D6's list contains none of them. A kill switch is global, per-domain
or per-account; a paused lead is none of those.

#### `recipient_not_owned` is the 40th reason code

The enum is closed and a new value costs a migration and an owner, so F4 §4.11 was
right to map gate failures onto existing codes rather than invent one. This is the case
that genuinely has no analogue. Folding it into `sending_disabled` would make the
single most safety-critical refusal in the milestone indistinguishable — in every
counter, every audit row and every operator-facing message — from *"the operator has
not set the env flag yet"*.

### 4.2 `sender_identity` was in A7's hash and bound nothing *(latent F4 defect)*

`approveDraft` took `senderIdentity` as an **option**. `tools/run-drafts.ts` called
`approveDraft(db, id, by)` and never passed one. So every stored `approval_hash` was
computed over `null`, and the send gate would have had to pass `null` too in order to
match.

The consequence, stated plainly: A7's hash bound the subject, the body, the recipient,
the resume file and every citation — and did **not** bind the one field that decides
whose name is on the message. Swapping the sending account would have left the approval
valid.

It is a stored column now (`draft.sender_identity`), read from
`CandidateProfile.senderIdentity` at approval and read **back from the draft** when the
gate recomputes. That asymmetry is the part that is easy to get backwards and is
commented in the code: every other field in the verification is deliberately live — a
swapped recipient or an edited resume must invalidate the approval — but the identity
the human approved is a property of the approval itself. Re-deriving it from the
profile would mean editing the profile silently re-validated every outstanding
approval, which is *"recomputing from live data always matches and proves nothing"*
applied to the field that matters most.

An approval with no identity to freeze is now **refused** rather than defaulted.
Defaulting is what produced the hole.

### 4.3 The research budget has three ceilings, and that took a measurement

F2 §4.7 made one credit unit cover a free static fetch and a paid Firecrawl scrape
alike, so Part G's *"cap zero → all research no-ops"* would be true of the whole
research path. F3 §4.10 split the **counters** but deliberately not the caps, on the
same grounds. Both were reasonable and both were wrong in the same way, and it took a
real run to show it.

The 1,975-company ingest spent the entire 1,000-credit global envelope — an envelope
the operator had sized to Firecrawl's free tier — on **free static fetches**, in about
an hour, and then returned `budget_exhausted` for fifty minutes while the run kept
going. The cap did not bound the thing it was named after and did stop the thing it was
not meant to stop. It sits at 50,000 today purely as a workaround.

So: `creditsCap` keeps its job and still counts every unit, free or paid — which is
what keeps the no-op test honest — and the paid subset gets `vendorCreditsCap`, read
only from the **global** envelope, because a paid monthly allowance is a global
resource. `billedUsdCap` is enforced too; it had existed on every row since F0 and
nothing ever read it, which would have surfaced the first time a per-lookup billed
provider ran unbounded. A Hunter key is expected before F6.

**And a zero spend is never refused and never charged.** That is what lets the mail
transport pass through `FetchPolicyGate` — it is there because the gate is the only
path to the network, not because it consumes a research allowance. Without it an
exhausted research cap could abort an approved message, and the refusal would carry
`budget_exhausted`: not an F5 reason code, not one of D6's conditions, and an
accounting decision silently overriding a human approval.

### 4.4 The approval hash matched over a message with a dead link *(latent, and the handover predicted the opposite)*

`F5-HANDOVER.md` §8.5 stated that hosting the four resumes *"will change every approved
draft's `approval_hash`, which is the mechanism working"*.

It was measured. After `npm run seed:operator` re-ran with real hosted URLs, the one
approved draft in the live database still verified as `{ matches: true }` — over a body
containing `Resume: file:///Users/.../Resume_AI.pdf`.

A7 was doing exactly what A7 says. Its field list binds `resume_version_id` and
`attachment_sha256[]`, and neither moved: same row, byte-identical file. Only *where it
is published* changed, and `bodyText` and `composition` were frozen at composition time
and did not move either.

The gap is that **A7 was written for an attachment**, where the document's content hash
is what the recipient receives. H3 makes this system link rather than attach — B5: a
new sending domain plus an attachment is the worst deliverability combination available
— and for a link the URL *is* the payload. A correct hash over a dead link is a valid
approval for a message that does not work.

`resumeLinkUrl` is in the hash input now, and a test pins it. Note what it does not
fix: the stored `bodyText` still carries whatever link was rendered at composition, so
the correct repair for the existing draft is **re-composition, not re-approval**.

**Generalise it:** a hash over "the inputs that produced the artefact" is not the same
as a hash over "what the recipient receives", and A7's field list is the first and not
the second wherever the two diverge.

### 4.5 `profile-fields.ts` did not exist, and the list it holds is three fields long

`schema.prisma` has said since F0 that D6 condition 3's enumerated field list *"lives
in src/core/config/profile-fields.ts (F4)"*. It was never written, and
`CandidateProfile` had **zero rows**. A12 lists *"send-enable field list
unenumerated"* among the remaining gaps; this closes it.

Two decisions worth recording.

**The list is short on purpose.** A field is required only if a sent message actually
consumes it: `fullName` (the sign-off template renders it), `senderIdentity` (the
`From` header, and A7's hash), `replyToEmail` (the `Reply-To` header, and B4's
voluntarily-adopted controls ask for a real one). The tempting version — location, work
authorization, availability dates, a signature block — reads thorough and is not: every
one of those is either already bounded by `ApprovedClaim` or absent from the message,
so requiring it would block sends on data no recipient will ever see. `handover.md`
§8's ban on falsely claiming work authorization or availability is enforced where those
statements are made, per sentence, on the claim side.

**The profile is derived from `ApprovedClaim` and from nothing else.** The obvious
implementation types the operator's details into a seed file, which would create a
second, unchecked source of candidate facts three milestones after F3 §4.1 established
that `ApprovedClaim` is *the* provenance table for them — and directly against F4's
instruction not to add a parallel source. `src/apply/claims/seed-profile.ts` maps claim
key → profile field, and a missing claim leaves its field null so
`profile_incomplete` fires, which is the correct behaviour for a fact the operator has
not supplied (F3 §4.3's rule, one table over).

One composed value is called out because it is not a straight copy: `senderIdentity` is
`"<identity.full_name> <<identity.email>>"`, two approved claims joined into RFC 5322's
display-name form. Both halves are verbatim and the only added characters are the angle
brackets the format requires.

`availabilityFrom` / `availabilityTo` are deliberately left null. The operator's window
is *two disjoint ranges* — December 2026 to January 2027, **or** June to August 2027 —
and two columns cannot hold that. Parsing the claim's prose into one pair would store a
window the operator never stated, in the table whose job is to be the checked one.

### 4.6 Reply classification is deterministic, and departs from the gateway's own table

`docs/handoff-llm-gateway.md` assigns *"F5 | Reply classification"* to the gateway.
F5 declined, and the full argument is in that file's new "As built (F5)" section. The
short version:

- **It decides whether to permanently suppress a human being.** An opt-out writes an
  HMAC-backed `Suppression` that A10 makes outlive the contact row — effectively
  irreversible. The gateway's own rule already lists the send gate, HMACs and state
  transitions as staying deterministic; a decision that writes an irreversible record
  about a person belongs on that list.
- **H10 would invert here.** Everywhere else an undrained backlog degrades quality — a
  packet is usable with two answers blank, a draft is complete as a record. An
  unclassified opt-out leaves the lead *live* until a session is opened, and the
  failure mode is writing again to someone who asked us not to. That must not wait on a
  human opening a terminal.
- **The patterns are pinnable in both directions**, the way F2 §4.12's injection
  patterns are.

The classifier favours **recall over precision** on opt-out: a missed opt-out is
unrecoverable, a false positive costs one lead. RFC 3834's `Auto-Submitted` header is
trusted *before* any text matching, so a vacation responder whose signature contains
"not interested" cannot read as an opt-out from someone who never saw the message.

What the gateway **is** still right for here is the second half of `handover.md` §5's
Inbox/Outcome Worker — *"creates a reply draft for the user"*. That is judgment over
quoted evidence with a human approving the result, it needs no new mechanism, and it is
F6's.

### 4.7 Stopping a conversation and suppressing an address are separate acts (A12, as built)

A12's rule is *"a soft bounce must not permanently suppress"*. The naive reading forces
a bad trade: if soft means "not suppressed", a failing address keeps being retried and
damages the sending reputation.

It does not, because the two are separable and are separated.

*Stopping* ends the conversation — terminal draft status, the reason on the lead, any
follow-up cancelled. **Every** outcome stops, including a soft bounce. So nothing is
ever re-sent to a failing address.

*Suppressing* writes the HMAC-backed row. Only a hard bounce, an opt-out and a
wrong-contact report do that.

The same separation answers the reply case from the other side: **a reply stops without
suppressing**, because a person who replied has not asked us to stop — they have started
a conversation, and suppressing them would block the operator's own answer.

It also settles what to do with an unreadable bounce. The instinct is to call it hard,
because retrying a dead address is expensive; but the lead is stopped either way, so
hardness decides *only* whether an irreversible record is written on a guess.
Unreadable bounces classify **soft** and carry `inferred: true` so an operator can
review rather than discover.

### 4.8 The idempotency check runs BEFORE the gate *(found by a test, not by reading)*

The first implementation ran D6's gate and then looked for an existing `SendAttempt`.
A test caught what that costs: an `in_flight` attempt makes condition 8 refuse with
`duplicate_contact`, so **a retry after a crash could never reach A9's
reconciliation at all**.

The refusal is correct as a refusal — there *is* a duplicate — but it answers the wrong
question. A9 says *"a retry finding an `in_flight` attempt reconciles by querying the
provider, never re-sends"*. Once an attempt exists the decision to send has already been
taken and possibly already executed; what is needed is to find out what happened, not to
adjudicate it again. Re-gating would also mean a message that genuinely went out could
be recorded as refused because a cap moved in the meantime.

So step 0 looks the attempt up by the key the gate *would* derive, reading only the four
fields the key is made of — it runs before any policy check, so it must not be able to
learn anything it could act on. Its only outcomes are "reconcile" and "report"; it
cannot cause a send.

### 4.9 Three shipped verifiers asserted things a later milestone legitimately changed

F2 §4.9 drew the rule — *"a verifier for a shipped milestone must keep passing at every
later stage, or it stops being a regression test"* — and F5 found three more instances
at once. Recording all three together because the shape is the lesson.

1. **`verify:f1` criterion 1 asserted `100 <= companies <= 200`.** The corpus is now
   1,975. A floor is a regression test; a ceiling is a statement that the project will
   not grow. Upper bound removed. *(Audited f2, f3 and f4 for the same shape: no other
   absolute upper bound exists.)*
2. **`verify:f3` asserted `gate.postJson` has `<= 1` caller.** The intent, in its own
   comment, was *"a second caller must be reviewed rather than discovered"* — not "there
   will only ever be one". F5 is that review, and the fix is a **named allowlist** of
   two rather than relaxing the count to `<= 2`, which would be the same check one notch
   weaker and would silently admit a third.
3. **`verify:f4` asserted that sending was disabled and that no mail transport
   existed.** Both became false the moment F5 did its job, which made a shipped
   milestone's verifier fail *because the next milestone succeeded*. Rewritten to
   F4's actual permanent responsibilities: nothing is transmitted without a frozen
   human approval, and the **drafting layer holds no `MailProvider`** — a boundary that
   stays true forever and gets stronger as sends accumulate.

The same trap caught two tests: `test/unit/stage-guard.test.ts` asserted the shipped
stage was below F5. Rewritten to the property that survives — **both factors are still
required** — with a pointer to where the guard that replaced the stage guard now lives.

### 4.10 The Gmail hosts are ordinary allowlist entries — and a rate override cannot make us faster

No exception was carved for the mail path. `gmail.googleapis.com` and
`oauth2.googleapis.com` earn `HostPolicy` allow rows exactly as `api.firecrawl.dev` did
in F2, and every mail request runs the same five-step preflight.

Two things were verified rather than assumed, on 2026-09-11:

- **Both hosts answer `robots.txt` with 404.** F1 §4.9 defines that as "no rules
  published", which is permission **only** for a host with an explicit allow entry —
  which these have. Had it been a 5xx or a disallow, the right answer would have been
  to stop, not to special-case it.
- **`gmail.modify` is the minimum.** `gmail.send` cannot run the reconciliation search
  that stops a double send; `gmail.metadata` cannot read the bodies reply
  classification needs; `https://mail.google.com/` includes permanent delete and would
  be asking for more than the job requires from what is also the operator's personal
  mailbox.

**And a correction, because the first version of this was wrong.** A 1,500 ms
`rateDelayMsOverride` was written on the reasoning that Google publishes 6,000 quota
units per minute per user — with `messages.send` at 100 units, one send per second —
so we could safely go faster than the project's 5,000 ms default. **An override cannot
do that.** `effectiveDelayMs` returns `max(default, override, crawlDelay)`; its own
contract says *"a published rate limit always wins over our default — never the other
way round"*. The override was dead weight and has been removed, with the reason
recorded on the entry so nobody adds it back.

The effective spacing is therefore 5,000 ms, and the adapter waits it out between its
own calls (§4.14) rather than trying to shorten it. At ≤20 sends/day a five-second gap
costs nothing, and shortening it would mean reaching past the limiter — which is
evading a rate limit (`handover.md` §1.5).

### 4.11 The OAuth loopback flow has no loopback server

Google withdrew the out-of-band flow in 2022, so an installed app must use a loopback
redirect, and the textbook implementation runs a local HTTP server to catch it. This
project bans `node:http` everywhere outside `raw-client.ts`, enforced by ESLint, by the
AST scanner and by the backend tsconfig having no DOM lib — and that ban is what makes
*"`FetchPolicyGate` is the only path to the network"* a structural claim rather than a
convention.

It is not needed. The browser lands on `127.0.0.1:<port>`, fails to connect, and leaves
the code in the address bar. One paste replaces a server and the ban stays intact.

The refresh token is enveloped through `SecretStore` (A5) — sealed under a data key,
the data key under the Keychain KEK, ciphertext in `secret_record`, and the plaintext
registered with the redactor. The **access** token is never persisted at all: it lives
an hour and is held in memory, and writing it down would be a second copy of a
credential for no benefit. `FetchPolicyGate.postForm` audits **no part** of a token
request body — every field is either a credential or a constant, so the correct
allowlist is empty and an opt-out list would be one forgotten key away from writing a
refresh token into `audit_log`.

### 4.12 `send:test` cannot reach a third party at any stage

The plan's Verification section names `npm run send:test` as the owned-inbox harness.
Having a command that sends outside the send gate is a real risk, so three things bound
it:

- It checks the recipient against `OWNED_INBOXES` **unconditionally**, and deliberately
  does *not* consult `resolveRecipientPolicy` — that function is allowed to return `any`
  at F6, and a diagnostic has no business being widened by a pilot switch.
- It is not a campaign message: a fixed diagnostic body, no `Draft`, no `SendAttempt`,
  no approval read. It cannot send anything a human approved, which is what stops it
  being a way around §1.6.
- It checks the kill switch first. A switch a diagnostic ignores is a switch with an
  exception.

### 4.13 The MIME builder is hand-written, and refuses rather than repairs

No MIME library. The message is one `text/plain` part with no attachment (H3, B5), and a
dependency that can build a multipart tree with attachments is one that can be talked
into building one.

A header value containing CR or LF is **refused**, not stripped. The subject is composed
text, and a newline in it is a composer bug; silently repairing it would hide the bug
while sending the repaired version. Non-ASCII survives via RFC 2047 encoded words in
headers and base64 for the body — the corpus is international, and an encoded-word is
never applied inside `addr-spec`, which would produce a header that looks fine and
routes nowhere.

### 4.14 The reconciliation was refused by our own rate limiter, twice

Found by running it, not by reading it, and worth both entries because the second
failure was a different bug wearing the first one's clothes.

**First failure.** `send:test` sent successfully and then threw:

```
GmailApiError: reconciliation search refused by FetchPolicyGate: rate_limited
```

The gate refuses a too-early request rather than queueing it, and the search follows
the send by milliseconds. So A9 step 2 — the mechanism whose only job is to stop a
double send — could not run at exactly the moment it is needed, because our own
conservative rate policy had just been consumed by the send it exists to reconcile.
This is F4 §4.1 one layer down: *"a refusal is about the host"* is true of
`host_denied`, `robots_disallowed` and `terms_prohibited`, and **false of
`rate_limited`**, which is about timing and expires on its own. The fix, there and
here, is to wait.

**Second failure, after the fix.** The adapter stamped its own clock when it *started*
waiting, while the gate's `HostRateLimiter` stamps when the request is actually
*issued* and measures the next window from there. A Gmail call takes 300–900 ms, so the
200 ms of margin between our spacing and the gate's was eaten by the request itself and
the next search was refused again. The clock is stamped on **completion** now
(`markRequestDone`), which is strictly more conservative than the limiter — a margin
rather than a race against how fast the API happens to be that day.

**Generalise it:** two components that both measure "time since the last request" must
agree on which instant that is, and the safe disagreement is the one where the caller
is later than the enforcer.

One thing was already right and is worth keeping right: the failure was **loud**.
`findByMessageId` throws rather than returning `null`, because a `null` there means
"not sent" and licenses another send. A reconciliation that could not look must never
report that it looked and found nothing.

---

## 5. F5 as built — the map

```
prisma/migrations/
  20260911150000_f5_send_readiness/   reason_code += recipient_not_owned;
                                      draft.sender_identity; send_attempt.touch_slot;
                                      research_budget.vendor_credits_cap;
                                      one_first_touch_per_company_per_cycle REPLACED by
                                      one_first_touch_per_company_slot_per_cycle (§8.3)
src/core/config/stage.ts        MODIFIED: MILESTONE_STAGE = 'F5'
src/core/config/config.ts       MODIFIED: OWNED_INBOXES, SEND_EXTERNAL_RECIPIENTS_ENABLED,
                                GMAIL_SENDING_ACCOUNT, MESSAGE_ID_DOMAIN
src/core/config/profile-fields.ts   §4.5 — D6 condition 3's enumerated list
src/core/policy/budget.ts       MODIFIED: §4.3 — three ceilings, zero-cost short circuit
src/core/policy/fetch-policy-gate.ts  MODIFIED: postForm, GateContext.headers/billedUsd
src/core/policy/http/raw-client.ts    MODIFIED: rawPostForm (the third and last method)
src/core/policy/host-lists.ts   MODIFIED: the two Google hosts + seeded rate overrides
src/core/interfaces/providers.ts      MODIFIED: ProviderMessageRef carries threadId
src/apply/claims/seed-profile.ts      §4.5 — CandidateProfile from ApprovedClaim only
src/apply/resumes/resumes-data.ts     MODIFIED: hostedUrl; linkUrl derived from it
src/outreach/draft/approve.ts   MODIFIED: §4.2 — senderIdentity stored, not defaulted
src/outreach/draft/hash.ts      MODIFIED: §4.4 — resumeLinkUrl in A7's input
src/outreach/mail/
  message-id.ts                 A9's deterministic derivation, and X-Outreach-Ref
  mime.ts                       RFC 5322 by hand; refuses header injection (§4.13);
                                sets X-Outreach-Ref, the handle that survives (§2.3)
  oauth.ts                      installed-app flow, enveloped refresh token (§4.11)
  gmail.ts                      the MailProvider. Transport only — it decides nothing
  fake.ts                       the contract fake, which can rewrite a Message-ID
src/outreach/send/
  recipient-policy.ts           §4.1 — the owned-inbox condition
  gate.ts                       D6, eleven conditions, one transaction
  send.ts                       A9: the row before the call; reconciliation, never a resend
  caps.ts                       D6.6
  breaker.ts                    D6.7; the complaint signal is optional and never "healthy"
  counters.ts                   B3: first-party only, three-state complaint signal
  classify-outcome.ts           A12: bounce hardness, reply classification. Pure
  ingest-outcomes.ts            stopping and suppressing, separated (§4.7)
test/
  helpers/send-world.ts         an approved draft, through the real approval flow
  policy/send-gate.test.ts      26 tests, incl. Part G's crash-mid-send row
  policy/outcome-ingestion.test.ts  13 tests, A12 from both directions
  policy/owned-inbox.test.ts    13 tests, each a way in
  unit/classify-outcome.test.ts 12 tests
tools/
  gmail-auth.ts    LIVE. One-time consent, no local server
  send-test.ts     LIVE. Owned inboxes only, at every stage. Measures A9 and SPF/DKIM
  run-send.ts      LIVE with --id. --list and --dry touch no network. No --all, ever
  run-inbox.ts     LIVE, read-only against the mailbox
  verify-f5.ts     the fifteen exit criteria
  verify-f1.ts / verify-f3.ts / verify-f4.ts   MODIFIED: §4.9
```

### The invariants F5 adds

**A message cannot reach anyone who is not an owned inbox**, and lifting that takes the
stage *and* a flag.

**A `SendAttempt` exists before the provider is called**, carrying the key every
reconciliation handle is derived from. A crash between the two leaves a row that says
"a send may have gone out, and here is how to find out" — and on Gmail the handle is
`X-Outreach-Ref`, not the `Message-ID` A9 named (§2.3).

**Reconciliation never sends.** It holds no message — only an id to look for.

**A research cap can never abort an approved message.**

**A soft bounce never writes a permanent suppression**, and every outcome stops the
conversation regardless.

**The complaint signal is three-state.** `unavailable` is not `0` and cannot be coerced
into one by a `?? 0`.

**The drafting layer holds no `MailProvider`** — asserted by `verify:f4`.

**`npm run send:run` has no `--all`.** §1.6 is unamended.

---

## 6. The reason-code mechanism

F5 raised the count from 39 to **40** (§4.1). The two tests are unchanged in shape:
`test/unit/reason-codes.test.ts` asserts registry↔Prisma-enum bijection plus the
enumerated reachable list at `'F5'`, and
`test/policy/reason-code-coverage.test.ts` drives every reachable code through its real
path — 37 of the 40, the remaining three being F7's browser layer.

`sending_disabled`'s scenario had to be rewritten: it read
`resolveSendingEnabled({ envFlag: true })` and relied on the stage refusing. At F5 the
stage no longer refuses, so it would have started returning `enabled` and the code would
have quietly become unreachable — the exact failure that file exists to prevent. It now
drives the real gate with the env flag unset.

### F6's obligation here

**F6 owns no new reason codes.** All 40 are registered and 37 are reachable. What F6
must do instead:

1. Set `MILESTONE_STAGE = 'F6'` **and** `SEND_EXTERNAL_RECIPIENTS_ENABLED=true` — the
   two acts that lift the owned-inbox restriction. Neither alone does anything.
2. Change the hardcoded `'F5'` references to `'F6'` in both tests. The reachable list
   does not grow, so the assertions should hold unchanged — **if they do not, something
   was registered to F6 that nobody built.**
3. Keep every existing scenario driving a real path. The send-gate scenarios pin
   `stage: 'F5'` deliberately so they keep testing a gate rather than whatever the
   stage happens to be.

### Ownership of all 40 codes

| Milestone | Codes |
|---|---|
| **F0** ✅ | `budget_exhausted` `host_denied` `kill_switch_account` `kill_switch_domain` `kill_switch_global` `rate_limited` `robots_disallowed` `sending_disabled` `terms_prohibited` |
| **F1** ✅ | `content_unchanged` `duplicate` `source_unavailable` |
| **F2** ✅ | `injection_detected` `insufficient_evidence` `low_relevance` `outdated_role` `weak_evidence` |
| **F3** ✅ | `application_submitted` |
| **F4** ✅ | `executive_only_contact` `legal_policy_mismatch` `no_public_recruiting_route` `outreach_not_permitted` |
| **F5** ✅ | `approval_hash_mismatch` `breaker_open` `cap_exceeded` `duplicate_company` `duplicate_contact` `hard_bounce` `opt_out` `profile_incomplete` `recipient_not_owned` `replied` `soft_bounce` `stale_at_send` `suppressed` `user_paused` `wrong_contact` |
| **F6** | *(none — F6 is a rollout, not new refusals)* |
| **F7** | `browser_blocked` `browser_needs_user` `browser_policy_rejected` |

---

## 7. `HandoffLlmGateway` — what F5 changed

**See `docs/handoff-llm-gateway.md`, "As built (F5)".** F5 is the first milestone that
*declined* a use the gateway's own table assigned to it — reply classification, §4.6.
Nothing else about the gateway changed, and 22 tasks are still pending (19
`research_brief` from F2, 3 `outreach_draft` from F4). Drain with `npm run llm:next`.

---

## 8. F6 — the task

> **Plan, Part F, verbatim:** *F6 — Controlled pilot. Enable sending. 5/day week one,
> 10/day week two if clean, 20/day ceiling. One follow-up at 7–10 business days, then
> stop. → A measured 50-company pilot.*

### 8.1 What to build

1. **The follow-up.** The one thing F5 deliberately did not build. Exactly one, 7–10
   business days after the first touch, then stop. `QUEUES.followUp` exists,
   `SendAttempt.touchNumber` exists, and `cancelScheduledSends` exists — the pieces are
   there and nothing schedules anything yet. Every stop reason must cancel it, and
   *cancel* is the word: A12 says a paused job that resumes on restart sends the mail
   the operator stopped.
2. **The ramp, gated on measured signals.** `capsForStage` returns F6's week one (5/day,
   3/domain). The ramp to 10 and then 20 is **not** encoded and must not be a calendar:
   Part G's rollout criteria are *"zero hard bounces, zero opt-outs, zero wrong-contact
   reports"* for week 1→2 and *"hard bounce rate 0%, ≥1 positive reply or
   acknowledgement, no manual pause"* for 2→3. Read them from the first-party counters,
   which already exist.
3. **The reply draft** — `handover.md` §5's Inbox/Outcome Worker's second job, and the
   place the LLM gateway genuinely belongs (§4.6). A task kind, both citation arrays,
   the same CLI.
4. **The dashboard's send queues.** F3 §4.14's rule still stands: a queue a later
   milestone fills renders "not built", never `0`. Several of those are now fillable.
5. **The pilot measurement.** 50 companies, and the numbers Part G's rollout criteria
   actually need.

### 8.2 Before you enable sending — read this twice

Two acts, and they are separate on purpose:

```
src/core/config/stage.ts     MILESTONE_STAGE = 'F6'     # a reviewed commit
.env                         SEND_EXTERNAL_RECIPIENTS_ENABLED=true
                             SENDING_ENABLED=true
```

Neither alone changes anything. `resolveRecipientPolicy` requires both, and
`test/policy/owned-inbox.test.ts` pins that at F6-with-no-flag and at
F5-with-the-flag the answer is still `owned_only`.

Part F's F5→F6 rollout criteria must actually be met first:

- SPF/DKIM verified on the sending identity (§2.3),
- owned-inbox sends render and thread correctly,
- the kill switch cancels scheduled jobs,
- **the crash-mid-send reconciliation test passes with no second send** — green, and it
  is Part G's first row.

And one that is not in the plan but follows from §4.4: **re-compose the outstanding
draft rather than re-approving it.** Its stored body carries a `file://` resume link
from before the resumes were hosted. The approval hash is correctly invalid now; the
body still needs regenerating.

### 8.3 What F6 must NOT do

- **Do not raise the caps on a schedule.** They move on measured first-party signals or
  they do not move.
- **Do not add a bulk approval form.** §1.6 is unamended and the operator reconfirmed
  it in F4 §10.7. At 2,000 contacts and 20/day that is roughly five months and 2,000
  individual approvals — see §8.4 of the F5 handover. That arithmetic is an argument
  about what the corpus is *for*, not about the policy.
- **Do not exercise the Tier B lookup provider** without the operator choosing a vendor
  and reading its terms (F4 §10.5). `jurisdiction.ts` already refuses the amended path
  in regions with no recorded review.
- **Do not build the browser layer** (F7, and only on measured need).
- **Do not change score weights.** A11 freezes them until ≥100 sends.

### 8.4 What F5 learned that changes F6

- **The corpus is 1,975 companies and only 150 of them have been scored.** Re-run
  `npm run intel:run` — no network — before drawing any conclusion about pilot supply.
  This is the cheapest high-value action available.
- **A verifier's ceiling is a bomb with a later fuse** (§4.9). Write `verify-f6.ts` with
  floors and `isAtOrAfter`, and audit it against the shape before shipping.
- **A hash over the inputs is not a hash over what the recipient receives** (§4.4).
- **`cost: 0` is meaningful.** Any new provider call that is not research declares it.
- **Test the provider's real behaviour before designing around it** (§2.3). A9's
  reconciliation was designed against a documented assumption and the assumption was
  worth measuring.

---

## 9. What F6 must hand to F7

Write `docs/F7-HANDOVER.md`: §0 read-first list, §2 status with real numbers,
§3 environment, **§4 deviations (the most valuable section — do not compress it)**,
§5 map, §6 reason codes, §7 the LLM gateway, §8 the F7 task. F7 is the browser layer
and D4 builds it **only if F2/F3/F6 measurement proves qualified-lead loss from
unrenderable pages** — so §2 must carry that measurement or say plainly that it was not
taken.

---

## 10. Open questions — carried forward

1. **The corpus is 1,975 companies, of which 150 are scored.** The widening happened;
   the scoring has not. Highest-value, cheapest, no network.
2. **Tier A yield: 4 contacts from 19 measured companies, zero recruiting aliases.**
   Unchanged since F4 and still the binding constraint on the operator's 1,000–2,000
   target. It is measured on the old corpus and is worth re-measuring after re-scoring.
3. **Which lookup provider, if any.** Still deliberately unanswered — no vendor chosen,
   no terms read, no host allow entry (F4 §10.5).
4. **The global research envelope sits at 50,000 as a workaround** (§4.3). Now that the
   ceilings are split, the honest values are a large `creditsCap` (it bounds work, not
   money) and a `vendorCreditsCap` equal to whatever Firecrawl allowance has actually
   been bought — which is currently zero. The 1,015-credit historical gap on the global
   row (F3 §4.9) is still unbackfilled.
5. **Firecrawl student credits — still unclaimed**, still the only untested path in F2.
6. **The `tempo.fit` board-token collision** (F5 §9.2), and whether the same shape
   exists elsewhere in the corpus. F4 stops a *message* citing the contaminated
   evidence; the `Opportunity` rows are still wrong and still inflate that company's
   score and packets. Worth a corpus-wide scan now that the corpus is 13× larger —
   nothing has ever looked.
7. **India coverage.** 0 of 37 packets at F3, and the 1,825 newly-ingested companies
   have not been scored, so nobody knows whether the widening helped.
8. **Two duplicate `company_page` `Evidence` rows per page researched before F2 §4.1.**
   Harmless; a one-line delete if the noise ever matters.
9. **Git:** F0–F4 are five commits on `main`. All F5 work is uncommitted. The user
   commits on their own schedule.
