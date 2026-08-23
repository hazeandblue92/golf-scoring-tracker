/** Atomic portable-restore boundary and fresh-target recovery drill. */

import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'

import { serviceClient, stackIsUp } from '../helpers/stack.ts'

const freshTarget = process.env.PORTABLE_RESTORE_FRESH_TARGET === '1'
const service = serviceClient()

function leagueRow(id = randomUUID()) {
  const now = new Date().toISOString()
  return {
    id,
    name: `Portable ${id.slice(0, 8)}`,
    slug: `portable-${id.slice(0, 8)}`,
    timezone: 'America/Detroit',
    locale: 'en-US',
    privacy_notice_version: 1,
    settings_json: {},
    status: 'archived',
    created_at: now,
    updated_at: now,
  }
}

beforeAll(async () => {
  expect(await stackIsUp(), 'local Supabase stack must be running').toBe(true)
})

describe.skipIf(freshTarget)('portable restore on the normal seeded stack', () => {
  it('rejects any attempt to use the bypass on a non-fresh target', async () => {
    const league = leagueRow()
    const restored = await service.rpc('restore_portable_export', {
      p_tables: { leagues: [league] },
    })
    expect(restored.error?.code).toBe('23514')

    const persisted = await service.from('leagues').select('id').eq('id', league.id)
    if (persisted.error) throw persisted.error
    expect(persisted.data).toEqual([])
  })
})

describe.runIf(freshTarget)('portable restore on a migration-only fresh target', () => {
  it('rejects identity-linked authority before writing anything', async () => {
    const league = leagueRow()
    const now = new Date().toISOString()
    const restored = await service.rpc('restore_portable_export', {
      p_tables: {
        leagues: [league],
        participants: [{
          id: randomUUID(),
          league_id: league.id,
          profile_id: randomUUID(),
          display_name: 'Identity must not restore',
          sort_name: 'Identity must not restore',
          external_ref: null,
          status: 'active',
          organizer_notes: null,
          created_at: now,
          updated_at: now,
        }],
      },
    })
    expect(restored.error?.code).toBe('22023')

    const leagues = await service.from('leagues').select('id')
    if (leagues.error) throw leagues.error
    expect(leagues.data).toEqual([])
  })

  it('rolls back an early parent when a later child is invalid', async () => {
    const league = leagueRow()
    const now = new Date().toISOString()
    const restored = await service.rpc('restore_portable_export', {
      p_tables: {
        leagues: [league],
        course_layouts: [{
          id: randomUUID(),
          course_id: randomUUID(),
          name: 'Missing parent layout',
          hole_count: 18,
          version: 1,
          effective_from: null,
          retired_at: null,
          created_at: now,
          updated_at: now,
        }],
      },
    })
    expect(restored.error?.code).toBe('23503')

    const leagues = await service.from('leagues').select('id')
    if (leagues.error) throw leagues.error
    expect(leagues.data).toEqual([])
  })

  it('commits a valid payload once and rejects a retry', async () => {
    const league = leagueRow()
    const now = new Date().toISOString()
    const participant = {
      id: randomUUID(),
      league_id: league.id,
      profile_id: null,
      display_name: 'Portable unused participant',
      sort_name: 'Portable unused participant',
      external_ref: null,
      status: 'active',
      organizer_notes: null,
      created_at: now,
      updated_at: now,
    }
    const team = {
      id: randomUUID(),
      league_id: league.id,
      season_id: null,
      name: 'Portable catalog team',
      status: 'active',
      created_at: now,
      updated_at: now,
    }
    const member = {
      id: randomUUID(),
      team_id: team.id,
      participant_id: participant.id,
      valid_from: '2026-01-01',
      valid_to: null,
      created_at: now,
    }
    const first = await service.rpc('restore_portable_export', {
      p_tables: {
        leagues: [league],
        participants: [participant],
        teams: [team],
        team_members: [member],
      },
    })
    expect(first.error).toBeNull()
    expect(first.data).toEqual({
      status: 'restored',
      totalRows: 4,
      counts: {
        leagues: 1,
        participants: 1,
        teams: 1,
        team_members: 1,
      },
    })

    const retry = await service.rpc('restore_portable_export', {
      p_tables: { leagues: [league] },
    })
    expect(retry.error?.code).toBe('23514')

    const persisted = await service.from('leagues').select('id').eq('id', league.id)
    if (persisted.error) throw persisted.error
    expect(persisted.data).toEqual([{ id: league.id }])
    const restoredMember = await service.from('team_members')
      .select('team_id,participant_id')
      .eq('id', member.id)
      .single()
    if (restoredMember.error) throw restoredMember.error
    expect(restoredMember.data).toEqual({
      team_id: team.id,
      participant_id: participant.id,
    })
  })
})
