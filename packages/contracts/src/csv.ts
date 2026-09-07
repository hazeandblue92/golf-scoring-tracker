/**
 * CSV import contract (spec §4.2, §4.3, §21.2).
 *
 * §4.2 requires participant and handicap import/export "through a documented
 * CSV template with a dry-run validation report", and §4.3 requires the same
 * for course data. §21.2 names the malformed input this must survive:
 *
 *   "CSV contains BOM, alternate newline, duplicate header, formula string, or
 *    unknown enum: parse safely and report row errors."
 *
 * Two rules shape everything here:
 *
 * 1. **Report, never abort.** A spreadsheet exported by a phone, a Mac, and a
 *    Windows laptop will differ in line endings and may carry a byte-order
 *    mark. One bad row must not discard nineteen good ones — the organizer
 *    gets a row-and-column report and decides.
 *
 * 2. **A preview must equal the apply.** The same function produces the
 *    dry-run report and the rows that are sent to the server, so what the
 *    organizer approved is what gets written. The server re-runs it on the
 *    payload it receives, because a client report is a convenience, never an
 *    authorization.
 *
 * Formula strings are the one case where valid CSV still needs handling: a
 * cell beginning `=`, `+`, `-`, or `@` is executable when the file is reopened
 * in a spreadsheet. Values are never silently rewritten — a numeric field
 * parses as usual (a leading `-` is a plus handicap), and a text field
 * carrying a leading formula character is reported so the organizer can see
 * what arrived.
 */

/** One problem with one cell or row. `row` is 1-based over data rows. */
export interface CsvIssue {
  row: number
  column?: string
  code:
    | 'duplicate_header'
    | 'unknown_column'
    | 'missing_column'
    | 'ragged_row'
    | 'required'
    | 'invalid_number'
    | 'out_of_range'
    | 'invalid_enum'
    | 'invalid_date'
    | 'duplicate_key'
    | 'formula_string'
    | 'empty_file'
  message: string
  /** True when the row is still importable; false when it must be skipped. */
  warning: boolean
}

export interface CsvTable {
  headers: string[]
  /** Data rows keyed by normalized header. Ragged rows are padded/truncated. */
  rows: Array<Record<string, string>>
  issues: CsvIssue[]
}

const FORMULA_PREFIX = /^[=+\-@\t\r]/

/** Header text -> lookup key: trimmed, lowercased, spaces and dashes folded. */
export function normalizeHeader(header: string): string {
  return header
    .replace(/^﻿/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
}

/**
 * RFC 4180 parsing with the real-world tolerances §21.2 lists: a leading BOM,
 * and CRLF / CR / LF line endings, including inside quoted fields.
 */
export function parseCsv(text: string): CsvTable {
  const issues: CsvIssue[] = []
  const source = text.replace(/^﻿/, '')

  const records: string[][] = []
  let field = ''
  let record: string[] = []
  let quoted = false
  let sawAnyCharacter = false

  const endField = (): void => {
    record.push(field)
    field = ''
  }
  const endRecord = (): void => {
    endField()
    // A trailing newline must not produce a phantom empty record.
    if (record.length > 1 || record[0] !== '') records.push(record)
    record = []
  }

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i] as string
    sawAnyCharacter = true
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"'
          i += 1
        } else quoted = false
      } else field += char
      continue
    }
    if (char === '"') {
      quoted = true
      continue
    }
    if (char === ',') {
      endField()
      continue
    }
    if (char === '\r') {
      // Bare CR (classic Mac) and CRLF both terminate the record once.
      if (source[i + 1] === '\n') i += 1
      endRecord()
      continue
    }
    if (char === '\n') {
      endRecord()
      continue
    }
    field += char
  }
  if (field !== '' || record.length > 0) endRecord()

  if (records.length === 0) {
    issues.push({
      row: 0,
      code: 'empty_file',
      message: sawAnyCharacter ? 'No rows were found in the file.' : 'The file is empty.',
      warning: false,
    })
    return { headers: [], rows: [], issues }
  }

  const rawHeaders = records[0] as string[]
  const headers: string[] = []
  const seen = new Set<string>()
  for (const raw of rawHeaders) {
    const key = normalizeHeader(raw)
    if (seen.has(key)) {
      // Keep the first occurrence: a duplicate column silently overwriting the
      // one before it is how a whole import goes wrong invisibly.
      issues.push({
        row: 0,
        column: key,
        code: 'duplicate_header',
        message: `Column '${raw.trim()}' appears more than once; only the first was used.`,
        warning: true,
      })
      headers.push('')
      continue
    }
    seen.add(key)
    headers.push(key)
  }

  const rows: Array<Record<string, string>> = []
  for (let r = 1; r < records.length; r += 1) {
    const cells = records[r] as string[]
    if (cells.every((cell) => cell.trim() === '')) continue
    const rowNumber = rows.length + 1
    if (cells.length !== rawHeaders.length) {
      issues.push({
        row: rowNumber,
        code: 'ragged_row',
        message:
          `Row has ${cells.length} value(s) but the header has ${rawHeaders.length}. ` +
          'Missing values were treated as blank.',
        warning: true,
      })
    }
    const row: Record<string, string> = {}
    headers.forEach((key, index) => {
      if (key === '') return
      row[key] = (cells[index] ?? '').trim()
    })
    rows.push(row)
  }

  return { headers, rows, issues }
}

