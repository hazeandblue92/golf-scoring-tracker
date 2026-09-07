/**
 * CSV import contract tests (spec §4.2, §4.3, §21.2).
 *
 * §21.2 names the malformed input this must survive by name — BOM, alternate
 * newline, duplicate header, formula string, unknown enum — and requires that
 * each be reported as a row error rather than aborting the import. Every one
 * of those has a test here, because an import that silently drops a row is
 * indistinguishable to the organizer from one that never had the row.
 */

import { describe, expect, it } from 'vitest'

import {
  PARTICIPANT_CSV_TEMPLATE,
  csvCell,
  parseCsv,
  reviewCourseHolesCsv,
  reviewParticipantCsv,
  toCsv,
} from '../src/csv.ts'

describe('parseCsv survives what real spreadsheets emit (§21.2)', () => {
  it('strips a byte-order mark from the first header', () => {
    const table = parseCsv('﻿display_name,username\nCasey,casey\n')
    expect(table.headers).toEqual(['display_name', 'username'])
    expect(table.rows[0]).toEqual({ display_name: 'Casey', username: 'casey' })
  })

  it('accepts LF, CRLF, and bare CR line endings', () => {
    for (const newline of ['\n', '\r\n', '\r']) {
      const table = parseCsv(`a,b${newline}1,2${newline}3,4${newline}`)
      expect(table.rows).toEqual([
        { a: '1', b: '2' },
        { a: '3', b: '4' },
      ])
    }
  })

  it('keeps the first of a duplicated header and says so', () => {
    const table = parseCsv('display_name,display_name\nCasey,Jordan\n')
    expect(table.rows[0]).toEqual({ display_name: 'Casey' })
    const issue = table.issues.find((i) => i.code === 'duplicate_header')
    expect(issue?.warning).toBe(true)
  })

  it('reads quoted fields containing commas, quotes, and newlines', () => {
    const table = parseCsv('a,b\n"Morgan, Casey","say ""hi""\nagain"\n')
    expect(table.rows[0]?.['a']).toBe('Morgan, Casey')
    expect(table.rows[0]?.['b']).toBe('say "hi"\nagain')
  })

  it('reports a ragged row without discarding it', () => {
    const table = parseCsv('a,b,c\n1,2\n')
    expect(table.rows[0]).toEqual({ a: '1', b: '2', c: '' })
    expect(table.issues.find((i) => i.code === 'ragged_row')?.warning).toBe(true)
  })

  it('ignores blank lines and a trailing newline', () => {
    expect(parseCsv('a\n1\n\n2\n').rows).toEqual([{ a: '1' }, { a: '2' }])
  })

  it('reports an empty file rather than throwing', () => {
    expect(parseCsv('').issues[0]?.code).toBe('empty_file')
  })
})

describe('participant import validates every row and reports the rest (§4.2)', () => {
  it('accepts the documented template', () => {
    const report = reviewParticipantCsv(PARTICIPANT_CSV_TEMPLATE)
    expect(report.ok).toBe(true)
    expect(report.rows).toHaveLength(2)
    expect(report.rows[0]).toMatchObject({
      displayName: 'Casey Morgan',
      username: 'casey.morgan',
      handicapValue: 12.4,
      handicapSource: 'manual_verified',
      status: 'active',
    })
    // A plus handicap is stored negative (§7.3).
    expect(report.rows[1]?.handicapValue).toBe(-1.2)
  })

  it('reads golf plus notation and the internal negative identically', () => {
    const report = reviewParticipantCsv('display_name,handicap_index\nA,+2.0\nB,-2.0\n')
    expect(report.rows.map((r) => r.handicapValue)).toEqual([-2, -2])
  })

  it('rejects an unknown handicap source by name, keeping the other rows', () => {
    const report = reviewParticipantCsv(
      'display_name,handicap_index,handicap_source\nCasey,10,whatever\nJordan,11,league_value\n',
    )
    expect(report.ok).toBe(false)
    expect(report.rows.map((r) => r.displayName)).toEqual(['Jordan'])
    const issue = report.issues.find((i) => i.code === 'invalid_enum')
    expect(issue).toMatchObject({ row: 1, column: 'handicap_source', warning: false })
    expect(issue?.message).toContain('league_value')
  })

  it('rejects a handicap that is not a number, out of range, or finer than tenths', () => {
    const report = reviewParticipantCsv(
      'display_name,handicap_index\nA,abc\nB,99\nC,12.34\nD,12.3\n',
    )
    expect(report.rows.map((r) => r.displayName)).toEqual(['D'])
    expect(report.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['invalid_number', 'out_of_range']),
    )
  })

  it('flags a formula string without rewriting the value', () => {
    const report = reviewParticipantCsv('display_name\n=cmd|calc\n')
    const issue = report.issues.find((i) => i.code === 'formula_string')
    expect(issue?.warning).toBe(true)
    // Kept as written: the organizer decides, the importer does not edit names.
    expect(report.rows[0]?.displayName).toBe('=cmd|calc')
    expect(report.ok).toBe(true)
  })

  it('requires a display_name column and a value in every row', () => {
    expect(reviewParticipantCsv('username\ncasey\n').issues[0]?.code).toBe('missing_column')
    const blank = reviewParticipantCsv('display_name,handicap_index\n,10\nCasey,11\n')
    expect(blank.rows.map((r) => r.displayName)).toEqual(['Casey'])
    expect(blank.issues.find((i) => i.code === 'required')?.row).toBe(1)
  })

  it('rejects a malformed or repeated username but keeps a duplicate display name', () => {
    const report = reviewParticipantCsv(
      'display_name,username\nCasey,Bad Username\nJordan,jordan\nJordan,jordan\n',
    )
    expect(report.issues.find((i) => i.column === 'username' && i.code === 'invalid_enum')?.row).toBe(1)
    expect(report.issues.find((i) => i.code === 'duplicate_key' && i.column === 'username')?.row).toBe(3)
    // Two players really can share a name (§21.1); that is a warning, not a stop.
    const nameWarning = report.issues.find((i) => i.code === 'duplicate_key' && i.column === 'display_name')
    expect(nameWarning?.warning).toBe(true)
  })

  it('ignores an unknown column but says which one', () => {
    const report = reviewParticipantCsv('display_name,favourite_club\nCasey,7 iron\n')
    expect(report.ok).toBe(true)
    expect(report.issues.find((i) => i.code === 'unknown_column')).toMatchObject({
      column: 'favourite_club',
      warning: true,
    })
  })

  it('defaults an effective date only when a handicap is present', () => {
    const withHandicap = reviewParticipantCsv('display_name,handicap_index\nCasey,10\n')
    expect(withHandicap.rows[0]?.effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const withoutHandicap = reviewParticipantCsv('display_name\nCasey\n')
    expect(withoutHandicap.rows[0]?.effectiveFrom).toBeNull()
    expect(withoutHandicap.rows[0]?.handicapValue).toBeNull()
  })

  it('rejects a date that is not a real calendar day', () => {
    const report = reviewParticipantCsv(
      'display_name,handicap_index,effective_from\nCasey,10,2026-02-30\n',
    )
    expect(report.ok).toBe(false)
    expect(report.issues.find((i) => i.code === 'invalid_date')?.row).toBe(1)
  })
})

