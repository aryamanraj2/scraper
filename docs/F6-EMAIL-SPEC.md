# F6 — the email, as the operator wrote it

Written 2026-10-04. The operator's own email design, reviewed by the orchestrator
against `approved_claim`. **This replaces the per-sentence LLM composition of
`outreach_draft@2`.** The LLM writes three short grounded fields (`via`, `hook`, `scene`)
and picks the track and three modules. Everything else is fixed, human-written copy.

## Changes the orchestrator made to the operator's version, and why

| Where | Change | Reason |
|---|---|---|
| `privacy_saldo` | Says it is the iOS app and that it reads receipts. Drops "bank SMS" | The no-cloud app that won Swift reads receipts. The Android SMS app sends redacted low-confidence messages to Gemini (`project.saldo.ai_fallback`), so "SMS… no cloud at all" was false |
| `both_wandr` | **Unchanged.** The operator's original Siri line stands | The operator confirmed it was built, entirely by him. Added as claim `project.wandr.siri_intent` in `src/apply/claims/claims-data.ts`. Run `npm run seed:operator` so it reaches the database before composing |
| `correctness_saldo` | "13 bugs, like balances read as payments" | Not all 13 defects were that kind |
| `voice_aquasense` | "shows a clean retry" instead of "recovers cleanly" | The claim says typed error codes are mapped to retryable states |
| `safe_airtel` | "engineers", not "on-call engineers" | "On-call" belongs to the surge-analysis claim |
| `ownership_smartout` | "rebuilt their iOS app… and the app has 50K+ installs" | The claim says rebuilt, replacing a Flutter build. Installs are a separate claim and were not all his |
| intro | No "ECE" | Operator's instruction |
| body | Adds the internship window line, and a route line for role inboxes | Otherwise the email never says "internship" |
| resume | Chosen by the **email's track**, which must agree with the modules | The old path used the lead's scored track: a mobile email to Strava carried `ai.pdf` |
| validation | All three slots must be different projects | The operator's version checked only slots 1 and 2 |
| `MAX_WORDS` | 240, URLs not counted | Measured: fixed parts are 59 words and three modules 86–124, so 190 left 7–45 words for the hook and scene |

## Integration rules for the implementer

- **Port this into the existing composer. Do not add a parallel module.** Each `MODULES`
  entry becomes a registered sentence template (e.g. `module.privacy_saldo@1`) carrying
  the `approvedClaimId`s it rests on, so the Quality Gate, A7's hash and `verify:f4` keep
  working. `hook`, `scene` and `via` cite evidence ids, as the existing citation
  arrays do.
- Tracks map to `ResumeVersion` rows: `ios` → iOS lead, `android` → Android lead, `ai` →
  AI Engineer, `backend` → SDE. The resume row and its `resumeLinkUrl` stay in the
  approval hash.
- New task version, `outreach_draft@3`. Keep `@2` and `@1` registered.

## The spec

