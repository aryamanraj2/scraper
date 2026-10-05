import type { EmailModuleId, EmailTrack, OutreachDraftResponseV3, OutreachDraftResponseV4 } from '../../core/llm/tasks.js'
import { ABBREVIATIONS } from './pitch.js'

/**
 * The operator's own email, `outreach_draft@3` — docs/F6-EMAIL-SPEC.md, ported.
 *
 * Everything here is fixed copy the operator wrote and the orchestrator checked against
 * `approved_claim`. A session never edits it: it picks a track and three modules, and
 * writes only `via`, `hook` and `scene` about the company. The copy reaches a message as
 * registered templates (`templates.ts`), each carrying the claim keys below, and
 * `validateComposition` refuses a module whose text or claims have drifted. So the
 * Quality Gate, A7's hash and `verify:f4` see an ordinary composition.
 *
 * `claimKeys` are this port's addition: the spec's table names the reasoning, these name
 * the rows. Withdraw one and every draft carrying that module stops validating.
 */

export type EmailModule = {
  text: string
  /** Two modules from one project never share an email. */
  project: string
  /** The tracks this module can carry; the email needs at least one match. */
  tracks: EmailTrack[]
  /** "Does both" only reads right in the third slot. */
  lastOnly?: boolean
  claimKeys: string[]
}

export const MODULES: Record<EmailModuleId, EmailModule> = {
  privacy_saldo: {
    project: 'saldo',
    tracks: ['ios', 'ai'],
    claimKeys: ['project.saldo.ios', 'achievement.swift_student_challenge'],
    text: "Saldo (https://github.com/aryamanraj2/Saldo) is about privacy. Its iOS app reads receipts with a Core ML model I trained, entirely on-device with no cloud at all, and it won Apple's Swift Student Challenge.",
  },
  correctness_saldo: {
    project: 'saldo',
    tracks: ['android', 'backend'],
    claimKeys: ['project.saldo.sms_parser', 'project.saldo.idempotent_ingest'],
    text: 'Saldo (https://github.com/aryamanraj2/Saldo) is about getting money right. I rebuilt its Android SMS parser across 9 Indian bank and UPI formats, fixed 13 bugs, like balances read as payments, and made ingest idempotent so a replay never double-counts.',
  },
  honest_aquasense: {
    project: 'aquasense',
    tracks: ['ai'],
    claimKeys: ['project.aquasense.diagnosis', 'project.aquasense.grounding', 'project.aquasense.origin', 'achievement.mlh_brainwave'],
    text: "AquaSense (https://youtu.be/8BiOo1TOQ3w) is about honesty. It's an AI vet for fish farms, and every Gemini answer is grounded in a classifier's output, so it can't invent a verdict. It won MLH Brainwave over 200+ teams.",
  },
  voice_aquasense: {
    project: 'aquasense',
    tracks: ['ai', 'android'],
    claimKeys: ['project.aquasense.voice', 'project.aquasense.origin', 'achievement.mlh_brainwave'],
    text: 'AquaSense (https://youtu.be/8BiOo1TOQ3w) is about voice. Farmers talk to an assistant that streams its replies, remembers the last 10 turns, and shows a clean retry when the connection drops. It won MLH Brainwave over 200+ teams.',
  },
  both_wandr: {
    project: 'wandr',
    tracks: ['ios', 'ai'],
    lastOnly: true,
    claimKeys: ['project.wandr.siri_intent', 'project.wandr.pipeline'],
    text: 'Wandr (https://youtu.be/oSe_WBZzuCM) does both. On iOS 27, you open your group chat and say "Hey Siri, plan an outing with Wandr." An App Intent passes the chat in, Apple\'s on-device model ranks real venues, and only deterministic code can lock the plan, so nothing is invented and the chat is never stored.',
  },
  safe_airtel: {
    project: 'airtel',
    tracks: ['ai', 'backend'],
    claimKeys: ['experience.airtel.role', 'experience.airtel.text_to_sql'],
    text: "At Bharti Airtel this summer I built an agent that lets engineers query a live VM database in plain English. It's read-only and guardrailed, so it can answer anything and change nothing.",
  },
  speed_airtel: {
    project: 'airtel',
    tracks: ['backend'],
    claimKeys: ['experience.airtel.role', 'experience.airtel.openstack'],
    text: 'At Bharti Airtel this summer, dashboards over our VM fleet were slow, so I re-architected the data layer with a migration, composite indexes and cursor pagination, and cut query latency by 30%.',
  },
  ownership_smartout: {
    project: 'smartout',
    tracks: ['ios'],
    claimKeys: ['experience.smartout.role', 'experience.smartout.app', 'experience.smartout.installs', 'experience.smartout.production_triage'],
    text: 'For SmartOut, a Canadian company, I rebuilt their iOS app from scratch in Swift, and the app has 50K+ installs. When things broke in the wild, I traced them myself, from what the user saw down to the query.',
  },
  users_examcell: {
    project: 'examcell',
    tracks: ['backend'],
    claimKeys: ['experience.nsut.role', 'experience.nsut.platform'],
    text: "At NSUT's Examination Cell, invigilator duties and room allocation were done by hand. I built the platform that automates both with constraint solvers, and it now serves 10,000+ students.",
  },
}

