/**
 * The operator's approved claims — the only factual statements this system may make
 * about the candidate, in an application answer (F3) or a draft sentence (F4).
 *
 * ## Where these come from
 *
 * Every claim in the `identity`, `education`, `experience`, `achievement`, `project`
 * and `skill` categories is lifted from one of the operator's own resumes, named in
 * `sourceRef`. That is the candidate-side analogue of `Evidence.sourceUrl`: a
 * statement the system is about to make on the operator's behalf must be traceable
 * to a document the operator wrote, not to a model's recollection of one.
 *
 * `eligibility` claims have no resume behind them — no resume states work
 * authorization or an internship window — so they carry `sourceRef: 'operator'` and
 * were supplied directly. `handover.md` §8 forbids falsely claiming work
 * authorization, remote availability or a graduation date, which is exactly why they
 * are recorded here rather than inferred from a degree start date.
 *
 * ## The two facts that had to be asked for
 *
 * `education.expected_graduation` and `eligibility.internship_window` appear in no
 * resume and cannot be derived from one. `REQUIRED_CLAIM_KEYS` named them so the
 * seeder reported the gap on every run, and every packet left the questions blank
 * with the reason stated, until the operator supplied them.
 *
 * The graduation date is worth dwelling on: the operator's answer is **March 2028**,
 * and "Aug. 2024 plus a four-year B.Tech" would have produced mid-2028. A system that
 * inferred it would have put a wrong date on every application and never flagged it.
 * That is exactly the failure `handover.md` §8's ban on claiming a graduation date
 * exists to prevent, and the mechanism that caught it — name what is required, refuse
 * to guess it, report the gap — is worth keeping for the next fact of this shape.
 *
 * ## Reconciling the resumes
 *
 * Four base resumes describe the same three roles in slightly different words, and
 * two tailored copies broaden one of them. Where they disagree, the canonical form is
 * the one the base resumes agree on:
 *
 *   - **SmartOut title.** All four bases say "iOS Developer (Contract)". The Stripe
 *     and Gesture copies say "Software Engineer (Contract)". Same job, broadened for
 *     a JD; the base spelling is the claim.
 *   - **AquaSense.** Written "Aqua-Sense" in one achievement line and "AquaSense"
 *     everywhere else. One spelling, the majority one.
 */

export type ApprovedClaimSeed = {
  key: string
  category: ClaimCategory
  text: string
  sourceRef: string
}

export const CLAIM_CATEGORIES = [
  'identity',
  'education',
  'experience',
  'achievement',
  'project',
  'skill',
  'eligibility',
  // F6 step 3b: how the operator describes their own work, in their own words. Not a
  // credential, so not offered to the LLM's candidate sentences; the composer quotes it.
  'voice',
] as const

export type ClaimCategory = (typeof CLAIM_CATEGORIES)[number]

const MAIN = 'resumes/Main resume.tex'
const IOS = 'resumes/Resume_IOS.tex'
const ANDROID = 'resumes/Resume_android.tex'
const BACKEND = 'resumes/Resume_backend.tex'
const OPERATOR = 'operator'
// F6 step 3b: the operator's project and experience dossier, compiled 2026-10-04 from the
// repos, every resume version and public pages, separating what each source verifies.
// Where it corrects a resume line, the dossier wins and the claim says so.
const DOSSIER = 'operator: dossier 2026-10-04'
// The operator's corrections to the dossier itself, same day. Where they disagree, these win.
const OPERATOR_CONFIRMED = 'operator: confirmed 2026-10-04'

