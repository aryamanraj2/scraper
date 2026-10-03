import * as fs from "fs";
import * as path from "path";

// Env only. `origin` is a public GitHub repository, so a literal key here is one
// `git add` away from being published.
const API_KEY = process.env.HUNTER_API_KEY;
if (!API_KEY) throw new Error("HUNTER_API_KEY is not set; export it before running this tool");
const TARGETS_CSV = path.resolve("data/salesql-targets.csv");
const CONTACTS_CSV = path.resolve("data/salesql-contacts.csv");
const CACHE_DIR = path.resolve("data/hunter-cache");

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

const HEADER = "domain,email,full_name,title,contact_type,provider,source_url,notes,email_status\n";

function escapeCsv(val: any): string {
  if (val === null || val === undefined) return "";
  const s = String(val).trim();
  if (s.includes(",") || s.includes("\"") || s.includes("\n")) {
    return `"${s.replace(/"/g, "\"\"")}"`;
  }
  return s;
}

const EXCLUDED_TITLE_REGEX = /\b(founder|co-founder|ceo|cto|cfo|coo|cpo|chief|president|vp|svp|evp|head of company|board member|owner)\b/i;

const RECRUITER_REGEX = /\b(recruiter|recruiting|talent acquisition|university recruiter|talent partner|people partner|human resources|people ops)\b/i;

const MOBILE_REGEX = /\b(ios|android|mobile|swift|kotlin|flutter|react-native)\b/i;
const AI_REGEX = /\b(machine learning|ml engineer|applied ai|ai engineer|nlp|computer vision|deep learning)\b/i;
const SWE_REGEX = /\b(software engineer|backend engineer|frontend engineer|full-stack engineer|sde|swe|systems engineer|infrastructure engineer|platform engineer|developer)\b/i;

const PERSONAL_DOMAINS = new Set([
  "gmail.com",
  "yahoo.com",
  "outlook.com",
  "hotmail.com",
  "icloud.com",
  "proton.me",
  "protonmail.com"
]);

async function getCredits(): Promise<number> {
  try {
    const res = await fetch(`https://api.hunter.io/v2/account?api_key=${API_KEY}`);
    const data = await res.json();
    return data.data?.requests?.credits?.remaining ?? 0;
  } catch (err) {
    console.error("Failed to check credits:", err);
    return 0;
  }
}

interface Target {
  domain: string;
  name: string;
  track: string;
  score: number;
}

function parseTargets(): Target[] {
  const content = fs.readFileSync(TARGETS_CSV, "utf-8");
  const lines = content.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  const targets: Target[] = [];
  
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    if (parts.length >= 4) {
      targets.push({
        domain: parts[0].trim().toLowerCase(),
        name: parts[1].trim(),
        track: parts[2].trim(),
        score: parseFloat(parts[3].trim())
      });
    }
  }
  return targets;
}

