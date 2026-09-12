import { describe, expect, it } from 'vitest'
import { cell, cellList, missingColumns, parseCsv } from '../../src/ingest/file/csv.js'

/**
 * The failure this parser exists to prevent is a quoted comma shifting every column
 * after it — which surfaces as a wrong domain or a wrong email address, not as an
 * error. So the quoting cases are the ones worth pinning.
 */
describe('parseCsv', () => {
  it('reads a plain file into header and rows', () => {
    const parsed = parseCsv('name,domain\nZomato,zomato.com\nSwiggy,swiggy.com\n')
    expect(parsed.header).toEqual(['name', 'domain'])
    expect(parsed.rows.map((r) => r.cells['domain'])).toEqual(['zomato.com', 'swiggy.com'])
    expect(parsed.malformed).toEqual([])
  })

  it('keeps a comma inside a quoted field in that field', () => {
    const parsed = parseCsv('name,notes,domain\nAcme,"food, delivery, quick commerce",acme.com\n')
    expect(parsed.rows[0]?.cells).toEqual({
      name: 'Acme',
      notes: 'food, delivery, quick commerce',
      domain: 'acme.com',
    })
  })

  it('unescapes a doubled quote and keeps the record intact', () => {
    const parsed = parseCsv('name,notes\nAcme,"they call it ""ten minute"" delivery"\n')
    expect(parsed.rows[0]?.cells['notes']).toBe('they call it "ten minute" delivery')
  })

  it('does not split a record on a newline inside a quoted field', () => {
    const parsed = parseCsv('name,notes\nAcme,"line one\nline two"\nBeta,plain\n')
    expect(parsed.rows.length).toBe(2)
    expect(parsed.rows[0]?.cells['notes']).toBe('line one\nline two')
    expect(parsed.rows[1]?.cells['name']).toBe('Beta')
  })

  it('handles CRLF line endings', () => {
    const parsed = parseCsv('name,domain\r\nAcme,acme.com\r\n')
    expect(parsed.rows[0]?.cells['domain']).toBe('acme.com')
  })

  /**
   * Padding a short row would put an empty string where a domain belongs and write a
   * Company with no website; truncating a long one would silently drop a column. Both
   * are the silent corruption this file refuses everywhere else, so a mismatched row
   * is reported with its line number and not turned into a record.
   */
  it('reports a row whose field count does not match the header, rather than padding it', () => {
    const parsed = parseCsv('name,domain,notes\nAcme,acme.com\nBeta,beta.com,fine\n')
    expect(parsed.rows.length).toBe(1)
    expect(parsed.malformed).toEqual([
      { line: 2, raw: 'Acme,acme.com', got: 2, want: 3 },
    ])
  })

  it('numbers lines from 1 so a reported row can be found by eye', () => {
    const parsed = parseCsv('name\nA\nB\nC\n')
    expect(parsed.rows.map((r) => r.line)).toEqual([2, 3, 4])
  })

  it('keeps the raw record text, which is what an Evidence excerpt quotes', () => {
    const parsed = parseCsv('name,notes\nAcme,"a, b"\n')
    expect(parsed.rows[0]?.raw).toBe('Acme,"a, b"')
  })

  it('ignores a blank trailing line', () => {
    expect(parseCsv('name\nA\n\n').rows.length).toBe(1)
  })

  it('returns nothing for empty input', () => {
    expect(parseCsv('')).toEqual({ header: [], rows: [], malformed: [] })
  })
})

describe('cell', () => {
  const row = parseCsv('a,b,c\n x ,,y\n').rows[0]!

  it('trims and returns a value', () => {
    expect(cell(row, 'a')).toBe('x')
  })

  /** An empty cell and an absent column mean the same thing: the operator gave no value. */
  it('returns null for an empty cell and for an absent column alike', () => {
    expect(cell(row, 'b')).toBeNull()
    expect(cell(row, 'nope')).toBeNull()
  })
})

describe('cellList', () => {
  it('splits on pipes and commas and drops the empties', () => {
    const row = parseCsv('tracks\n"ios_android| swe |,ai_engineer"\n').rows[0]!
    expect(cellList(row, 'tracks')).toEqual(['ios_android', 'swe', 'ai_engineer'])
  })

  it('is an empty list when the cell is blank', () => {
    const row = parseCsv('tracks\n\n').rows[0]
    expect(row === undefined ? [] : cellList(row, 'tracks')).toEqual([])
  })
})

describe('missingColumns', () => {
  it('names the required columns a header lacks', () => {
    expect(missingColumns(['name'], ['name', 'domain'])).toEqual(['domain'])
    expect(missingColumns(['name', 'domain'], ['name', 'domain'])).toEqual([])
  })
})