// ── Participant and handicap import (§4.2) ──────────────────────────────────

export const PARTICIPANT_CSV_COLUMNS = [
  'display_name',
  'username',
  'handicap_index',
  'handicap_source',
  'effective_from',
  'status',
] as const

/** The documented template §4.2 requires, header row included. */
export const PARTICIPANT_CSV_TEMPLATE =
  'display_name,username,handicap_index,handicap_source,effective_from,status\n' +
  'Casey Morgan,casey.morgan,12.4,manual_verified,2026-09-01,active\n' +
  'Jordan Lee,,-1.2,league_value,2026-09-01,active\n'

export const HANDICAP_SOURCES = [
  'manual_verified',
  'authorized_import',
  'league_value',
  'scratch_fallback',
  'none',
] as const
export type HandicapSource = (typeof HANDICAP_SOURCES)[number]

export const PARTICIPANT_STATUSES = ['active', 'inactive', 'archived'] as const
export type ParticipantStatus = (typeof PARTICIPANT_STATUSES)[number]

export interface ParticipantImportRow {
  displayName: string
  /** null when the player is a guest with no sign-in account. */
  username: string | null
  /** Signed index in tenths; plus handicaps negative. null = no handicap row. */
  handicapValue: number | null
  handicapSource: HandicapSource
  /** ISO date the handicap takes effect; null when no handicap is supplied. */
  effectiveFrom: string | null
  status: ParticipantStatus
}

