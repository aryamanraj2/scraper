/**
 * A small RFC 4180 reader, for the two operator-authored files this system ingests:
 * the company seed list and the hand-gathered contact list.
 *
 * Pure — no filesystem, no database, no clock — so the parsing rules can be pinned
 * by unit tests without a fixture directory.
 *
 * ## Why not a dependency
 *
 * Both files are typed by the operator, and the failure this parser has to get right
 * is a quoted field containing a comma: `notes` in the seed file is free text and
 * `title` in the contact file is routinely `"Engineering Manager, Platform"`. A naive
 * `split(',')` shifts every column after it, which shows up as a *wrong domain* or a
 * *wrong address* rather than as an error — the exact shape of silent corruption this
 * project keeps refusing elsewhere. That is about sixty lines of well-understood
 * state machine, against a transitive dependency inside a system whose central
 * invariant is that nothing reaches the network.
 *
 * What it does NOT do, deliberately: no type coercion, no trimming of quoted values,
 * no header renaming. A cell is the string the operator wrote.
 */

export type CsvRow = {
  /** 1-based line number in the source file, for error reporting the operator can act on. */
  line: number
  /** The row's cells keyed by header, exactly as written. */
  cells: Record<string, string>
  /** The raw text of the row, verbatim — this is what an Evidence excerpt quotes. */
  raw: string
}

export type CsvParseResult = {
  header: string[]
  rows: CsvRow[]
  /** Rows whose cell count did not match the header. Reported, never silently padded. */
  malformed: { line: number; raw: string; got: number; want: number }[]
}

/**
 * Splits into records first, then fields, because a quoted field may contain the
 * record separator. Handles `\r\n` and `\n`, doubled quotes (`""`) as an escaped
 * quote, and a trailing newline.
 */
export function parseCsv(text: string): CsvParseResult {
  const records = splitRecords(text)
  if (records.length === 0) return { header: [], rows: [], malformed: [] }

  const header = splitFields(records[0]!.text).map((h) => h.trim())
  const rows: CsvRow[] = []
  const malformed: CsvParseResult['malformed'] = []

  for (const record of records.slice(1)) {
    if (record.text.trim() === '') continue
    const fields = splitFields(record.text)
    if (fields.length !== header.length) {
      malformed.push({ line: record.line, raw: record.text, got: fields.length, want: header.length })
      continue
    }
    const cells: Record<string, string> = {}
    header.forEach((name, i) => {
      cells[name] = fields[i]!
    })
    rows.push({ line: record.line, cells, raw: record.text })
  }

  return { header, rows, malformed }
}

type Record_ = { line: number; text: string }

function splitRecords(text: string): Record_[] {
  const out: Record_[] = []
  let current = ''
  let line = 1
  let startLine = 1
  let inQuotes = false

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    if (ch === '"') {
      // A doubled quote inside a quoted field is a literal quote, and consuming both
      // characters here is what stops it being read as the field's terminator.
      if (inQuotes && text[i + 1] === '"') {
        current += '""'
        i += 1
        continue
      }
      inQuotes = !inQuotes
      current += ch
      continue
    }
    if (!inQuotes && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && text[i + 1] === '\n') i += 1
      out.push({ line: startLine, text: current })
      current = ''
      line += 1
      startLine = line
      continue
    }
    if (inQuotes && ch === '\n') line += 1
    current += ch
  }
  if (current !== '') out.push({ line: startLine, text: current })
  return out
}

function splitFields(record: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < record.length; i += 1) {
    const ch = record[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (record[i + 1] === '"') {
          current += '"'
          i += 1
          continue
        }
        inQuotes = false
        continue
      }
      current += ch
      continue
    }
    if (ch === '"' && current === '') {
      inQuotes = true
      continue
    }
    if (ch === ',') {
      fields.push(current)
      current = ''
      continue
    }
    current += ch
  }
  fields.push(current)
  return fields
}

/**
 * The value of a column, trimmed, or null when the column is absent or empty.
 *
 * Every caller wants this rather than the raw cell: an operator-typed file has
 * trailing spaces in it, and `""` and a missing column mean the same thing — the
 * operator did not supply a value.
 */
export function cell(row: CsvRow, column: string): string | null {
  const value = row.cells[column]
  if (value === undefined) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** A pipe- or comma-separated multi-value cell, split and cleaned. */
export function cellList(row: CsvRow, column: string): string[] {
  const value = cell(row, column)
  if (value === null) return []
  return value
    .split(/[|,]/)
    .map((v) => v.trim())
    .filter((v) => v !== '')
}

/** Columns the file must carry. Returns the ones that are missing. */
export function missingColumns(header: string[], required: readonly string[]): string[] {
  const present = new Set(header)
  return required.filter((c) => !present.has(c))
}
