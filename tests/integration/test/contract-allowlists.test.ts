/**
 * Cross-layer allowlist consistency (spec §17.1).
 *
 * The sanitized error-report allowlist is declared twice: `appRouteFamilies` /
 * `appErrorCodes` in the contracts package, and SQL arrays inside
 * `record_phase4_error`. Nothing forces them to agree, and divergence fails
 * silently in the worst possible way — the database raises, `report-error`
 * answers 503, and client error reporting goes dark during exactly the
 * incident it exists to record.
 *
 * This lives here rather than in the contracts package because that package is
 * deliberately environment-agnostic (browser, Deno, and Node) and carries no
 * Node type definitions, so it cannot read the migration from disk. It needs
 * no running stack: it compares two files.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  appErrorCodes,
  appRouteFamilies,
} from '../../../packages/contracts/src/phase4.ts'

const MIGRATION = fileURLToPath(
  new URL(
    '../../../supabase/migrations/20260810000020_phase4_operations_hardening.sql',
    import.meta.url,
  ),
)

/** Pull the quoted values out of the SQL `array[...]` following a marker. */
function sqlAllowlist(source: string, marker: string): string[] {
  const start = source.indexOf(marker)
  if (start < 0) throw new Error(`marker not found in migration: ${marker}`)
  const open = source.indexOf('array[', start)
  const close = source.indexOf(']', open)
  if (open < 0 || close < 0) throw new Error(`array literal not found after ${marker}`)
  return [...source.slice(open, close).matchAll(/'([^']+)'/g)]
    .map((match) => match[1])
    .sort()
}

describe('sanitized error allowlists agree across contract and database', () => {
  it('route families match record_phase4_error exactly', async () => {
    const sql = await readFile(MIGRATION, 'utf8')
    const fromSql = sqlAllowlist(sql, 'p_route_family <> all(')
    // Guard against a parse that silently matches nothing.
    expect(fromSql.length).toBeGreaterThan(0)
    expect(fromSql).toEqual([...appRouteFamilies].sort())
  })

  it('error codes match record_phase4_error exactly', async () => {
    const sql = await readFile(MIGRATION, 'utf8')
    const fromSql = sqlAllowlist(sql, 'p_error_code <> all(')
    expect(fromSql.length).toBeGreaterThan(0)
    expect(fromSql).toEqual([...appErrorCodes].sort())
  })
})