export interface ParticipantImportReport {
  /** Rows that passed validation and would be written. */
  rows: ParticipantImportRow[]
  issues: CsvIssue[]
  /** Rows read from the file, including those rejected. */
  rowsRead: number
  /** True when nothing blocks an apply (warnings alone never block). */
  ok: boolean
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const USERNAME = /^[a-z0-9._-]{3,32}$/

function isRealDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/**
 * Validate a participant CSV. The returned rows are exactly what an apply
 * would write, so the organizer's dry run and the write cannot disagree.
 */
export function reviewParticipantCsv(text: string): ParticipantImportReport {
  const table = parseCsv(text)
  const issues = [...table.issues]
  const rows: ParticipantImportRow[] = []

  if (table.headers.length > 0 && !table.headers.includes('display_name')) {
    issues.push({
      row: 0,
      column: 'display_name',
      code: 'missing_column',
      message: "A 'display_name' column is required.",
      warning: false,
    })
  }
  for (const header of table.headers) {
    if (header === '') continue
    if (!(PARTICIPANT_CSV_COLUMNS as readonly string[]).includes(header)) {
      issues.push({
        row: 0,
        column: header,
        code: 'unknown_column',
        message: `Column '${header}' is not part of the template and was ignored.`,
        warning: true,
      })
    }
  }

  const seenNames = new Set<string>()
  const seenUsernames = new Set<string>()

  table.rows.forEach((row, index) => {
    const rowNumber = index + 1
    const rowIssues: CsvIssue[] = []
    const fail = (
      column: string,
      code: CsvIssue['code'],
      message: string,
    ): void => {
      rowIssues.push({ row: rowNumber, column, code, message, warning: false })
    }

    const displayName = row['display_name'] ?? ''
    if (displayName === '') {
      fail('display_name', 'required', 'A display name is required.')
    } else if (FORMULA_PREFIX.test(displayName)) {
      rowIssues.push({
        row: rowNumber,
        column: 'display_name',
        code: 'formula_string',
        message:
          `'${displayName}' begins with a spreadsheet formula character. ` +
          'It will be stored exactly as written.',
        warning: true,
      })
    }
    const nameKey = displayName.toLocaleLowerCase()
    if (displayName !== '' && seenNames.has(nameKey)) {
      rowIssues.push({
        row: rowNumber,
        column: 'display_name',
        code: 'duplicate_key',
        message:
          `'${displayName}' appears earlier in this file. Duplicate display ` +
          'names are allowed in a league, so this row was kept — confirm it is a different person.',
        warning: true,
      })
    }
    seenNames.add(nameKey)

    const rawUsername = (row['username'] ?? '').toLowerCase()
    let username: string | null = null
    if (rawUsername !== '') {
      if (!USERNAME.test(rawUsername)) {
        fail(
          'username',
          'invalid_enum',
          `'${rawUsername}' is not a valid username: 3-32 characters of a-z, 0-9, dot, underscore, hyphen.`,
        )
      } else if (seenUsernames.has(rawUsername)) {
        fail('username', 'duplicate_key', `Username '${rawUsername}' appears more than once in this file.`)
      } else {
        seenUsernames.add(rawUsername)
        username = rawUsername
      }
    }

    const rawHandicap = row['handicap_index'] ?? ''
    let handicapValue: number | null = null
    if (rawHandicap !== '') {
      // A leading '+' is how golf writes a plus handicap; internally it is
      // negative (§7.3). Accept both notations and never guess at the sign.
      const plusNotation = /^\+\d+(\.\d+)?$/.test(rawHandicap)
      const numeric = Number(plusNotation ? `-${rawHandicap.slice(1)}` : rawHandicap)
      if (!Number.isFinite(numeric)) {
        fail('handicap_index', 'invalid_number', `'${rawHandicap}' is not a number.`)
      } else if (Math.round(numeric * 10) !== numeric * 10) {
        fail('handicap_index', 'invalid_number', `'${rawHandicap}' has more precision than tenths.`)
      } else if (numeric < -10 || numeric > 54) {
        fail('handicap_index', 'out_of_range', `'${rawHandicap}' is outside the supported -10 to 54 range.`)
      } else {
        handicapValue = numeric
      }
    }

    const rawSource = row['handicap_source'] ?? ''
    let handicapSource: HandicapSource = 'manual_verified'
    if (rawSource !== '') {
      if (!(HANDICAP_SOURCES as readonly string[]).includes(rawSource)) {
        fail(
          'handicap_source',
          'invalid_enum',
          `'${rawSource}' is not a handicap source. Use one of: ${HANDICAP_SOURCES.join(', ')}.`,
        )
      } else handicapSource = rawSource as HandicapSource
    }

    const rawEffective = row['effective_from'] ?? ''
    let effectiveFrom: string | null = null
    if (rawEffective !== '') {
      if (!isRealDate(rawEffective)) {
        fail('effective_from', 'invalid_date', `'${rawEffective}' is not a YYYY-MM-DD date.`)
      } else effectiveFrom = rawEffective
    }
    if (handicapValue !== null && effectiveFrom === null && rawEffective === '') {
      // Defaulted rather than rejected: a roster pasted without dates is the
      // common case, and the organizer sees the date in the preview.
      effectiveFrom = new Date().toISOString().slice(0, 10)
    }
    if (handicapValue === null && rawEffective !== '') {
      rowIssues.push({
        row: rowNumber,
        column: 'effective_from',
        code: 'required',
        message: 'An effective date without a handicap index has no effect.',
        warning: true,
      })
    }

    const rawStatus = row['status'] ?? ''
    let status: ParticipantStatus = 'active'
    if (rawStatus !== '') {
      if (!(PARTICIPANT_STATUSES as readonly string[]).includes(rawStatus)) {
        fail(
          'status',
          'invalid_enum',
          `'${rawStatus}' is not a status. Use one of: ${PARTICIPANT_STATUSES.join(', ')}.`,
        )
      } else status = rawStatus as ParticipantStatus
    }

    issues.push(...rowIssues)
    if (rowIssues.some((issue) => !issue.warning)) return
    rows.push({
      displayName,
      username,
      handicapValue,
      handicapSource,
      effectiveFrom: handicapValue === null ? null : effectiveFrom,
      status,
    })
  })

  return {
    rows,
    issues,
    rowsRead: table.rows.length,
    ok: rows.length > 0 && !issues.some((issue) => !issue.warning),
  }
}

// ── Course hole import (§4.3) ───────────────────────────────────────────────

export const COURSE_HOLES_CSV_TEMPLATE =
  'hole,par,yardage,stroke_index\n1,4,388,5\n2,3,167,17\n'

export interface CourseHoleRow {
  ordinal: number
  par: number
  yardage: number | null
  strokeIndex: number
}

export interface CourseHolesReport {
  holes: CourseHoleRow[]
  issues: CsvIssue[]
  ok: boolean
}

const HOLE_COLUMN_ALIASES: Record<string, string> = {
  hole: 'ordinal',
  hole_number: 'ordinal',
  ordinal: 'ordinal',
  par: 'par',
  yardage: 'yardage',
  yards: 'yardage',
  distance: 'yardage',
  stroke_index: 'stroke_index',
  index: 'stroke_index',
  si: 'stroke_index',
  handicap: 'stroke_index',
}

/**
 * Parse a hole table from either a headed CSV or the bare
 * `ordinal, par, yardage, strokeIndex` lines the catalog form has always
 * accepted, so an organizer can paste a spreadsheet export or type four
 * numbers per line without choosing a mode first.
 *
 * The completeness rule is not cosmetic: `allocateStrokes` throws unless the
 * stroke indexes are a permutation of 1..N, because that permutation is what
 * turns a Playing Handicap into strokes on specific holes. A tee saved with a
 * duplicate index yields an event that cannot be scored at all.
 */
export function reviewCourseHolesCsv(text: string): CourseHolesReport {
  const trimmed = text.replace(/^﻿/, '').trim()
  if (trimmed === '') {
    return {
      holes: [],
      issues: [{ row: 0, code: 'empty_file', message: 'No holes were provided.', warning: false }],
      ok: false,
    }
  }

  const firstLine = trimmed.split(/\r\n|\r|\n/, 1)[0] ?? ''
  const headed = /[a-z]/i.test(firstLine)
  const issues: CsvIssue[] = []
  const holes: CourseHoleRow[] = []

  const numeric = (
    value: string,
    row: number,
    column: string,
    { min, max, optional = false }: { min: number; max: number; optional?: boolean },
  ): number | null | undefined => {
    if (value === '') {
      if (optional) return null
      issues.push({ row, column, code: 'required', message: `${column} is required.`, warning: false })
      return undefined
    }
    const parsed = Number(value)
    if (!Number.isInteger(parsed)) {
      issues.push({ row, column, code: 'invalid_number', message: `'${value}' is not a whole number.`, warning: false })
      return undefined
    }
    if (parsed < min || parsed > max) {
      issues.push({
        row,
        column,
        code: 'out_of_range',
        message: `'${value}' is outside the supported ${min}-${max} range for ${column}.`,
        warning: false,
      })
      return undefined
    }
    return parsed
  }

  const readRow = (
    row: number,
    ordinalText: string,
    parText: string,
    yardageText: string,
    indexText: string,
  ): void => {
    const ordinal = numeric(ordinalText, row, 'hole', { min: 1, max: 18 })
    const par = numeric(parText, row, 'par', { min: 3, max: 6 })
    const yardage = numeric(yardageText, row, 'yardage', { min: 30, max: 800, optional: true })
    const strokeIndex = numeric(indexText, row, 'stroke_index', { min: 1, max: 18 })
    if (
      ordinal === undefined || ordinal === null ||
      par === undefined || par === null ||
      yardage === undefined ||
      strokeIndex === undefined || strokeIndex === null
    ) return
    holes.push({ ordinal, par, yardage, strokeIndex })
  }

  if (headed) {
    const table = parseCsv(trimmed)
    issues.push(...table.issues)
    const mapped = new Map<string, string>()
    for (const header of table.headers) {
      const canonical = HOLE_COLUMN_ALIASES[header]
      if (canonical !== undefined && !mapped.has(canonical)) mapped.set(canonical, header)
    }
    for (const required of ['ordinal', 'par', 'stroke_index']) {
      if (!mapped.has(required)) {
        issues.push({
          row: 0,
          column: required,
          code: 'missing_column',
          message: `A '${required === 'ordinal' ? 'hole' : required}' column is required.`,
          warning: false,
        })
      }
    }
    if (issues.some((issue) => !issue.warning)) return { holes: [], issues, ok: false }
    table.rows.forEach((row, index) => {
      readRow(
        index + 1,
        row[mapped.get('ordinal') as string] ?? '',
        row[mapped.get('par') as string] ?? '',
        mapped.has('yardage') ? row[mapped.get('yardage') as string] ?? '' : '',
        row[mapped.get('stroke_index') as string] ?? '',
      )
    })
  } else {
    trimmed.split(/\r\n|\r|\n/).forEach((line, index) => {
      if (line.trim() === '') return
      const cells = line.split(',').map((cell) => cell.trim())
      readRow(index + 1, cells[0] ?? '', cells[1] ?? '', cells[2] ?? '', cells[3] ?? '')
    })
  }

  if (holes.length !== 9 && holes.length !== 18) {
    issues.push({
      row: 0,
      code: 'out_of_range',
      message: `A layout must have 9 or 18 holes; ${holes.length} were read.`,
      warning: false,
    })
  } else {
    const ordinals = new Set(holes.map((hole) => hole.ordinal))
    const indexes = new Set(holes.map((hole) => hole.strokeIndex))
    const complete = (values: Set<number>): boolean =>
      values.size === holes.length && [...values].every((v) => v >= 1 && v <= holes.length)
    if (!complete(ordinals)) {
      issues.push({
        row: 0,
        column: 'hole',
        code: 'duplicate_key',
        message: `Hole numbers must be a complete 1-${holes.length} set with no repeats.`,
        warning: false,
      })
    }
    if (!complete(indexes)) {
      issues.push({
        row: 0,
        column: 'stroke_index',
        code: 'duplicate_key',
        message:
          `Stroke indexes must be a complete 1-${holes.length} set with no repeats. ` +
          'A tee with a duplicate index produces an event that cannot be scored.',
        warning: false,
      })
    }
  }

  const ok = !issues.some((issue) => !issue.warning)
  return { holes: ok ? holes.sort((a, b) => a.ordinal - b.ordinal) : [], issues, ok }
}

// ── Export (§4.2) ───────────────────────────────────────────────────────────

/**
 * Quote a cell for export. A leading formula character is prefixed with a
 * single quote so reopening the export in a spreadsheet cannot execute a name
 * that was only ever text.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  const text = String(value)
  const guarded = FORMULA_PREFIX.test(text) ? `'${text}` : text
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

export function toCsv(
  headers: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>,
): string {
  const lines = [headers.map(csvCell).join(',')]
  for (const row of rows) lines.push(row.map(csvCell).join(','))
  return `${lines.join('\r\n')}\r\n`
}