export const APPROVED_CLAIMS: ApprovedClaimSeed[] = [
  // --- identity ------------------------------------------------------------
  { key: 'identity.full_name', category: 'identity', sourceRef: MAIN, text: 'Aryaman Raj Jaiswal' },
  { key: 'identity.email', category: 'identity', sourceRef: MAIN, text: 'aryamanj250@gmail.com' },
  { key: 'identity.phone', category: 'identity', sourceRef: MAIN, text: '+91 9136816530' },
  { key: 'identity.github', category: 'identity', sourceRef: MAIN, text: 'https://github.com/aryamanraj2' },
  { key: 'identity.portfolio', category: 'identity', sourceRef: MAIN, text: 'https://aryamanj.in' },
  {
    key: 'identity.linkedin',
    category: 'identity',
    sourceRef: MAIN,
    // The operator's own profile URL, quoted from their own resume. Nothing in this
    // system ever fetches it: handover.md §1.4 bans automating LinkedIn, and the
    // FetchPolicyGate denylist refuses the host at the transport layer regardless of
    // where the string came from.
    text: 'https://www.linkedin.com/in/aryamanrajjaiswal',
  },
  { key: 'identity.location', category: 'identity', sourceRef: MAIN, text: 'Delhi, India' },

  // --- education -----------------------------------------------------------
  {
    key: 'education.degree',
    category: 'education',
    sourceRef: MAIN,
    text: 'Bachelor of Technology in Electronics and Communications at Netaji Subhas University of Technology, Dwarka, Delhi (Aug. 2024 - Present).',
  },
  {
    key: 'education.expected_graduation',
    category: 'education',
    sourceRef: OPERATOR,
    // Operator-stated, and worth noting that it is NOT what the degree start date
    // implies: "Aug. 2024 + four years" would have produced mid-2028, and a system
    // that inferred it would have put a wrong date on 37 applications. This is the
    // case handover.md §8's ban on claiming a graduation date exists for.
    text: 'Expected to graduate in March 2028.',
  },

  // --- experience ----------------------------------------------------------
  {
    key: 'experience.airtel.role',
    category: 'experience',
    sourceRef: MAIN,
    text: 'Software Engineer Intern at Bharti Airtel Limited, Gurugram, India (June 2026 - Aug. 2026).',
  },
  {
    key: 'experience.airtel.openstack',
    category: 'experience',
    sourceRef: MAIN,
    text: 'Re-architected an internal OpenStack platform tracking live and historical state across a distributed VM fleet; cut dashboard query latency by 30% via database migration, composite indexing, and cursor-based pagination.',
  },
  {
    key: 'experience.airtel.text_to_sql',
    category: 'experience',
    sourceRef: OPERATOR_CONFIRMED,
    text: "Designed a guardrailed natural-language interface over a production VM database: a LangChain-orchestrated, read-only text-to-SQL agent with NeMo Guardrails input/output rails, served over a REST API on self-hosted Ollama LLMs, so no agent path can mutate or exfiltrate fleet state.",
  },
  {
    key: 'experience.airtel.surge_analysis',
    category: 'experience',
    sourceRef: MAIN,
    text: 'Shipped an AI surge-analysis workflow that flags anomalous provisioning spikes across a VM fleet and summarizes probable root causes for on-call engineers.',
  },
  {
    key: 'experience.smartout.role',
    category: 'experience',
    sourceRef: DOSSIER,
    text: "Software Engineer (Contract) at SmartOut Media (Canada), working remotely (Jan. 2026 - Present).",
  },
  {
    key: 'experience.smartout.app',
    category: 'experience',
    sourceRef: OPERATOR_CONFIRMED,
    text: "Rebuilt the SmartOut iOS app from scratch in native Swift and SwiftUI, replacing an earlier, minimal Flutter build, added features including sign-up and outfitters, and republished it: an offline-first geospatial app for Ontario hunting and fishing regulations, over a bundled SQLite dataset and a GRDB store with versioned migrations, instrumented with GA4 analytics and Crashlytics.",
  },
  {
    key: 'experience.smartout.maps',
    category: 'experience',
    sourceRef: IOS,
    text: 'Engineered a map layer with the Google Maps SDK and GEOSwift: 456 regulatory polygons with MULTIPOLYGON and interior-hole support, distance-based marker clustering, polygon hit-testing, and deep links that restore the exact zone, tab, and regulation row across app launches.',
  },
  {
    key: 'experience.smartout.production_triage',
    category: 'experience',
    sourceRef: BACKEND,
    text: 'Triaged and resolved live production issues end to end, from UI symptom through the network layer to the underlying query.',
  },
  {
    key: 'experience.nsut.role',
    category: 'experience',
    sourceRef: MAIN,
    text: 'Software Developer Intern at the Examination Cell, NSUT, Delhi, India (May 2025 - Aug. 2025).',
  },
  {
    key: 'experience.nsut.platform',
    category: 'experience',
    sourceRef: MAIN,
    text: 'Architected a Next.js and Flask automation platform serving 10,000+ students, cutting manual data entry by 70% with Pandas-driven constraint solvers for invigilator assignment and room allocation.',
  },
  {
    key: 'experience.nsut.nsutrack',
    category: 'experience',
    sourceRef: MAIN,
    text: 'Shipped NSUTrack, native Android and iOS clients centralizing schedules, attendance, and society notices for 1,500+ students, with an offline-first cache refreshed by WorkManager sync and FCM push.',
  },

  // --- achievements --------------------------------------------------------
  {
    key: 'achievement.swift_student_challenge',
    category: 'achievement',
    sourceRef: DOSSIER,
    text: "Apple Swift Student Challenge Winner (2026), selected among the top global student developers for Saldo's iOS app, an on-device personal finance app that does receipt scanning and spend insights entirely offline.",
  },
  {
    key: 'achievement.mlh_brainwave',
    category: 'achievement',
    sourceRef: MAIN,
    text: 'Winner, MLH Brainwave 2.0 (DTU): led Team Aquacult to 1st place over 200+ teams, sweeping Best Overall Project, Best Use of Gemini, and Best UI/UX Runner-Up.',
  },
  {
    key: 'achievement.hackonhills',
    category: 'achievement',
    sourceRef: MAIN,
    text: '2x Winner, HackonHills (2024, 2025): back-to-back 1st-place finishes among 125+ teams, building AquaSense (AI/IoT) and HimYatra (Mobile/Web) end to end.',
  },

  // --- projects ------------------------------------------------------------
  {
    key: 'project.saldo.ios',
    category: 'project',
    sourceRef: OPERATOR_CONFIRMED,
    text: "Saldo started as an iOS-only app and won Apple's Swift Student Challenge 2026. It scans a receipt and extracts the amount completely offline with VisionKit OCR and a Core ML model he trained himself (the challenge allows only Apple frameworks), adds insights with Apple Foundation Models, and uses Vision subject masking for savings goals, with zero cloud dependency and no third-party dependencies.",
  },
  {
    key: 'project.saldo.android',
    category: 'project',
    sourceRef: ANDROID,
    text: 'Built the native Android version of Saldo from scratch in Kotlin and Jetpack Compose, having first conceived it as an iOS app in Swift and SwiftUI.',
  },
  {
    key: 'project.saldo.sms_parser',
    category: 'project',
    sourceRef: DOSSIER,
    text: "Rebuilt the bank-SMS transaction parser in Saldo's Android app as a staged rule engine over 9 Indian bank/UPI templates, fixing 13 correctness defects including quoted account balances misattributed as transaction amounts and Rs. 0 rows that corrupted every dashboard aggregate.",
  },
  {
    key: 'project.saldo.golden_corpus',
    category: 'project',
    sourceRef: ANDROID,
    text: 'Wrote a 41-case golden corpus with a regression test per defect, growing the Saldo test suite from 0 to 57 passing tests.',
  },
  {
    key: 'project.saldo.idempotent_ingest',
    category: 'project',
    sourceRef: BACKEND,
    text: 'Designed idempotent SMS ingest keyed on a content hash with a watermark advancing only after commit, making replays safe and replacing a full-inbox rescan that ran twice per launch on the main thread.',
  },
  {
    key: 'project.saldo.r8',
    category: 'project',
    sourceRef: ANDROID,
    text: 'Migrated Saldo to AGP 9, Kotlin 2.3 and compileSdk 37 with Navigation 3, Room and Hilt, and enabled R8 with keep rules, cutting the release APK from 32 MB to 5.1 MB.',
  },
  {
    key: 'project.wandr.pipeline',
    category: 'project',
    sourceRef: IOS,
    text: 'Engineered an actor-isolated seven-stage planning pipeline (extract, normalize, research, resolve, curate, validate, schedule) in Wandr where Foundation Models return array indices only into a pre-vetted deck - never names, prices, or hours - under @Generable/@Guide constrained decoding with a 12s TaskGroup timeout, and deterministic validation alone may mint a plan.',
  },
  {
    key: 'project.wandr.tests',
    category: 'project',
    sourceRef: DOSSIER,
    text: "Covered Wandr with 369 Swift Testing tests, including a golden evaluation that scores 15 realistic host phrasings as a set.",
  },
  {
    key: 'project.wandr.network_framework',
    category: 'project',
    sourceRef: IOS,
    text: 'Built Wandr’s real-time multiplayer layer directly on Network.framework with zero third-party dependencies - an NWConnection WebSocket client against an NWListener relay - bridging callbacks into an AsyncStream consumed by a @MainActor @Observable room, with a generation counter retiring stale callbacks so a cancel cannot double-schedule a reconnect, 0.25s to 4s backoff, identity replay, and an offline outbox flushed on reconnect.',
  },
  {
    key: 'project.wandr.no_authority_relay',
    category: 'project',
    sourceRef: IOS,
    text: 'Designed Wandr’s relay to hold no authority: it rebroadcasts a versioned snapshot and every device folds it through the same pure tally (plurality, quorum gate, deterministic ties), so all clients converge on the identical decided schedule without exchanging a winner.',
  },
  {
    key: 'project.wandr.constraint_ladder',
    category: 'project',
    sourceRef: BACKEND,
    text: 'Designed a constraint-ladder resolver that relaxes the least critical rule first (setting, budget, time, stops) while never relaxing dietary or accessibility constraints, so planning cannot dead-end.',
  },
  {
    key: 'project.aquasense.grounding',
    category: 'project',
    sourceRef: DOSSIER,
    text: "Engineered a hybrid Random Forest and Gemini pipeline in AquaSense that grounds every LLM claim in classifier output, eliminating hallucinated water-toxicity verdicts; the hackathon build served it from a Flask API, and the current system runs on a FastAPI backend, to native SwiftUI and Kotlin clients.",
  },
  {
    key: 'project.aquasense.android',
    category: 'project',
    sourceRef: ANDROID,
    text: 'Built the AquaSense Android client in Kotlin and Jetpack Compose on MVVM plus repository: Retrofit REST and a WebSocket voice agent, CameraX disease capture, and an offline-first Room cache refreshed by WorkManager sync driving StateFlow recomposition.',
  },
  {
    key: 'project.aquasense.voice',
    category: 'project',
    sourceRef: ANDROID,
    text: 'Shipped a zero-cost voice assistant in AquaSense on on-device SpeechRecognizer with streamed base64 MP3 playback via ExoPlayer, keep-alive ping/pong, 10-turn session memory, and typed error codes mapped to retryable UI states.',
  },
  {
    key: 'project.aquasense.ios_voice',
    category: 'project',
    sourceRef: IOS,
    text: 'Built the AquaSense SwiftUI client with a fully on-device voice assistant using the Speech framework for transcription and AVSpeechSynthesizer for playback, over a stateless FastAPI backend.',
  },

  // --- skills (grouped lines, as the resumes group them) --------------------
  {
    key: 'skill.languages',
    category: 'skill',
    sourceRef: MAIN,
    text: 'Languages: Swift, Kotlin, Java, Python, Go, C/C++, JavaScript/TypeScript, SQL (PostgreSQL), Dart, HTML/CSS.',
  },
  {
    key: 'skill.ios',
    category: 'skill',
    sourceRef: IOS,
    text: 'iOS: SwiftUI, UIKit, Swift Concurrency (actors, async/await, AsyncStream, Sendable), Network.framework, App Intents, Core ML, Vision, VisionKit, Speech, AVFoundation, MapKit / Google Maps SDK, Core Data, GRDB/SQLite.',
  },
  {
    key: 'skill.android',
    category: 'skill',
    sourceRef: ANDROID,
    text: 'Android: Jetpack Compose, Coroutines/Flow, Room, Hilt, Navigation 3, WorkManager, DataStore, Retrofit, CameraX, JUnit, R8.',
  },
  {
    key: 'skill.backend',
    category: 'skill',
    sourceRef: BACKEND,
    text: 'Backend: REST API design, WebSockets, Node.js, Flask, FastAPI, Next.js, PostgreSQL, SQLite, Docker, OpenStack, schema migrations, indexing, idempotency, pagination.',
  },
  {
    key: 'skill.ai_ml',
    category: 'skill',
    sourceRef: BACKEND,
    text: 'AI/ML: LangChain, LangGraph, agentic workflows, multi-agent orchestration, RAG, Text-to-SQL, NeMo Guardrails, Ollama, Vertex AI, Gemini, Random Forest, Core ML, Foundation Models (on-device).',
  },
  {
    key: 'skill.testing',
    category: 'skill',
    sourceRef: IOS,
    text: 'Testing and tooling: Swift Testing, XCTest, JUnit, golden-corpus regression testing, Instruments, OSLog / signposts, TestFlight and App Store release, Xcode, Android Studio, Git/GitHub, Postman.',
  },
  {
    key: 'skill.cs_fundamentals',
    category: 'skill',
    sourceRef: BACKEND,
    text: 'CS fundamentals: Data Structures and Algorithms, System Design, Distributed Systems, Concurrency, Database Design, OOP.',
  },
  {
    key: 'skill.ai_tooling',
    category: 'skill',
    sourceRef: 'Applied Resume/Stripe/resume_stripe.tex',
    text: 'Uses Claude Code, Cursor and Codex daily, reviewing every output before it lands.',
  },

  // --- eligibility (operator-stated; no resume asserts any of this) ---------
  {
    key: 'eligibility.work_authorization_india',
    category: 'eligibility',
    sourceRef: OPERATOR,
    text: 'Authorized to work in India without sponsorship.',
  },
  {
    key: 'eligibility.sponsorship_required_abroad',
    category: 'eligibility',
    sourceRef: OPERATOR,
    text: 'Would require visa sponsorship to work on-site in the United States, the United Kingdom, the European Union, or Canada.',
  },
  {
    key: 'eligibility.remote',
    category: 'eligibility',
    sourceRef: OPERATOR,
    text: 'Available to work remotely for roles based outside India, and on-site for roles in India.',
  },
  {
    key: 'eligibility.target_regions',
    category: 'eligibility',
    sourceRef: OPERATOR,
    text: 'Seeking software engineering internships in India first, and remote-viable roles with companies in the United Kingdom, the United States, Europe and Canada.',
  },
  {
    key: 'eligibility.internship_window',
    category: 'eligibility',
    sourceRef: OPERATOR,
    // Two windows, both stated by the operator. Kept as two rather than collapsed to
    // "flexible": an application form asking when you can start deserves the actual
    // dates, and "flexible" is a claim about availability the operator did not make.
    text: 'Available for an internship from December 2026 through January 2027, or from June 2027 through August 2027.',
  },
  {
    key: 'voice.hook',
    category: 'voice',
    // The opening line of the operator's own cover letter. A claim rather than template
    // text because it is a statement about the candidate, and every such statement
    // traces to something the operator wrote (F3 §4.1). The TL;DR quotes it.
    sourceRef: 'operator: cover letter',
    text: 'Most of what I build starts as a complaint in a group chat.',
  },
  {
    key: 'voice.ai_rule',
    category: 'voice',
    // The rule the operator's cover letter says runs through their AI projects. The AI
    // story sentences lead with it, so it is a claim they cite rather than template text.
    sourceRef: 'operator: cover letter',
    text: "Let the AI handle the messy part, but don't let it make things up.",
  },
  // F6 step 3b, fourth pass. The operator supplied three sample drafts on 2026-10-04 and
  // confirmed the details below as true. Each is recorded so a session can cite it
  // rather than invent something like it for another company.
  {
    key: 'education.year_of_study',
    category: 'education',
    sourceRef: OPERATOR,
    text: 'Third-year B.Tech student at Netaji Subhas University of Technology in the 2026-27 academic year.',
  },
  {
    key: 'eligibility.internship_window_short',
    category: 'eligibility',
    // The same two windows as eligibility.internship_window, in the operator's own
    // short form from the sample drafts. The message quotes it verbatim.
    sourceRef: 'operator: sample drafts',
    text: "I'm free Dec 2026 to Jan 2027, or Jun to Aug 2027.",
  },
  {
    key: 'experience.airtel.latency_effort',
    category: 'experience',
    sourceRef: OPERATOR,
    text: 'Spent weeks on database indexes and pagination at Bharti Airtel to cut dashboard query latency by 30%, and that work was the best part of the internship.',
  },
  {
    key: 'experience.smartout.no_signal',
    category: 'experience',
    sourceRef: OPERATOR,
    text: "SmartOut keeps Ontario's hunting and fishing rules available offline for people with no signal.",
  },
  {
    key: 'voice.on_device',
    category: 'voice',
    sourceRef: OPERATOR,
    text: "I build iOS apps that keep the user's data on their phone.",
  },
  {
    key: 'voice.annoyed',
    category: 'voice',
    sourceRef: 'operator: sample drafts',
    text: 'I build things because something annoyed me.',
  },
  {
    key: 'voice.model_serving',
    category: 'voice',
    sourceRef: 'operator: sample drafts',
    text: 'The deeper I go, the more I think how a model is served matters as much as which model it is.',
  },
  {
    key: 'voice.llm_trust',
    category: 'voice',
    sourceRef: 'operator: sample drafts',
    text: "I didn't trust an LLM to guess at fish disease, so in AquaSense a classifier makes the call and Gemini only explains it.",
  },
  {
    key: 'voice.databases',
    category: 'voice',
    sourceRef: 'operator: sample drafts',
    text: 'I like databases more than most people my age probably should.',
  },
  {
    key: 'voice.bank_sms',
    category: 'voice',
    sourceRef: DOSSIER,
    text: "My bank SMS felt like nobody's business, so Saldo's Android app parses it on the phone with a rule engine, and only redacted, low-confidence messages ever reach a cloud model.",
  },
  // From the dossier, as the operator corrected it. Withdrawn: Wandr's 12% -> 72% figure
  // (not found) and the Cloudflare/Supabase lobby (a teammate's first backend, replaced in
  // the operator's version; credited below). seedApprovedClaims deactivates them, never
  // deletes them. The operator confirmed the AquaSense LangChain layer and the Google
  // Places retrieval as his own, so both stay.
  {
    key: 'project.wandr.hybrid_retrieval',
    category: 'project',
    // Withdrawn on the dossier's reading, restored on the operator's word: his own work.
    sourceRef: OPERATOR_CONFIRMED,
    text: 'Built hybrid retrieval over the live Google Places and Routes APIs behind a swappable VenueResearching protocol.',
  },
  {
    key: 'project.wandr.siri_intent',
    category: 'project',
    // Confirmed by the operator on 2026-10-04 as built and built entirely by him (not
    // part of the team hackathon origin). Backs the both_wandr module in F6-EMAIL-SPEC.
    sourceRef: OPERATOR_CONFIRMED,
    text: 'Built Wandr\'s Siri flow on iOS 27, entirely by himself: in a group chat the user says "Hey Siri, plan an outing with Wandr", an App Intent passes the chat in, Apple\'s on-device model ranks real venues, only deterministic code can lock the plan, and the chat is never stored.',
  },
  {
    key: 'project.aquasense.multi_agent',
    category: 'project',
    // The dossier found LangChain in no repo's code; the operator confirmed it was used.
    sourceRef: OPERATOR_CONFIRMED,
    text: 'Built a multi-agent LangChain layer of three routable specialists in AquaSense: a health agent over live telemetry, a disease agent running computer-vision diagnosis on fish images, and a marketplace agent turning any flagged condition into a curated in-app cart.',
  },
  {
    key: 'project.wandr.team_origin',
    category: 'project',
    sourceRef: OPERATOR_CONFIRMED,
    text: "Wandr began as a team hackathon project whose first multiplayer backend a teammate built on Cloudflare Durable Objects and Supabase Realtime; Aryaman's own version replaced it with multiplayer built entirely on iOS with Network.framework, so friends form a room, like in Among Us, and vote on the places.",
  },
  {
    key: 'project.aquasense.diagnosis',
    category: 'project',
    sourceRef: DOSSIER,
    text: 'In AquaSense a farmer photographs a sick fish and a TensorFlow classifier diagnoses it, a scikit-learn Random Forest predicts water quality from pond sensors, and a marketplace flow turns a flagged condition into a shopping cart.',
  },
  {
    key: 'project.aquasense.hardware',
    category: 'project',
    sourceRef: DOSSIER,
    text: 'AquaSense has a hardware reflex tier: an ESP32-S3 sentinel node reading pH, turbidity, dissolved oxygen and temperature, driving an aerator and a pH doser, with LoRa telemetry. Backend commands are requests, not orders: the node can refuse anything that violates a local safety interlock, dissolved oxygen below 4.0 mg/L forces the aerator on, doses are capped, and a refused safety-critical command escalates to a human with no retry.',
  },
  {
    key: 'project.aquasense.team',
    category: 'project',
    sourceRef: DOSSIER,
    text: 'AquaSense was a team project: Aryaman led Team Aquacult at MLH Brainwave 2.0, and later carried AquaSense to completion.',
  },
  {
    key: 'project.saldo.ai_fallback',
    category: 'project',
    sourceRef: DOSSIER,
    text: "In Saldo's Android app the deterministic parser handles most bank SMS; only low-confidence messages are batched to Gemini via Firebase AI Logic with structured output and a closed category enum, redacted before leaving the device, with App Check so no API key ships in the APK, and every AI path degrades to the on-device result.",
  },
  {
    key: 'achievement.hackerrank_orchestrate',
    category: 'achievement',
    sourceRef: DOSSIER,
    text: 'Placed in the top 60 of 3,000+ at HackerRank Orchestrate (Sept 2026), building in 24 hours an AI financial agent that advises paying in full, in installments, or waiting.',
  },
  {
    key: 'experience.smartout.installs',
    category: 'experience',
    sourceRef: DOSSIER,
    // Scope unconfirmed in the dossier: the iOS app alone or both platforms. Stated
    // about the app, so it is true either way.
    text: 'The SmartOut app has 50K+ installs.',
  },
  {
    key: 'project.aquasense.origin',
    category: 'project',
    // Stated by the operator on 2026-10-04: AquaSense and Team Aquacult's project are the
    // same build. Without this, achievement.mlh_brainwave (Team Aquacult) and the
    // AquaSense claims could only be placed side by side, never joined.
    sourceRef: OPERATOR,
    text: 'AquaSense, also called Aquacult, was first conceived at an event at IIT Delhi and later presented at MLH Brainwave 2.0, where Team Aquacult took 1st place over 200+ teams.',
  },
]

/**
 * Claims a complete packet would like to cite but which the operator has not yet
 * supplied. They are named rather than guessed: `handover.md` §8 forbids falsely
 * claiming a graduation date or an availability window, and inferring "Aug. 2024 +
 * four years" from a degree start date is exactly that kind of guess.
 *
 * `seedApprovedClaims` reports whichever of these are still missing, and any packet
 * question that needs one is recorded as unanswered rather than answered wrongly.
 */
export const REQUIRED_CLAIM_KEYS = [
  'education.expected_graduation',
  'eligibility.internship_window',
] as const

export function missingRequiredClaimKeys(present: ReadonlySet<string>): string[] {
  return REQUIRED_CLAIM_KEYS.filter((key) => !present.has(key))
}