async function searchDomain(domain: string): Promise<any> {
  const cacheFile = path.join(CACHE_DIR, `${domain}.json`);
  if (fs.existsSync(cacheFile)) {
    console.log(`[Cache Hit] Using cached data for ${domain}`);
    return JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
  }

  const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&seniority=senior,junior&limit=10&api_key=${API_KEY}`;
  console.log(`[API Call] Fetching domain-search for ${domain}...`);
  const res = await fetch(url);
  const json = await res.json();

  if (json.errors) {
    console.warn(`[API Warning] Error for ${domain}:`, json.errors);
  } else {
    fs.writeFileSync(cacheFile, JSON.stringify(json, null, 2));
  }
  return json;
}

function isEmailValidForDomain(email: string, companyDomain: string): boolean {
  if (!email || !email.includes("@")) return false;
  const emailDomain = email.split("@")[1].toLowerCase();
  if (PERSONAL_DOMAINS.has(emailDomain)) return false;
  return emailDomain === companyDomain || emailDomain.endsWith("." + companyDomain);
}

interface PickedContact {
  domain: string;
  email: string;
  full_name: string;
  title: string;
  contact_type: "named_talent" | "named_employee";
  provider: string;
  source_url: string;
  notes: string;
  email_status: string;
}

function selectCandidates(domain: string, track: string, emails: any[]): PickedContact[] {
  const validPeople = emails.filter(e => {
    if (!e.value) return false;
    if (!isEmailValidForDomain(e.value, domain)) return false;
    const title = e.position || e.position_raw || "";
    if (EXCLUDED_TITLE_REGEX.test(title)) return false;
    return true;
  });

  // 1. Pick 1 recruiter
  let recruiter: any = null;
  for (const p of validPeople) {
    const title = p.position || p.position_raw || "";
    const dept = (p.department || "").toLowerCase();
    if (RECRUITER_REGEX.test(title) || dept === "hr") {
      recruiter = p;
      break;
    }
  }

  // 2. Pick 2 engineers with priority:
  // Priority: iOS & Android > Applied AI > SWE / SDE
  const remaining = validPeople.filter(p => p !== recruiter);
  const mobileEngineers: any[] = [];
  const aiEngineers: any[] = [];
  const sweEngineers: any[] = [];

  for (const p of remaining) {
    const title = (p.position || p.position_raw || "").toLowerCase();
    const dept = (p.department || "").toLowerCase();

    if (MOBILE_REGEX.test(title)) {
      mobileEngineers.push(p);
    } else if (AI_REGEX.test(title)) {
      aiEngineers.push(p);
    } else if (SWE_REGEX.test(title) || dept === "it") {
      sweEngineers.push(p);
    }
  }

  const selectedEngineers: any[] = [];
  const pool = [...mobileEngineers, ...aiEngineers, ...sweEngineers];
  for (const eng of pool) {
    if (selectedEngineers.length >= 2) break;
    if (!selectedEngineers.includes(eng)) {
      selectedEngineers.push(eng);
    }
  }

  const picks: PickedContact[] = [];
  if (recruiter) {
    const title = recruiter.position || recruiter.position_raw || "Recruiter";
    picks.push({
      domain,
      email: recruiter.value,
      full_name: `${recruiter.first_name || ""} ${recruiter.last_name || ""}`.trim(),
      title,
      contact_type: "named_talent",
      provider: "salesql",
      source_url: recruiter.linkedin || "",
      notes: "",
      email_status: recruiter.verification?.status || ""
    });
  }

  for (const eng of selectedEngineers) {
    const title = eng.position || eng.position_raw || "Software Engineer";
    const isTalent = RECRUITER_REGEX.test(title);
    picks.push({
      domain,
      email: eng.value,
      full_name: `${eng.first_name || ""} ${eng.last_name || ""}`.trim(),
      title,
      contact_type: isTalent ? "named_talent" : "named_employee",
      provider: "salesql",
      source_url: eng.linkedin || "",
      notes: "",
      email_status: eng.verification?.status || ""
    });
  }

  return picks;
}

async function main() {
  console.log("Starting SalesQL/Hunter Pipeline Goal...");
  const initialCredits = await getCredits();
  console.log(`Initial remaining credits: ${initialCredits}`);

  if (initialCredits < 1) {
    console.error("Credits exhausted before starting.");
    return;
  }

  if (!fs.existsSync(CONTACTS_CSV)) {
    fs.writeFileSync(CONTACTS_CSV, HEADER);
  }

  // Load existing contacts to avoid duplicate writes
  const existingContacts = new Set<string>();
  const currentLines = fs.readFileSync(CONTACTS_CSV, "utf-8").split("\n").filter(l => l.trim().length > 0);
  for (let i = 1; i < currentLines.length; i++) {
    const cols = currentLines[i].split(",");
    if (cols.length >= 2) {
      existingContacts.add(`${cols[0].trim().toLowerCase()}:${cols[1].trim().toLowerCase()}`);
    }
  }

  const targets = parseTargets();
  console.log(`Loaded ${targets.length} target companies.`);

  let companiesDone = 0;
  let companiesSkipped = 0;
  const skipReasons: { domain: string; reason: string }[] = [];
  let totalRowsWritten = 0;

  for (const target of targets) {
    const creditsNow = await getCredits();
    if (creditsNow < 1) {
      console.log(`Stopping: Credits exhausted (${creditsNow} remaining).`);
      break;
    }

    console.log(`\n----------------------------------------`);
    console.log(`Processing ${target.name} (${target.domain}) - Track: ${target.track}`);

    let data: any;
    try {
      data = await searchDomain(target.domain);
    } catch (err: any) {
      console.error(`Error querying domain ${target.domain}:`, err.message);
      skipReasons.push({ domain: target.domain, reason: `API request failed: ${err.message}` });
      companiesSkipped++;
      continue;
    }

    const emails = data.data?.emails || [];
    if (emails.length === 0) {
      console.log(`No results found for ${target.domain}. Skipping.`);
      skipReasons.push({ domain: target.domain, reason: "No email records returned by provider" });
      companiesSkipped++;
      continue;
    }

    const picks = selectCandidates(target.domain, target.track, emails);
    if (picks.length === 0) {
      console.log(`No valid non-executive candidates found for ${target.domain}. Skipping.`);
      skipReasons.push({ domain: target.domain, reason: "No matching non-executive ICs/recruiters found" });
      companiesSkipped++;
      continue;
    }

    console.log(`Selected ${picks.length} picks for ${target.domain}:`);
    let addedForCompany = 0;
    for (const p of picks) {
      console.log(`  - [${p.contact_type}] ${p.full_name} (${p.title}) -> ${p.email}`);
      const key = `${p.domain.toLowerCase()}:${p.email.toLowerCase()}`;
      if (!existingContacts.has(key)) {
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
        existingContacts.add(key);
        addedForCompany++;
        totalRowsWritten++;
      } else {
        console.log(`    (Already in CSV, skipped duplicate)`);
      }
    }

    companiesDone++;
    console.log(`Appended ${addedForCompany} new rows for ${target.domain}.`);
  }

  const finalCredits = await getCredits();
  console.log(`\n========================================`);
  console.log(`RUN SUMMARY`);
  console.log(`========================================`);
  console.log(`Companies Processed: ${companiesDone}`);
  console.log(`Companies Skipped: ${companiesSkipped}`);
  if (skipReasons.length > 0) {
    console.log(`Skipped details:`);
    skipReasons.forEach(s => console.log(`  - ${s.domain}: ${s.reason}`));
  }
  console.log(`Total New Rows Written: ${totalRowsWritten}`);
  console.log(`Credits Spent: ${initialCredits - finalCredits}`);
  console.log(`Credits Remaining: ${finalCredits}`);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