```ts
import { z } from "zod";

// Fixed copy. Human-written, verified against approved_claim. The LLM never edits these.

const MODULE_IDS = [
  "privacy_saldo", "correctness_saldo", "honest_aquasense", "voice_aquasense",
  "both_wandr", "safe_airtel", "speed_airtel", "ownership_smartout", "users_examcell",
] as const;
type ModuleId = (typeof MODULE_IDS)[number];

const TRACKS = ["ai", "ios", "android", "backend"] as const;
type Track = (typeof TRACKS)[number];

interface Module {
  text: string;
  project: string;      // two modules from one project never share an email
  tracks: Track[];      // the tracks this module can carry; the email needs at least one match
  lastOnly?: boolean;   // "does both" only reads right in the third slot
}

export const MODULES: Record<ModuleId, Module> = {
  privacy_saldo: {
    project: "saldo", tracks: ["ios", "ai"],
    text: "Saldo (https://github.com/aryamanraj2/Saldo) is about privacy. Its iOS app reads receipts with a Core ML model I trained, entirely on-device with no cloud at all, and it won Apple's Swift Student Challenge.",
  },
  correctness_saldo: {
    project: "saldo", tracks: ["android", "backend"],
    text: "Saldo (https://github.com/aryamanraj2/Saldo) is about getting money right. I rebuilt its Android SMS parser across 9 Indian bank and UPI formats, fixed 13 bugs, like balances read as payments, and made ingest idempotent so a replay never double-counts.",
  },
  honest_aquasense: {
    project: "aquasense", tracks: ["ai"],
    text: "AquaSense (https://youtu.be/8BiOo1TOQ3w) is about honesty. It's an AI vet for fish farms, and every Gemini answer is grounded in a classifier's output, so it can't invent a verdict. It won MLH Brainwave over 200+ teams.",
  },
  voice_aquasense: {
    project: "aquasense", tracks: ["ai", "android"],
    text: "AquaSense (https://youtu.be/8BiOo1TOQ3w) is about voice. Farmers talk to an assistant that streams its replies, remembers the last 10 turns, and shows a clean retry when the connection drops. It won MLH Brainwave over 200+ teams.",
  },
  both_wandr: {
    project: "wandr", tracks: ["ios", "ai"], lastOnly: true,
    // Backed by project.wandr.siri_intent (operator-confirmed 2026-10-04) plus
    // project.wandr.pipeline.
    text: 'Wandr (https://youtu.be/oSe_WBZzuCM) does both. On iOS 27, you open your group chat and say "Hey Siri, plan an outing with Wandr." An App Intent passes the chat in, Apple\'s on-device model ranks real venues, and only deterministic code can lock the plan, so nothing is invented and the chat is never stored.',
  },
  safe_airtel: {
    project: "airtel", tracks: ["ai", "backend"],
    text: "At Bharti Airtel this summer I built an agent that lets engineers query a live VM database in plain English. It's read-only and guardrailed, so it can answer anything and change nothing.",
  },
  speed_airtel: {
    project: "airtel", tracks: ["backend"],
    text: "At Bharti Airtel this summer, dashboards over our VM fleet were slow, so I re-architected the data layer with a migration, composite indexes and cursor pagination, and cut query latency by 30%.",
  },
  ownership_smartout: {
    project: "smartout", tracks: ["ios"],
    text: "For SmartOut, a Canadian company, I rebuilt their iOS app from scratch in Swift, and the app has 50K+ installs. When things broke in the wild, I traced them myself, from what the user saw down to the query.",
  },
  users_examcell: {
    project: "examcell", tracks: ["backend"],
    text: "At NSUT's Examination Cell, invigilator duties and room allocation were done by hand. I built the platform that automates both with constraint solvers, and it now serves 10,000+ students.",
  },
};

const TLDR: Record<Track, (company: string) => string> = {
  ai: (c) => `tldr; I build AI that does the messy part and isn't allowed to make things up. ${c} needs exactly that, and I'd love to help build it.`,
  ios: (c) => `tldr; I build iOS apps where the AI runs on your phone and your data stays there. ${c}'s app will need both, and I'd love to help build it.`,
  android: (c) => `tldr; I build Android apps where the AI runs on your phone and your data stays there. ${c}'s app will need both, and I'd love to help build it.`,
  backend: (c) => `tldr; I like making slow, messy systems fast and correct. ${c} is that problem at a scale I'd love to learn from.`,
};

// Must equal ResumeVersion.hostedUrl for the matching row (src/apply/resumes/resumes-data.ts).
const RESUME: Record<Track, string> = {
  ai: "https://aryamanj.in/resume/ai.pdf",
  ios: "https://aryamanj.in/resume/ios.pdf",
  android: "https://aryamanj.in/resume/android.pdf",
  backend: "https://aryamanj.in/resume/backend.pdf",
};

// From eligibility.internship_window, shortened.
const WINDOW = "I'm looking for an internship from Dec 2026 to Jan 2027, or Jun to Aug 2027.";
const ROUTE = "If this isn't the right inbox, a pointer to whoever handles intern hiring would mean a lot.";

const BANNED_CHARS = ["—", "–"];
const BANNED_PHRASES = [
  "passionate", "excited to", "leverage", "synergy", "i hope this email finds you",
  "cutting-edge", "game-changer", "revolutionize",
];
const MAX_WORDS = 240; // URLs not counted

// The only thing the LLM produces.

const Grounded = (max: number) =>
  z.object({ text: z.string().min(1).max(max), evidenceIds: z.array(z.string()).min(1) });

export const DraftSchema = z.object({
  track: z.enum(TRACKS),
  modules: z.tuple([z.enum(MODULE_IDS), z.enum(MODULE_IDS), z.enum(MODULE_IDS)]),
  subject: z.string().min(10).max(70),
  via: Grounded(60).optional(),   // e.g. "Dev's post"
  hook: Grounded(400),            // product fact restated as the user's problem
  scene: Grounded(300),           // one concrete moment at the company where the work shows up
});
export type Draft = z.infer<typeof DraftSchema>;

export interface EvidenceRow { id: string; companyId: string; text: string; url: string }
export interface Target { companyId: string; companyName: string; firstName?: string; roleInbox: boolean }

