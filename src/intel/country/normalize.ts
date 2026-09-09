/**
 * Country normalization (F1 deviation §4.12 hands this to F2).
 *
 * ## Why this could not be done in F1
 *
 * `Company.countries` holds the source's OWN spellings, verbatim, because every
 * stored value has to be a substring of the excerpt that cites it. yc-oss writes
 * "USA" in one field and "United States of America" in another, and normalizing at
 * ingestion would have put a string the source never wrote into a column whose
 * whole purpose is that it was not altered.
 *
 * So normalization happens HERE, at classification time, and the mapping is
 * recorded rather than applied invisibly: the resolution carries the source's own
 * word, our resolved code, and the version of the table that resolved it, and the
 * scorer persists all three in `score_components`.
 *
 * ## Scope
 *
 * This is a lookup over the spellings that actually appear in our sources, not a
 * general geocoder. An unrecognised string resolves to `null` and is recorded as
 * unmapped — never guessed, because a wrong guess here promotes a company into
 * India's priority band or demotes it out of one.
 */

/** Bumped whenever the table below changes, and stored with anything it resolved. */
export const COUNTRY_MAP_VERSION = 'country-map-2026-09-v1'

/**
 * Priority bands from `handover.md` §1: India first, then remote-viable US, UK and
 * EU. `other` is not a rejection — it scores lower on the geography component and
 * nothing else.
 */
export type PriorityRegion = 'india' | 'us' | 'uk' | 'eu' | 'other'

export type NormalizedCountry = {
  /** Exactly what the source wrote. */
  raw: string
  /** ISO 3166-1 alpha-2, or null when the string is not one we recognise. */
  code: string | null
  /** Our canonical display name, or null when unmapped. */
  name: string | null
  region: PriorityRegion
  /** Which table resolved it, so a later change is auditable. */
  mapVersion: string
}

/**
 * Spelling → ISO code. Keys are lowercased and whitespace-collapsed at lookup.
 *
 * Entries exist because a source wrote them, not because the country exists: the
 * yc-oss corpus is the origin of every spelling here, plus the obvious variants of
 * those spellings. Inventing entries for countries nobody has published would be
 * untested code pretending to be data.
 */
const SPELLINGS: Record<string, string> = {
  // India — priority #1 (handover.md §1, B7).
  india: 'IN',
  'republic of india': 'IN',
  bharat: 'IN',

  // United States.
  usa: 'US',
  'u.s.a.': 'US',
  us: 'US',
  'u.s.': 'US',
  'united states': 'US',
  'united states of america': 'US',

  // United Kingdom. The constituent countries map to GB because that is the
  // jurisdiction a remote internship actually sits in.
  uk: 'GB',
  'u.k.': 'GB',
  'united kingdom': 'GB',
  'great britain': 'GB',
  england: 'GB',
  scotland: 'GB',
  wales: 'GB',
  'northern ireland': 'GB',

  // EU / EEA members seen in the corpus.
  ireland: 'IE',
  france: 'FR',
  germany: 'DE',
  spain: 'ES',
  portugal: 'PT',
  italy: 'IT',
  netherlands: 'NL',
  'the netherlands': 'NL',
  belgium: 'BE',
  austria: 'AT',
  denmark: 'DK',
  sweden: 'SE',
  finland: 'FI',
  norway: 'NO',
  poland: 'PL',
  czechia: 'CZ',
  'czech republic': 'CZ',
  estonia: 'EE',
  latvia: 'LV',
  lithuania: 'LT',
  greece: 'GR',
  romania: 'RO',
  bulgaria: 'BG',
  croatia: 'HR',
  slovenia: 'SI',
  slovakia: 'SK',
  hungary: 'HU',
  luxembourg: 'LU',
  switzerland: 'CH',
  iceland: 'IS',

  // Everything else the corpus contains. Mapped so the value is recognised and
  // recorded rather than reported as unmapped noise; scored as `other`.
  canada: 'CA',
  israel: 'IL',
  'hong kong': 'HK',
  singapore: 'SG',
  australia: 'AU',
  'new zealand': 'NZ',
  japan: 'JP',
  'south korea': 'KR',
  korea: 'KR',
  china: 'CN',
  taiwan: 'TW',
  indonesia: 'ID',
  malaysia: 'MY',
  philippines: 'PH',
  thailand: 'TH',
  vietnam: 'VN',
  brazil: 'BR',
  mexico: 'MX',
  argentina: 'AR',
  chile: 'CL',
  colombia: 'CO',
  peru: 'PE',
  uruguay: 'UY',
  nigeria: 'NG',
  kenya: 'KE',
  ghana: 'GH',
  'south africa': 'ZA',
  egypt: 'EG',
  'united arab emirates': 'AE',
  uae: 'AE',
  'saudi arabia': 'SA',
  turkey: 'TR',
  ukraine: 'UA',
  serbia: 'RS',
  pakistan: 'PK',
  bangladesh: 'BD',
  'sri lanka': 'LK',
  nepal: 'NP',
}

