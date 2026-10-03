import * as fs from "fs";
import * as path from "path";

// --- API Credentials ---
// Env only. `origin` is a public GitHub repository, so a literal key here is one
// `git add` away from being published.
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; export it before running this tool`);
  return value;
}

const SNOV_USER_ID = required("SNOV_USER_ID");
const SNOV_SECRET = required("SNOV_SECRET");

const TARGETS_CSV = path.resolve("data/mobile-targets.csv");
const CONTACTS_CSV = path.resolve("data/mobile-contacts.csv");
const HUNTER_CACHE_DIR = path.resolve("data/hunter-cache");
const SNOV_CACHE_DIR = path.resolve("data/snov-cache");

if (!fs.existsSync(SNOV_CACHE_DIR)) {
  fs.mkdirSync(SNOV_CACHE_DIR, { recursive: true });
}

// --- CSV Helper ---
function escapeCsv(val: any): string {
  if (val === null || val === undefined) return "";
  const s = String(val).trim();
  if (s.includes(",") || s.includes("\"") || s.includes("\n")) {
    return `"${s.replace(/"/g, "\"\"")}"`;
  }
  return s;
}

// --- Filtering Rules: STRICTLY PURE NATIVE iOS ONLY ---

// Rule 1: DO NOT include cross-platform frameworks (NO Flutter, NO React Native) AND NO Android
const EXCLUDED_FRAMEWORKS_AND_ANDROID = /\b(flutter|react[-\s]?native|cross[-\s]?platform|hybrid|xamarin|cordova|ionic|phonegap|android|kotlin|jetpack\s+compose)\b/i;

// Rule 3: DO NOT pick non-engineering and non-recruiting roles
const EXCLUDED_NON_ENG_REGEX = /\b(sales|marketing|growth|account\s+exec|account\s+executive|customer\s+support|customer\s+success|client\s+success|finance|financial|accountant|accounting|legal|counsel|operations|business\s+dev|bizdev|copywriter|content|seo|social\s+media|community\s+manager|office\s+manager|receptionist|executive\s+assistant|chief\s+of\s+staff)\b/i;

// Priority 1: Technical Recruiter / Talent Acquisition Specialist / Talent Partner
const RECRUITER_REGEX = /\b(technical\s+recruiter|tech\s+recruiter|engineering\s+recruiter|talent\s+acquisition|talent\s+partner|talent\s+lead|head\s+of\s+talent|recruiter|recruiting|talent|sourcer)\b/i;

// Priority 2 & 3: Dedicated Native iOS Specialists: iOS Engineer, iOS Developer, Swift, SwiftUI, UIKit, Objective-C, Lead iOS, Head of iOS, iOS Architect
const DEDICATED_IOS_REGEX = /\b(ios|swift\b|swiftui|uikit|objective-c|objc|head\s+of\s+ios|ios\s+lead|lead\s+ios|staff\s+ios|senior\s+ios|principal\s+ios|ios\s+engineer|ios\s+developer|ios\s+architect)\b/i;

// Priority 2 & 3 (Secondary): Technical Leadership: Engineering Manager, VP of Engineering, CTO, or Technical Founder / CEO
const TECH_LEADERSHIP_REGEX = /\b(vp\s+of\s+engineering|vice\s+president.*engineering|head\s+of\s+engineering|director\s+of\s+engineering|engineering\s+manager|engineering\s+lead|cto\b|chief\s+technology\s+officer|technical\s+cofounder|technical\s+co-founder|technical\s+founder)\b/i;

// Rule 4: Skip personal webmail addresses
const PERSONAL_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com",
  "proton.me", "protonmail.com", "mail.ru", "aol.com", "zoho.com", "live.com"
]);

function isEmailValidForDomain(email: string, companyDomain: string): boolean {
  if (!email || !email.includes("@")) return false;
  const parts = email.split("@");
  if (parts.length !== 2) return false;
  const emailDomain = parts[1].toLowerCase().trim();
  if (PERSONAL_DOMAINS.has(emailDomain)) return false;
  const compDomain = companyDomain.toLowerCase().trim();
  return emailDomain === compDomain || emailDomain.endsWith("." + compDomain);
}

// --- Snov.io Token & API Client ---
let cachedSnovToken: string | null = null;
let snovTokenExpiry = 0;

