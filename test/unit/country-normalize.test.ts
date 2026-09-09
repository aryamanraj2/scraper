import { describe, expect, it } from 'vitest'
import {
  COUNTRY_MAP_VERSION,
  normalizeCountry,
  resolveCountries,
} from '../../src/intel/country/normalize.js'
import { isIndiaCompany } from '../../src/ingest/budget/company-budget.js'

describe('country normalization (F1 deviation §4.12)', () => {
  it('resolves the inconsistent spellings yc-oss actually publishes', () => {
    // Both appear in the live corpus: "USA" in all_locations, "United States of
    // America" in regions. Before F2 they were two different countries.
    expect(normalizeCountry('USA').code).toBe('US')
    expect(normalizeCountry('United States of America').code).toBe('US')
    expect(normalizeCountry('United States').code).toBe('US')
  })

  it('keeps the source string, so the mapping can be shown and not just applied', () => {
    const n = normalizeCountry('  united   KINGDOM ')
    expect(n.raw).toBe('  united   KINGDOM ')
    expect(n.code).toBe('GB')
    expect(n.mapVersion).toBe(COUNTRY_MAP_VERSION)
  })

  it('records an unrecognised string as unmapped rather than guessing', () => {
    const n = normalizeCountry('Remote')
    expect(n.code).toBeNull()
    expect(n.name).toBeNull()
    expect(n.region).toBe('other')
    expect(resolveCountries(['Remote', 'Atlantis']).unmapped).toEqual(['Remote', 'Atlantis'])
  })

  it('assigns the priority regions handover.md §1 orders', () => {
    expect(normalizeCountry('India').region).toBe('india')
    expect(normalizeCountry('USA').region).toBe('us')
    expect(normalizeCountry('England').region).toBe('uk')
    expect(normalizeCountry('Portugal').region).toBe('eu')
    expect(normalizeCountry('Japan').region).toBe('other')
  })

  it('takes the highest-priority region a multi-country company has', () => {
    expect(resolveCountries(['USA', 'India']).bestRegion).toBe('india')
    expect(resolveCountries(['Germany', 'USA']).bestRegion).toBe('us')
    expect(resolveCountries(['Japan', 'Germany']).bestRegion).toBe('eu')
    expect(resolveCountries([]).bestRegion).toBe('other')
  })

  it('deduplicates and sorts the codes it resolved', () => {
    expect(resolveCountries(['USA', 'United States', 'India']).codes).toEqual(['IN', 'US'])
  })

  /**
   * F1's `isIndiaCompany` sizes the H5 research envelope and is explicitly not a
   * general normalizer. F2's table must agree with it wherever it fires, or one
   * company gets an India-sized budget and a non-India score.
   */
  it('agrees with the F1 India budget check on every spelling that check accepts', () => {
    for (const spelling of ['India', 'india', 'Republic of India', '  INDIA ']) {
      expect(isIndiaCompany([spelling])).toBe(true)
      expect(normalizeCountry(spelling).region).toBe('india')
    }
  })
})