const NAMES: Record<string, string> = {
  IN: 'India', US: 'United States', GB: 'United Kingdom', IE: 'Ireland', FR: 'France',
  DE: 'Germany', ES: 'Spain', PT: 'Portugal', IT: 'Italy', NL: 'Netherlands',
  BE: 'Belgium', AT: 'Austria', DK: 'Denmark', SE: 'Sweden', FI: 'Finland',
  NO: 'Norway', PL: 'Poland', CZ: 'Czechia', EE: 'Estonia', LV: 'Latvia',
  LT: 'Lithuania', GR: 'Greece', RO: 'Romania', BG: 'Bulgaria', HR: 'Croatia',
  SI: 'Slovenia', SK: 'Slovakia', HU: 'Hungary', LU: 'Luxembourg', CH: 'Switzerland',
  IS: 'Iceland', CA: 'Canada', IL: 'Israel', HK: 'Hong Kong', SG: 'Singapore',
  AU: 'Australia', NZ: 'New Zealand', JP: 'Japan', KR: 'South Korea', CN: 'China',
  TW: 'Taiwan', ID: 'Indonesia', MY: 'Malaysia', PH: 'Philippines', TH: 'Thailand',
  VN: 'Vietnam', BR: 'Brazil', MX: 'Mexico', AR: 'Argentina', CL: 'Chile',
  CO: 'Colombia', PE: 'Peru', UY: 'Uruguay', NG: 'Nigeria', KE: 'Kenya',
  GH: 'Ghana', ZA: 'South Africa', EG: 'Egypt', AE: 'United Arab Emirates',
  SA: 'Saudi Arabia', TR: 'Turkey', UA: 'Ukraine', RS: 'Serbia', PK: 'Pakistan',
  BD: 'Bangladesh', LK: 'Sri Lanka', NP: 'Nepal',
}

/**
 * EU/EEA and the European states adjacent to them, which is what "European
 * startups" means for a remote internship in `handover.md` §1. Switzerland, Norway
 * and Iceland are included because the operative question is "is this a European
 * company that could host a remote intern", not "is this a member state".
 */
const EU_CODES = new Set([
  'IE', 'FR', 'DE', 'ES', 'PT', 'IT', 'NL', 'BE', 'AT', 'DK', 'SE', 'FI', 'NO',
  'PL', 'CZ', 'EE', 'LV', 'LT', 'GR', 'RO', 'BG', 'HR', 'SI', 'SK', 'HU', 'LU',
  'CH', 'IS',
])

export function regionForCode(code: string | null): PriorityRegion {
  if (code === 'IN') return 'india'
  if (code === 'US') return 'us'
  if (code === 'GB') return 'uk'
  if (code !== null && EU_CODES.has(code)) return 'eu'
  return 'other'
}

export function normalizeCountry(raw: string): NormalizedCountry {
  const key = raw.trim().toLowerCase().replace(/\s+/g, ' ')
  const code = SPELLINGS[key] ?? null
  return {
    raw,
    code,
    name: code === null ? null : (NAMES[code] ?? null),
    region: regionForCode(code),
    mapVersion: COUNTRY_MAP_VERSION,
  }
}

export type CountryResolution = {
  countries: NormalizedCountry[]
  /** Distinct ISO codes, sorted. */
  codes: string[]
  /** Source strings this table does not recognise. Recorded, never guessed at. */
  unmapped: string[]
  /** The highest-priority region present, which is what geography scores on. */
  bestRegion: PriorityRegion
  mapVersion: string
}

const REGION_PRIORITY: PriorityRegion[] = ['india', 'us', 'uk', 'eu']

/**
 * Resolves a company's country strings into the mapping a score can be explained
 * from. A company present in several countries takes the highest-priority one it
 * has: `handover.md` §1 puts India first, so a company with an Indian office is an
 * India lead regardless of where else it operates.
 */
export function resolveCountries(raw: readonly string[]): CountryResolution {
  const countries = raw.map(normalizeCountry)
  const codes = [...new Set(countries.map((c) => c.code).filter((c): c is string => c !== null))].sort()
  const unmapped = countries.filter((c) => c.code === null).map((c) => c.raw)
  const present = new Set(countries.map((c) => c.region))
  const bestRegion = REGION_PRIORITY.find((r) => present.has(r)) ?? 'other'
  return { countries, codes, unmapped, bestRegion, mapVersion: COUNTRY_MAP_VERSION }
}