/**
 * The opening line per track. Not fixed text, since it names the company, so the choke
 * point checks its claims but not its wording; it is still only ever rendered here.
 *
 * `android` is the one line no claim fully backs: Saldo's Android app sends redacted,
 * low-confidence SMS to Gemini (`project.saldo.ai_fallback`), so "your data stays there"
 * is the defect the spec fixed in `privacy_saldo`. Kept verbatim on the instruction to use
 * the spec exactly, and raised with the operator; no sample uses it.
 */
export const TLDR: Record<EmailTrack, { render: (company: string) => string; claimKeys: string[] }> = {
  ai: {
    render: (c) => `tldr; I build AI that does the messy part and isn't allowed to make things up. ${c} needs exactly that, and I'd love to help build it.`,
    claimKeys: ['voice.ai_rule'],
  },
  ios: {
    render: (c) => `tldr; I build iOS apps where the AI runs on your phone and your data stays there. ${c}'s app will need both, and I'd love to help build it.`,
    claimKeys: ['voice.on_device', 'project.saldo.ios'],
  },
  android: {
    render: (c) => `tldr; I build Android apps where the AI runs on your phone and your data stays there. ${c}'s app will need both, and I'd love to help build it.`,
    claimKeys: ['project.saldo.android', 'project.aquasense.voice'],
  },
  backend: {
    render: (c) => `tldr; I like making slow, messy systems fast and correct. ${c} is that problem at a scale I'd love to learn from.`,
    claimKeys: ['experience.airtel.openstack', 'project.saldo.idempotent_ingest'],
  },
}

/**
 * The resume each track links, by `ResumeVersion.label` (the seeder's upsert key). The
 * EMAIL's track picks it, not the lead's scored track: the old path sent `ai.pdf` with a
 * mobile email to Strava. The row and its `linkUrl` go into the approval hash (A7).
 */
export const RESUME_LABEL: Record<EmailTrack, string> = {
  ios: 'iOS / Android — iOS lead',
  android: 'iOS / Android — Android lead',
  ai: 'AI Engineer',
  backend: 'SDE — backend / systems',
}

export const ROUTE = "If this isn't the right inbox, a pointer to whoever handles intern hiring would mean a lot."

const BANNED_CHARS = ['—', '–']
const BANNED_PHRASES = [
  'passionate', 'excited to', 'leverage', 'synergy', 'i hope this email finds you',
  'cutting-edge', 'game-changer', 'revolutionize',
]
/** URLs not counted. Measured: fixed parts 59 words, three modules 86–124. */
export const MAX_WORDS = 240

export type EmailEvidenceRow = { id: string; companyId: string | null; text: string }
export type EmailTarget = { companyId: string; companyName: string }