describe('course hole import (§4.3)', () => {
  const headed = ['hole,par,yardage,stroke_index']
  for (let i = 1; i <= 18; i += 1) headed.push(`${i},4,400,${i}`)
  const headedCsv = `${headed.join('\n')}\n`

  it('reads a headed export and a bare four-column paste identically', () => {
    const fromHeader = reviewCourseHolesCsv(headedCsv)
    const bare = headed.slice(1).join('\n')
    const fromBare = reviewCourseHolesCsv(bare)
    expect(fromHeader.ok).toBe(true)
    expect(fromBare.ok).toBe(true)
    expect(fromBare.holes).toEqual(fromHeader.holes)
    expect(fromHeader.holes).toHaveLength(18)
  })

  it('accepts the column names a course export actually uses', () => {
    const aliased = headedCsv.replace('hole,par,yardage,stroke_index', 'Hole,Par,Yards,SI')
    expect(reviewCourseHolesCsv(aliased).ok).toBe(true)
  })

  it('refuses a duplicated stroke index, because that layout cannot be scored', () => {
    const broken = headedCsv.replace('18,4,400,18', '18,4,400,17')
    const report = reviewCourseHolesCsv(broken)
    expect(report.ok).toBe(false)
    expect(report.holes).toEqual([])
    expect(report.issues.find((i) => i.column === 'stroke_index')?.message).toContain('cannot be scored')
  })

  it('refuses a layout that is not 9 or 18 holes', () => {
    const short = headed.slice(0, 5).join('\n')
    expect(reviewCourseHolesCsv(short).issues.some((i) => i.message.includes('9 or 18'))).toBe(true)
  })

  it('treats yardage as optional but par and index as required', () => {
    const noYardage = ['hole,par,stroke_index']
    for (let i = 1; i <= 9; i += 1) noYardage.push(`${i},4,${i}`)
    const report = reviewCourseHolesCsv(`${noYardage.join('\n')}\n`)
    expect(report.ok).toBe(true)
    expect(report.holes[0]?.yardage).toBeNull()

    const noPar = reviewCourseHolesCsv('hole,yardage\n1,400\n')
    expect(noPar.ok).toBe(false)
    expect(noPar.issues.find((i) => i.code === 'missing_column')?.column).toBe('par')
  })

  it('sorts by hole number so a shuffled export still scores in play order', () => {
    const shuffled = ['hole,par,stroke_index', '9,4,9']
    for (let i = 1; i <= 8; i += 1) shuffled.push(`${i},4,${i}`)
    const report = reviewCourseHolesCsv(`${shuffled.join('\n')}\n`)
    expect(report.holes.map((h) => h.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })
})

describe('CSV export is safe to reopen in a spreadsheet (§4.2)', () => {
  it('quotes separators and escapes embedded quotes', () => {
    expect(csvCell('Morgan, Casey')).toBe('"Morgan, Casey"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell(null)).toBe('')
    expect(csvCell(12.4)).toBe('12.4')
  })

  it('defuses a leading formula character', () => {
    expect(csvCell('=1+1')).toBe("'=1+1")
    expect(csvCell('-2.0')).toBe("'-2.0")
  })

  it('round-trips an exported roster back through the importer', () => {
    const csv = toCsv(
      ['display_name', 'username', 'handicap_index', 'handicap_source', 'effective_from', 'status'],
      [['Morgan, Casey', 'casey', 12.4, 'manual_verified', '2026-09-01', 'active']],
    )
    const report = reviewParticipantCsv(csv)
    expect(report.ok).toBe(true)
    expect(report.rows[0]).toMatchObject({
      displayName: 'Morgan, Casey',
      username: 'casey',
      handicapValue: 12.4,
      effectiveFrom: '2026-09-01',
    })
  })
})
