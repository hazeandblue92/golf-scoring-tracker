#!/usr/bin/env node

/**
 * Restore a gtt-portable-export into a fresh Supabase project.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     npm run restore:export -- ./gtt-event.json
 *
 * Identity records are intentionally excluded from portable exports. Linked
 * players restore as guest participants; organizers provision accounts again
 * on the target deployment.
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createClient } from '@supabase/supabase-js'

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
}

const [file] = process.argv.slice(2)
const url = process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!file || !url || !serviceRoleKey) {
  fail('Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run restore:export -- <export.json>')
} else {
  const document = JSON.parse(await readFile(file, 'utf8'))
  const { integrityHash, correlationId: _correlationId, ...core } = document
  const calculated = createHash('sha256').update(stable(core)).digest('hex')
  if (integrityHash !== calculated) {
    fail(`Export integrity check failed: expected ${integrityHash}, calculated ${calculated}`)
  } else if (document.format !== 'gtt-portable-export' || document.schemaVersion !== 1) {
    fail('Unsupported export format or schema version')
  } else {
    const client = createClient(url, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const order = [
      'leagues',
      'seasons',
      'participants',
      'participant_handicaps',
      'courses',
      'course_layouts',
      'tee_sets',
      'tee_holes',
      'events',
      'rounds',
      'event_tee_snapshots',
      'event_holes',
      'flights',
      'event_entries',
      'event_teams',
      'event_team_members',
      'groups',
      'group_members',
      'competitions',
      'competition_rounds',
      'competition_entities',
      'individual_hole_scores',
      'team_hole_scores',
      'score_conflicts',
      'competition_projections',
      'leaderboard_rows',
      'hole_results',
    ]
    let restored = 0
    for (const table of order) {
      const rows = document.tables?.[table] ?? []
      if (rows.length === 0) continue
      const { error } = await client.from(table).insert(rows)
      if (error) {
        fail(`Restore failed at ${table}: ${error.message}`)
        break
      }
      restored += rows.length
      process.stdout.write(`Restored ${rows.length} ${table} row(s)\n`)
    }

    if (process.exitCode !== 1) {
      for (const expected of document.finalResultHashes ?? []) {
        const { data, error } = await client
          .from('competitions')
          .select('final_result_hash')
          .eq('id', expected.competitionId)
          .single()
        if (error || data?.final_result_hash !== expected.hash) {
          fail(`Final result hash verification failed for ${expected.competitionId}`)
          break
        }
      }
    }
    if (process.exitCode !== 1) {
      process.stdout.write(`Restore complete: ${restored} rows; integrity and final hashes verified.\n`)
    }
  }
}