const numbersIn = (s: string) => s.match(/\d[\d,.]*%?/g) ?? []
const sentenceCount = (s: string) => (s.match(/[.!?](\s|$)/g) ?? []).length
export const wordCount = (s: string) => s.split(/\s+/).filter((w) => w && !/^\(?https?:\/\//.test(w)).length

/**
 * The spec's `validate()`, unchanged except that the body is passed in: the composer's
 * renderer assembles it, so the count is over exactly what would be sent.
 */
export function validateEmail(
  draft: OutreachDraftResponseV3,
  target: EmailTarget,
  evidence: EmailEvidenceRow[],
  body: string,
): string[] {
  const errors: string[] = []
  const rows = new Map(evidence.filter((r) => r.companyId === target.companyId).map((r) => [r.id, r]))
  const mods = draft.modules.map((id) => MODULES[id])

  if (new Set(draft.modules).size < 3) errors.push('modules must be distinct')
  if (new Set(mods.map((m) => m.project)).size < 3) errors.push('all three modules must be different projects')
  if (mods[0]!.lastOnly || mods[1]!.lastOnly) errors.push('a lastOnly module may only sit in slot 3')
  if (!mods.some((m) => m.tracks.includes(draft.track))) errors.push(`no module carries the "${draft.track}" track`)

  const grounded = { hook: draft.hook, scene: draft.scene, ...(draft.via ? { via: draft.via } : {}) }
  for (const [field, g] of Object.entries(grounded)) {
    const cited = g.evidenceIds.map((id) => rows.get(id))
    if (cited.some((r) => !r)) {
      errors.push(`${field}: cites an evidence id not on file for this company`)
      continue
    }
    const source = cited.map((r) => r!.text).join(' ')
    for (const n of numbersIn(g.text)) if (!source.includes(n)) errors.push(`${field}: number "${n}" not in cited evidence`)
  }

  if (sentenceCount(draft.hook.text) > 2) errors.push('hook: max 2 sentences')
  if (!draft.scene.text.includes(target.companyName)) errors.push('scene: must name the company')
  for (const n of numbersIn(draft.subject)) errors.push(`subject: no numbers allowed ("${n}")`)

  const llmText = [draft.subject, draft.hook.text, draft.scene.text, draft.via?.text ?? ''].join(' ')
  for (const ch of BANNED_CHARS) if (llmText.includes(ch)) errors.push('no em or en dashes')
  for (const p of BANNED_PHRASES) if (llmText.toLowerCase().includes(p)) errors.push(`banned phrase: "${p}"`)

  if (errors.length === 0) {
    const words = wordCount(body)
    if (words > MAX_WORDS) errors.push(`body is ${words} words, max ${MAX_WORDS}`)
  }
  return errors
}

// ── outreach_draft@4: the session writes the paragraphs, code checks the facts ──

/** The links a candidate sentence may carry. The operator's own; no claim spells them out. */
export const PROJECT_LINKS = [
  'https://github.com/aryamanraj2/Saldo',
  'https://youtu.be/8BiOo1TOQ3w',
  'https://youtu.be/oSe_WBZzuCM',
]

/** Capitalised words that are grammar, not facts. A sentence's first word is skipped too. */
const NOT_A_FACT = new Set(['I', "I'm", "I've", "I'd", 'AI', 'TLDR', 'Hey'])

/**
 * Every number, every capitalised name and every link in `text` must appear in `source`,
 * the text of what the sentence cites. `pitch.test.ts`'s rule for the fixed intro, run on
 * the session's sentences at merge time. Returns what is missing.
 *
 * ponytail: lexical, so it catches an invented number, product or employer but not two
 * true claims merged into a false one (Temple's "bank SMS, never leaves the phone").
 * The operator's review is the check for that.
 */
export function factCheck(text: string, source: string): string[] {
  const missing: string[] = []
  const links = text.match(/https?:\/\/\S+/g) ?? []
  for (const l of links) {
    const link = l.replace(/[).,;:]+$/, '')
    if (!PROJECT_LINKS.includes(link) && !source.includes(link)) missing.push(link)
  }
  const prose = text.replace(/https?:\/\/\S+/g, ' ')
  for (const sentence of prose.split(/(?<=[.!?:]["”’)]?)\s+|\n+/)) {
    const tokens = (sentence.match(/\d[\d,.]*\+?%?|\b[A-Z][\w.'’+-]*/g) ?? []).map((t) =>
      t.replace(/[.,;:]+$/, '').replace(/['’]s$/, ''),
    )
    const first = sentence.trim().match(/^["“(]*([A-Za-z][\w'’-]*)/)?.[1]?.replace(/['’]s$/, '')
    for (const t of tokens) {
      if (t === first || NOT_A_FACT.has(t) || t === '') continue
      const bare = t.replace(/\+$/, '')
      const expanded = ABBREVIATIONS[t]
      if (source.includes(t) || source.includes(bare) || (expanded !== undefined && source.includes(expanded))) continue
      missing.push(t)
    }
  }
  return [...new Set(missing)]
}

/**
 * @4 runs longer than @3: Temple is 222 words, and the operator's own Strava email, with
 * the domain-fit line he added, is 278. The cap is his email, not a benchmark's.
 */
export const MAX_WORDS_V4 = 280

/**
 * The rules @4 keeps from the spec, plus the two the operator's Strava review added that
 * code can check: the tldr's platform matches the resume the track links, and nothing
 * the session wrote names a number, name or link its citations do not hold.
 */
export function validateEmailV4(
  draft: OutreachDraftResponseV4,
  target: EmailTarget,
  sources: { evidence: EmailEvidenceRow[]; claims: Map<string, string> },
  body: string,
): string[] {
  const errors: string[] = []
  const rows = new Map(sources.evidence.filter((r) => r.companyId === target.companyId).map((r) => [r.id, r.text]))
  const lines: [string, { text: string; evidenceIds?: string[]; approvedClaimIds?: string[] }][] = [
    ['tldr', draft.tldr],
    ['hook', draft.hook],
    ['scene', draft.scene],
    ...(draft.via ? [['via', draft.via] as [string, typeof draft.via]] : []),
    ...draft.story.map((p, i) => [`story[${i}]`, p] as [string, typeof p]),
  ]
  for (const [field, l] of lines) {
    const ev = (l.evidenceIds ?? []).map((id) => rows.get(id))
    if (ev.some((t) => t === undefined)) {
      errors.push(`${field}: cites an evidence id not on file for this company`)
      continue
    }
    const source = [...ev, ...(l.approvedClaimIds ?? []).map((id) => sources.claims.get(id) ?? ''), target.companyName].join(' \n ')
    const missing = factCheck(l.text, source)
    if (missing.length > 0) errors.push(`${field}: ${missing.map((m) => `"${m}"`).join(', ')} not in what it cites`)
  }

  // The resume the track links is one platform's; the tldr must not promise the other.
  const t = draft.tldr.text
  if (draft.track === 'ios' && /android/i.test(t)) errors.push('tldr: says Android, but the ios track links the iOS resume')
  if (draft.track === 'android' && /\biOS\b/.test(t)) errors.push('tldr: says iOS, but the android track links the Android resume')

  if (sentenceCount(draft.hook.text) > 2) errors.push('hook: max 2 sentences')
  if (!draft.scene.text.includes(target.companyName)) errors.push('scene: must name the company')
  for (const n of numbersIn(draft.subject)) errors.push(`subject: no numbers allowed ("${n}")`)

  const llmText = [draft.subject, t, draft.hook.text, draft.scene.text, draft.via?.text ?? '', ...draft.story.map((p) => p.text)].join(' ')
  for (const ch of BANNED_CHARS) if (llmText.includes(ch)) errors.push('no em or en dashes')
  for (const p of BANNED_PHRASES) if (llmText.toLowerCase().includes(p)) errors.push(`banned phrase: "${p}"`)

  if (errors.length === 0) {
    const words = wordCount(body)
    if (words > MAX_WORDS_V4) errors.push(`body is ${words} words, max ${MAX_WORDS_V4}`)
  }
  return errors
}