async function getSnovToken(): Promise<string> {
  const now = Date.now();
  if (cachedSnovToken && now < snovTokenExpiry) {
    return cachedSnovToken;
  }

  const res = await fetch("https://api.snov.io/v1/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: SNOV_USER_ID,
      client_secret: SNOV_SECRET
    })
  });

  const json: any = await res.json();
  if (!json.access_token) {
    throw new Error(`Snov authentication failed: ${JSON.stringify(json)}`);
  }

  cachedSnovToken = json.access_token;
  // Expire 5 minutes early
  snovTokenExpiry = now + ((json.expires_in || 3600) - 300) * 1000;
  return cachedSnovToken!;
}

async function getSnovBalance(): Promise<number> {
  try {
    const token = await getSnovToken();
    const res = await fetch("https://api.snov.io/v1/get-balance", {
      headers: { Authorization: `Bearer ${token}` }
    });
    const json: any = await res.json();
    return parseFloat(json.data?.balance || "0");
  } catch (err: any) {
    console.error("Failed to check Snov balance:", err.message);
    return 0;
  }
}

async function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface SnovProspect {
  first_name: string;
  last_name: string;
  position: string;
  source_page: string;
  search_emails_start?: string;
}

async function searchSnovProspects(domain: string): Promise<SnovProspect[]> {
  const cacheFile = path.join(SNOV_CACHE_DIR, `${domain}_prospects.json`);
  if (fs.existsSync(cacheFile)) {
    try {
      return JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
    } catch {
      // ignore
    }
  }

  const token = await getSnovToken();
  const startRes = await fetch("https://api.snov.io/v2/domain-search/prospects/start", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ domain })
  });

  const startJson: any = await startRes.json();
  const taskHash = startJson.meta?.task_hash || startJson.task_hash;
  if (!taskHash) {
    console.warn(`[Snov] No task_hash returned for ${domain}:`, startJson);
    return [];
  }

  // Poll for result
  let prospects: SnovProspect[] = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    await delay(2000);
    const resultRes = await fetch(`https://api.snov.io/v2/domain-search/prospects/result/${taskHash}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const resultJson: any = await resultRes.json();
    if (resultJson.status === "completed" || Array.isArray(resultJson.data)) {
      prospects = resultJson.data || [];
      break;
    }
  }

  if (prospects.length > 0) {
    fs.writeFileSync(cacheFile, JSON.stringify(prospects, null, 2));
  }
  return prospects;
}

interface VerifiedEmailResult {
  email: string;
  status: string;
}

async function resolveSnovEmail(searchEmailsStartUrl: string): Promise<VerifiedEmailResult | null> {
  const token = await getSnovToken();
  const startRes = await fetch(searchEmailsStartUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` }
  });
  const startJson: any = await startRes.json();
  const taskHash = startJson.meta?.task_hash || startJson.task_hash;
  if (!taskHash) return null;

  for (let attempt = 0; attempt < 5; attempt++) {
    await delay(1800);
    const resultRes = await fetch(`https://api.snov.io/v2/domain-search/prospects/search-emails/result/${taskHash}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const resultJson: any = await resultRes.json();
    if (resultJson.status === "completed" && resultJson.data?.emails) {
      const validEmail = resultJson.data.emails.find((e: any) => e.smtp_status === "valid" || e.status === "verified");
      if (validEmail) {
        return {
          email: validEmail.email,
          status: validEmail.smtp_status || "valid"
        };
      }
      return null;
    }
  }
  return null;
}

// --- Candidate Selection Structure ---
interface PickedContact {
  domain: string;
  email: string;
  full_name: string;
  title: string;
  contact_type: "named_talent" | "named_employee";
  provider: "snov" | "hunter";
  source_url: string;
  notes: string;
  email_status: string;
  priority: number; // 1: Recruiter, 2: Native iOS, 3: Tech Leadership
}

// --- Main Enrichment Engine ---
async function processHunterCache(domain: string): Promise<PickedContact[]> {
  const cacheFile = path.join(HUNTER_CACHE_DIR, `${domain}.json`);
  if (!fs.existsSync(cacheFile)) return [];

  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
    const emails = raw.data?.emails || [];
    const validEmails = emails.filter((e: any) => {
      if (!e.value || !isEmailValidForDomain(e.value, domain)) return false;
      // Work email must be verified by provider
      if (e.verification?.status !== "valid") return false;
      const title = (e.position || e.position_raw || "").trim();
      // Exclude cross-platform and Android
      if (EXCLUDED_FRAMEWORKS_AND_ANDROID.test(title)) return false;
      // Exclude non-engineering/non-recruiting
      if (EXCLUDED_NON_ENG_REGEX.test(title)) return false;
      return true;
    });

    let recruiter: any = null;
    const iosEngineers: any[] = [];
    const techLeaders: any[] = [];

    for (const p of validEmails) {
      const title = (p.position || p.position_raw || "").trim();
      const dept = (p.department || "").toLowerCase();

      if (!recruiter && (RECRUITER_REGEX.test(title) || dept === "hr")) {
        recruiter = p;
      } else if (DEDICATED_IOS_REGEX.test(title)) {
        iosEngineers.push(p);
      } else if (TECH_LEADERSHIP_REGEX.test(title)) {
        techLeaders.push(p);
      }
    }

    const picks: PickedContact[] = [];
    if (recruiter) {
      picks.push({
        domain,
        email: recruiter.value,
        full_name: `${recruiter.first_name || ""} ${recruiter.last_name || ""}`.trim(),
        title: recruiter.position || recruiter.position_raw || "Technical Recruiter",
        contact_type: "named_talent",
        provider: "hunter",
        source_url: recruiter.linkedin || "",
        notes: "Hunter verified cache hit",
        email_status: recruiter.verification?.status || "valid",
        priority: 1
      });
    }

    // Pick up to 2 native iOS engineers first, fallback to tech leadership
    const engPool = [...iosEngineers, ...techLeaders];
    for (const eng of engPool) {
      if (picks.filter(p => p.contact_type === "named_employee").length >= 2) break;
      const title = eng.position || eng.position_raw || "Software Engineer";
      const isIOS = DEDICATED_IOS_REGEX.test(title);
      picks.push({
        domain,
        email: eng.value,
        full_name: `${eng.first_name || ""} ${eng.last_name || ""}`.trim(),
        title,
        contact_type: "named_employee",
        provider: "hunter",
        source_url: eng.linkedin || "",
        notes: isIOS ? "Hunter verified native iOS specialist" : "Hunter verified technical leader",
        email_status: eng.verification?.status || "valid",
        priority: isIOS ? 2 : 3
      });
    }

    return picks;
  } catch (err: any) {
    console.warn(`[Hunter Cache] Error reading cache for ${domain}:`, err.message);
    return [];
  }
}

async function processSnovCompany(domain: string, neededRecruiter: boolean, neededEngineers: number): Promise<PickedContact[]> {
  console.log(`[Snov.io] Querying prospects for ${domain}...`);
  const prospects = await searchSnovProspects(domain);
  if (prospects.length === 0) {
    console.log(`[Snov.io] No prospects found for ${domain}.`);
    return [];
  }

  // Filter prospects: strictly NO Android, NO Cross-Platform, NO Non-Engineering
  const eligible = prospects.filter(p => {
    const title = (p.position || "").trim();
    if (!title) return false;
    if (EXCLUDED_FRAMEWORKS_AND_ANDROID.test(title)) {
      console.log(`  [Excluded Non-iOS/Cross-Platform/Android]: ${p.first_name} ${p.last_name} (${title})`);
      return false;
    }
    if (EXCLUDED_NON_ENG_REGEX.test(title)) {
      return false;
    }
    return true;
  });

  let recruiterCandidate: SnovProspect | null = null;
  const iosCandidates: SnovProspect[] = [];
  const techLeaderCandidates: SnovProspect[] = [];

  for (const p of eligible) {
    const title = p.position.trim();
    if (neededRecruiter && !recruiterCandidate && RECRUITER_REGEX.test(title)) {
      recruiterCandidate = p;
    } else if (DEDICATED_IOS_REGEX.test(title)) {
      iosCandidates.push(p);
    } else if (TECH_LEADERSHIP_REGEX.test(title)) {
      techLeaderCandidates.push(p);
    }
  }

  const picks: PickedContact[] = [];

  // 1. Recruiter if needed
  if (neededRecruiter && recruiterCandidate && recruiterCandidate.search_emails_start) {
    console.log(`  [Snov Resolving Recruiter]: ${recruiterCandidate.first_name} ${recruiterCandidate.last_name} (${recruiterCandidate.position})`);
    const verified = await resolveSnovEmail(recruiterCandidate.search_emails_start);
    if (verified && isEmailValidForDomain(verified.email, domain)) {
      picks.push({
        domain,
        email: verified.email,
        full_name: `${recruiterCandidate.first_name} ${recruiterCandidate.last_name}`.trim(),
        title: recruiterCandidate.position,
        contact_type: "named_talent",
        provider: "snov",
        source_url: recruiterCandidate.source_page || "",
        notes: "Snov.io verified recruiter",
        email_status: verified.status,
        priority: 1
      });
      console.log(`    -> Verified email: ${verified.email}`);
    } else {
      console.log(`    -> No verified work email found.`);
    }
  }

  // 2. Native iOS Engineers first, fallback to Tech Leadership
  const engPool = [...iosCandidates, ...techLeaderCandidates];
  let resolvedEngCount = 0;

  for (const eng of engPool) {
    if (resolvedEngCount >= neededEngineers) break;
    if (!eng.search_emails_start) continue;

    const isIOS = DEDICATED_IOS_REGEX.test(eng.position);
    console.log(`  [Snov Resolving ${isIOS ? "Native iOS" : "Tech Leader"}]: ${eng.first_name} ${eng.last_name} (${eng.position})`);
    const verified = await resolveSnovEmail(eng.search_emails_start);
    if (verified && isEmailValidForDomain(verified.email, domain)) {
      picks.push({
        domain,
        email: verified.email,
        full_name: `${eng.first_name} ${eng.last_name}`.trim(),
        title: eng.position,
        contact_type: "named_employee",
        provider: "snov",
        source_url: eng.source_page || "",
        notes: isIOS ? "Snov.io verified pure native iOS specialist" : "Snov.io verified technical leader",
        email_status: verified.status,
        priority: isIOS ? 2 : 3
      });
      console.log(`    -> Verified email: ${verified.email}`);
      resolvedEngCount++;
    } else {
      console.log(`    -> No verified work email found.`);
    }
  }

  return picks;
}

async function main() {
  console.log("==========================================================");
  console.log("PURE NATIVE iOS ENGINEERING & RECRUITING OUTREACH QUEUE");
  console.log("==========================================================");

  const initialBalance = await getSnovBalance();
  console.log(`Initial Snov.io Credit Balance: ${initialBalance}`);

  if (!fs.existsSync(TARGETS_CSV)) {
    console.error(`Error: Targets CSV not found at ${TARGETS_CSV}`);
    process.exit(1);
  }

  // Read existing contacts
  const existingContacts = new Set<string>();
  const companyContactCounts = new Map<string, number>();

  if (fs.existsSync(CONTACTS_CSV)) {
    const lines = fs.readFileSync(CONTACTS_CSV, "utf-8").split("\n").map(l => l.trim()).filter(Boolean);
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(",");
      if (parts.length >= 2) {
        const d = parts[0].trim().toLowerCase();
        const em = parts[1].trim().toLowerCase();
        existingContacts.add(`${d}:${em}`);
        companyContactCounts.set(d, (companyContactCounts.get(d) || 0) + 1);
      }
    }
  } else {
    fs.writeFileSync(CONTACTS_CSV, "domain,email,full_name,title,contact_type,provider,source_url,notes,email_status\n");
  }

  // Read targets
  const targetLines = fs.readFileSync(TARGETS_CSV, "utf-8").split("\n").map(l => l.trim()).filter(Boolean);
  interface TargetItem {
    domain: string;
    name: string;
    category: string;
    status: string;
    rawLine: string;
  }
  const targets: TargetItem[] = [];

  for (let i = 1; i < targetLines.length; i++) {
    const cols = targetLines[i].split(",");
    if (cols.length >= 2) {
      targets.push({
        domain: cols[0].trim().toLowerCase(),
        name: cols[1].trim(),
        category: cols[2]?.trim() || "",
        status: cols[cols.length - 1]?.trim() || "pending",
        rawLine: targetLines[i]
      });
    }
  }

  console.log(`Loaded ${targets.length} qualified mobile target companies.`);

  let totalNewRows = 0;
  let companiesCompleted = 0;
  let nativeIOSCount = 0;
  let recruiterCount = 0;

  for (const target of targets) {
    const currentCount = companyContactCounts.get(target.domain) || 0;
    if (currentCount >= 3) {
      continue;
    }

    console.log(`\n----------------------------------------------------------`);
    console.log(`Processing ${target.name} (${target.domain}) [Current contacts: ${currentCount}/3]`);

    // Step 1: Check Hunter cache first for verified contacts
    const hunterPicks = await processHunterCache(target.domain);
    let companyPicks: PickedContact[] = [];

    for (const p of hunterPicks) {
      const key = `${p.domain.toLowerCase()}:${p.email.toLowerCase()}`;
      if (!existingContacts.has(key)) {
        companyPicks.push(p);
        existingContacts.add(key);
      }
    }

    if (companyPicks.length > 0) {
      console.log(`Found ${companyPicks.length} verified candidate(s) in Hunter cache for ${target.domain}:`);
      for (const p of companyPicks) {
        console.log(`  - [Priority ${p.priority} | ${p.contact_type}] ${p.full_name} (${p.title}) -> ${p.email}`);
      }
    }

    // Determine how many more are needed (1 recruiter, up to 2 engineers)
    const hasRecruiter = companyPicks.some(p => p.contact_type === "named_talent");
    const engineerCount = companyPicks.filter(p => p.contact_type === "named_employee").length;
    const neededRecruiter = !hasRecruiter;
    const neededEngineers = Math.max(0, 2 - engineerCount);

    if (companyPicks.length < 3 && (neededRecruiter || neededEngineers > 0)) {
      // Step 2: Query Snov.io if credits remain
      const currentBalance = await getSnovBalance();
      if (currentBalance < 1) {
        console.log(`[Snov.io] Balance exhausted (${currentBalance} credits remaining). Stopping live queries.`);
        break;
      }

      console.log(`[Snov.io] Live enrichment needed (${neededRecruiter ? "+1 Recruiter" : ""} ${neededEngineers > 0 ? `+${neededEngineers} Engineers` : ""}) | Balance: ${currentBalance}`);
      const snovPicks = await processSnovCompany(target.domain, neededRecruiter, neededEngineers);
      for (const sp of snovPicks) {
        const key = `${sp.domain.toLowerCase()}:${sp.email.toLowerCase()}`;
        if (!existingContacts.has(key) && companyPicks.length < 3) {
          companyPicks.push(sp);
          existingContacts.add(key);
        }
      }
    }

    // Write picks to CSV
    if (companyPicks.length > 0) {
      for (const p of companyPicks) {
        const row = [
          escapeCsv(p.domain),
          escapeCsv(p.email),
          escapeCsv(p.full_name),
          escapeCsv(p.title),
          escapeCsv(p.contact_type),
          escapeCsv(p.provider),
          escapeCsv(p.source_url),
          escapeCsv(p.notes),
          escapeCsv(p.email_status)
        ].join(",") + "\n";

        fs.appendFileSync(CONTACTS_CSV, row);
        totalNewRows++;
        companyContactCounts.set(target.domain, (companyContactCounts.get(target.domain) || 0) + 1);

        if (p.contact_type === "named_talent") {
          recruiterCount++;
        } else if (DEDICATED_IOS_REGEX.test(p.title)) {
          nativeIOSCount++;
        }
      }
      companiesCompleted++;
      console.log(`Successfully saved ${companyPicks.length} verified contact(s) for ${target.domain}.`);
    } else {
      console.log(`No verified contacts found matching criteria for ${target.domain}.`);
    }
  }

  const finalBalance = await getSnovBalance();
  console.log("\n==========================================================");
  console.log("PURE NATIVE iOS RUN COMPLETE");
  console.log("==========================================================");
  console.log(`Target Companies Processed: ${targets.length}`);
  console.log(`Companies with Verified Contacts: ${companiesCompleted}`);
  console.log(`Total Verified Contacts Appended This Run: ${totalNewRows}`);
  console.log(`Dedicated Native iOS Specialists: ${nativeIOSCount}`);
  console.log(`Technical Recruiters / Talent Leads: ${recruiterCount}`);
  console.log(`Final Snov.io Credit Balance: ${finalBalance}`);
  console.log(`Output Contacts CSV: ${CONTACTS_CSV}`);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