const numbersIn = (s: string) => s.match(/\d[\d,.]*%?/g) ?? [];
const sentenceCount = (s: string) => (s.match(/[.!?](\s|$)/g) ?? []).length;
const wordCount = (s: string) => s.split(/\s+/).filter((w) => w && !/^\(?https?:\/\//.test(w)).length;

export function validate(draft: Draft, target: Target, evidence: EvidenceRow[]): string[] {
  const errors: string[] = [];
  const rows = new Map(evidence.filter((r) => r.companyId === target.companyId).map((r) => [r.id, r]));
  const mods = draft.modules.map((id) => MODULES[id]);

  if (new Set(draft.modules).size < 3) errors.push("modules must be distinct");
  if (new Set(mods.map((m) => m.project)).size < 3) errors.push("all three modules must be different projects");
  if (mods[0].lastOnly || mods[1].lastOnly) errors.push("a lastOnly module may only sit in slot 3");
  if (!mods.some((m) => m.tracks.includes(draft.track))) errors.push(`no module carries the "${draft.track}" track`);

  const grounded = { hook: draft.hook, scene: draft.scene, ...(draft.via ? { via: draft.via } : {}) };
  for (const [field, g] of Object.entries(grounded)) {
    const cited = g.evidenceIds.map((id) => rows.get(id));
    if (cited.some((r) => !r)) { errors.push(`${field}: cites an evidence id not on file for this company`); continue; }
    const source = cited.map((r) => r!.text).join(" ");
    for (const n of numbersIn(g.text)) if (!source.includes(n)) errors.push(`${field}: number "${n}" not in cited evidence`);
  }

  if (sentenceCount(draft.hook.text) > 2) errors.push("hook: max 2 sentences");
  if (!draft.scene.text.includes(target.companyName)) errors.push("scene: must name the company");
  for (const n of numbersIn(draft.subject)) errors.push(`subject: no numbers allowed ("${n}")`);

  const llmText = [draft.subject, draft.hook.text, draft.scene.text, draft.via?.text ?? ""].join(" ");
  for (const ch of BANNED_CHARS) if (llmText.includes(ch)) errors.push("no em or en dashes");
  for (const p of BANNED_PHRASES) if (llmText.toLowerCase().includes(p)) errors.push(`banned phrase: "${p}"`);

  if (errors.length === 0) {
    const words = wordCount(assemble(draft, target).body);
    if (words > MAX_WORDS) errors.push(`body is ${words} words, max ${MAX_WORDS}`);
  }
  return errors;
}

// Assembly. Pure string building, no model involved.

export function assemble(draft: Draft, target: Target): { subject: string; body: string; resumeUrl: string } {
  const { companyName: co, firstName, roleInbox } = target;
  const [a, b, c] = draft.modules.map((id) => MODULES[id].text);
  const via = draft.via ? `, writing after ${draft.via.text}` : "";
  const resumeUrl = RESUME[draft.track];

  const body = [
    TLDR[draft.track](co),
    `Hi ${firstName ?? `${co} team`},`,
    `I'm Aryaman, a third-year student at NSUT Delhi${via}. ${draft.hook.text} That's the problem I keep building around.`,
    `${a} ${b}`,
    c,
    draft.scene.text,
    `${WINDOW} My resume is here: ${resumeUrl}. Would love to talk.${roleInbox ? ` ${ROUTE}` : ""}`,
    "Best,\nAryaman\naryamanj.in · github.com/aryamanraj2",
  ].join("\n\n");

  return { subject: draft.subject, body, resumeUrl };
}
```

## Appendix: the operator's Temple email, the style model for `via`, `hook` and `scene`

Hand-written by the operator, for one company. **Use it for style only. Never cite it
as fact.** It shows what the three LLM fields should read like:

- **via:** "writing after Dev's post". A real, specific trigger, taken from evidence.
- **hook:** "Most people will only ever see Temple as a number on their phone. That number
  is personal, it changes every second, and people will want it explained." The
  company's product restated as **its user's problem**, in plain words. Not the
  company's marketing copy.
- **scene:** "For Temple, that means asking Siri why your Entropy spiked this afternoon
  and getting an answer grounded in what the sensor saw, without your data leaving the
  phone." One concrete moment in **their** product, using the product's own names, where
  the candidate's work shows up.

Do not copy three things from it, because the spec supersedes them:

- "It reads bank SMS with a Core ML model I trained and never sends anything off the
  phone" merges Saldo's two builds. Use the spec's `privacy_saldo`.
- "ECE" is dropped, on the operator's instruction.
- "my resume is attached". The system links the resume and never attaches it (H3).

```
Subject: iOS + on-device AI

tldr; I build iOS apps where the AI runs on your phone and isn't allowed to make things up. Temple's app will need both, and I'd love to help build it.

Hi Temple team,

I'm Aryaman, a third-year ECE student at NSUT Delhi, writing after Dev's post. Most people will only ever see Temple as a number on their phone. That number is personal, it changes every second, and people will want it explained. I've been building for exactly that.

Saldo (https://github.com/aryamanraj2/Saldo) keeps data private. It reads bank SMS with a Core ML model I trained and never sends anything off the phone, and it won Apple's Swift Student Challenge. AquaSense (https://youtu.be/8BiOo1TOQ3w) keeps AI honest. A classifier diagnoses sick fish and Gemini only explains the result, and it won MLH Brainwave.

Wandr (https://youtu.be/oSe_WBZzuCM) does both. On iOS 27, you open your group chat and say "Hey Siri, plan an outing with Wandr." An App Intent passes the chat to Wandr, Apple's on-device model picks the stops, and code checks every venue so nothing is invented. The chat never leaves the phone.

For Temple, that means asking Siri why your Entropy spiked this afternoon and getting an answer grounded in what the sensor saw, without your data leaving the phone.

I'm in Delhi, free [WINDOW], and my resume is attached. Would love to talk.

Best,
Aryaman
aryamanj.in · github.com/aryamanraj2
```
