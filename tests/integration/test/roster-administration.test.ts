/**
 * Roster administration: handicap revisions, participant status, season
 * status, and CSV import (spec §4.2).
 *
 * Before this, a handicap could be set once — when the player was created —
 * and never changed. `participant_handicaps` protects its history with a gist
 * exclusion over [effective_from, effective_to), so a second insert for an
 * open-ended row raises 23P01. Migration 39 closes the superseded interval and
 * opens the next one in a single statement; these tests prove the interval
 * arithmetic, because getting it wrong silently leaves a player with no
 * handicap for a period, and a net competition would score them as
 * unhandicapped rather than refusing.
 */

import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'

import { createAccount, LEAGUE_ID } from '../helpers/fixture.ts'
import { callFunction, serviceClient, stackIsUp } from '../helpers/stack.ts'

describe('roster administration (§4.2)', () => {
  const service = serviceClient()
  let owner: Awaited<ReturnType<typeof createAccount>>
  let outsider: Awaited<ReturnType<typeof createAccount>>

  async function handicapRows(participantId: string) {
    const { data, error } = await service
      .from('participant_handicaps')
      .select('value, source, effective_from, effective_to, verified_by')
      .eq('participant_id', participantId)
      .order('effective_from', { ascending: true })
    if (error) throw error
    return data ?? []
  }

  async function addPlayer(displayName: string, handicapValue: number | null) {
    const response = await callFunction<{ status: string; id: string }>('catalog-admin', {
      action: 'save-participant',
      leagueId: LEAGUE_ID,
      displayName,
      handicapValue,
    }, owner.accessToken)
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    return response.body.id
  }

  beforeAll(async () => {
    expect(await stackIsUp(), 'local Supabase stack must be running').toBe(true)
    owner = await createAccount(service, { displayName: 'Roster Owner', withMfa: true })
    const membership = await service.from('league_memberships').insert({
      league_id: LEAGUE_ID, profile_id: owner.profileId, member_status: 'active',
    })
    if (membership.error) throw membership.error
    const role = await service.from('role_assignments').insert({
      league_id: LEAGUE_ID, profile_id: owner.profileId, role: 'owner',
    })
    if (role.error) throw role.error

    // A signed-in account with MFA but no role in this league.
    outsider = await createAccount(service, { displayName: 'No Role', withMfa: true })
  }, 240_000)

  it('records a second handicap by closing the first interval, not by failing', async () => {
    const participantId = await addPlayer(`Revision ${randomUUID().slice(0, 8)}`, 12.4)

    const later = new Date()
    later.setUTCDate(later.getUTCDate() + 7)
    const effective = later.toISOString().slice(0, 10)

    const update = await callFunction<{ status: string }>('catalog-admin', {
      action: 'save-participant',
      leagueId: LEAGUE_ID,
      id: participantId,
      displayName: 'Revision Player',
      handicapValue: 10.2,
      handicapSource: 'league_value',
      handicapEffectiveFrom: effective,
    }, owner.accessToken)
    expect(update.status, JSON.stringify(update.body)).toBe(200)

    const rows = await handicapRows(participantId)
    expect(rows).toHaveLength(2)
    // The old value is retained and bounded, never deleted: frozen event
    // snapshots cite the value effective on their own date (§6.2).
    expect(Number(rows[0]?.value)).toBe(12.4)
    expect(rows[0]?.effective_to).toBe(effective)
    expect(Number(rows[1]?.value)).toBe(10.2)
    expect(rows[1]?.effective_from).toBe(effective)
    expect(rows[1]?.effective_to).toBeNull()
    expect(rows[1]?.source).toBe('league_value')
    expect(rows[1]?.verified_by).toBe(owner.profileId)
  })

  it('treats a same-day change as a correction to the open interval', async () => {
    const participantId = await addPlayer(`Correction ${randomUUID().slice(0, 8)}`, 8)
    const today = new Date().toISOString().slice(0, 10)

    const correction = await callFunction('catalog-admin', {
      action: 'save-participant',
      leagueId: LEAGUE_ID,
      id: participantId,
      displayName: 'Correction Player',
      handicapValue: 8.5,
      handicapEffectiveFrom: today,
    }, owner.accessToken)
    expect(correction.status, JSON.stringify(correction.body)).toBe(200)

    const rows = await handicapRows(participantId)
    expect(rows).toHaveLength(1)
    expect(Number(rows[0]?.value)).toBe(8.5)
    expect(rows[0]?.effective_to).toBeNull()
  })

  it('back-fills an earlier value bounded by the interval that follows it', async () => {
    const participantId = await addPlayer(`Backfill ${randomUUID().slice(0, 8)}`, 14)
    const today = new Date().toISOString().slice(0, 10)
    const earlier = new Date()
    earlier.setUTCDate(earlier.getUTCDate() - 30)
    const earlierDate = earlier.toISOString().slice(0, 10)

    // Remove the auto-dated opening row's claim on the past by writing an
    // older interval; it must stop where the current one starts.
    const backfill = await callFunction('catalog-admin', {
      action: 'save-participant',
      leagueId: LEAGUE_ID,
      id: participantId,
      displayName: 'Backfill Player',
      handicapValue: 16.1,
      handicapEffectiveFrom: earlierDate,
    }, owner.accessToken)
    expect(backfill.status, JSON.stringify(backfill.body)).toBe(200)

    const rows = await handicapRows(participantId)
    expect(rows).toHaveLength(2)
    expect(rows[0]?.effective_from).toBe(earlierDate)
    expect(rows[0]?.effective_to).toBe(today)
    expect(rows[1]?.effective_from).toBe(today)
    expect(rows[1]?.effective_to).toBeNull()
  })

  it('refuses a handicap outside the supported range or finer than tenths', async () => {
    const participantId = await addPlayer(`Range ${randomUUID().slice(0, 8)}`, null)
    for (const handicapValue of [99, 12.34]) {
      const response = await callFunction('catalog-admin', {
        action: 'save-participant',
        leagueId: LEAGUE_ID,
        id: participantId,
        displayName: 'Range Player',
        handicapValue,
      }, owner.accessToken)
      expect(response.status, JSON.stringify(response.body)).toBe(409)
    }
    expect(await handicapRows(participantId)).toHaveLength(0)
  })

  it('refuses a handicap write from an account with no role in the league', async () => {
    const participantId = await addPlayer(`Denied ${randomUUID().slice(0, 8)}`, 5)
    const response = await callFunction('catalog-admin', {
      action: 'save-participant',
      leagueId: LEAGUE_ID,
      id: participantId,
      displayName: 'Denied Player',
      handicapValue: 6,
    }, outsider.accessToken)
    expect(response.status).toBe(403)
    expect((await handicapRows(participantId)).map((r) => Number(r.value))).toEqual([5])
  })

  it('makes a player inactive without deleting them, and back again', async () => {
    const participantId = await addPlayer(`Status ${randomUUID().slice(0, 8)}`, null)
    for (const status of ['inactive', 'active']) {
      const response = await callFunction('catalog-admin', {
        action: 'save-participant',
        leagueId: LEAGUE_ID,
        id: participantId,
        displayName: 'Status Player',
        status,
      }, owner.accessToken)
      expect(response.status, JSON.stringify(response.body)).toBe(200)
      const { data } = await service.from('participants').select('status').eq('id', participantId).single()
      expect(data?.status).toBe(status)
    }
  })

  it('keeps a season status through a rename, and moves it when asked', async () => {
    // Seasons are unique by (league_id, name), so every name here carries the
    // run's tag; a fixed name passes once and then collides for ever.
    const tag = randomUUID().slice(0, 8)
    const created = await callFunction<{ id: string }>('catalog-admin', {
      action: 'save-season',
      leagueId: LEAGUE_ID,
      name: `Season ${tag}`,
      startsOn: '2026-04-01',
      endsOn: '2026-10-31',
    }, owner.accessToken)
    expect(created.status, JSON.stringify(created.body)).toBe(200)
    const seasonId = created.body.id

    const activate = await callFunction('catalog-admin', {
      action: 'save-season', leagueId: LEAGUE_ID, id: seasonId,
      name: `Active ${tag}`, startsOn: '2026-04-01', endsOn: '2026-10-31', status: 'active',
    }, owner.accessToken)
    expect(activate.status, JSON.stringify(activate.body)).toBe(200)

    // A rename with no status must not quietly reset an active season to
    // planned, which is what the unconditional default used to do.
    const rename = await callFunction('catalog-admin', {
      action: 'save-season', leagueId: LEAGUE_ID, id: seasonId,
      name: `Renamed ${tag}`, startsOn: '2026-04-01', endsOn: '2026-10-31',
    }, owner.accessToken)
    expect(rename.status, JSON.stringify(rename.body)).toBe(200)

    const { data } = await service.from('seasons').select('name, status').eq('id', seasonId).single()
    expect(data).toMatchObject({ name: `Renamed ${tag}`, status: 'active' })

    const invalid = await callFunction('catalog-admin', {
      action: 'save-season', leagueId: LEAGUE_ID, id: seasonId,
      name: `Renamed ${tag}`, startsOn: '2026-04-01', endsOn: '2026-10-31', status: 'retired',
    }, owner.accessToken)
    expect(invalid.status).toBe(409)
  })

  describe('CSV import (§4.2, §21.2)', () => {
    it('previews without writing, then applies exactly what it previewed', async () => {
      const tag = randomUUID().slice(0, 8)
      const csv =
        'display_name,handicap_index,handicap_source,status\r\n' +
        `Import One ${tag},12.4,manual_verified,active\r\n` +
        `Import Two ${tag},+1.2,league_value,inactive\r\n`

      const preview = await callFunction<{
        status: string; applied: number; rowsRead: number; ok: boolean
        plan: Array<{ displayName: string; action: string; handicap: number | null }>
      }>('catalog-admin', {
        action: 'import-participants', leagueId: LEAGUE_ID, csv, mode: 'preview',
      }, owner.accessToken)
      expect(preview.status, JSON.stringify(preview.body)).toBe(200)
      expect(preview.body.status).toBe('previewed')
      expect(preview.body.applied).toBe(0)
      expect(preview.body.ok).toBe(true)
      expect(preview.body.plan.map((row) => row.action)).toEqual(['create', 'create'])
      // Plus notation becomes the internal negative (§7.3).
      expect(preview.body.plan[1]?.handicap).toBe(-1.2)

      const beforeApply = await service
        .from('participants').select('id').eq('league_id', LEAGUE_ID).ilike('display_name', `%${tag}%`)
      expect(beforeApply.data ?? []).toHaveLength(0)

      const applied = await callFunction<{ status: string; applied: number }>('catalog-admin', {
        action: 'import-participants', leagueId: LEAGUE_ID, csv, mode: 'apply',
      }, owner.accessToken)
      expect(applied.status, JSON.stringify(applied.body)).toBe(200)
      expect(applied.body).toMatchObject({ status: 'imported', applied: 2 })

      const { data: written } = await service
        .from('participants').select('id, display_name, status')
        .eq('league_id', LEAGUE_ID).ilike('display_name', `%${tag}%`).order('display_name')
      expect(written).toHaveLength(2)
      expect(written?.[1]?.status).toBe('inactive')
      const first = await handicapRows(written?.[0]?.id as string)
      expect(Number(first[0]?.value)).toBe(12.4)
    })

    it('re-importing updates the existing player and revises the handicap', async () => {
      const tag = randomUUID().slice(0, 8)
      const name = `Reimport ${tag}`
      const first = `display_name,handicap_index\n${name},20\n`
      await callFunction('catalog-admin', {
        action: 'import-participants', leagueId: LEAGUE_ID, csv: first, mode: 'apply',
      }, owner.accessToken)

      const tomorrow = new Date()
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
      const effective = tomorrow.toISOString().slice(0, 10)
      const second = `display_name,handicap_index,effective_from\n${name},18,${effective}\n`
      const again = await callFunction<{ applied: number; plan: Array<{ action: string }> }>(
        'catalog-admin',
        { action: 'import-participants', leagueId: LEAGUE_ID, csv: second, mode: 'apply' },
        owner.accessToken,
      )
      expect(again.status, JSON.stringify(again.body)).toBe(200)
      expect(again.body.plan[0]?.action).toBe('update')

      const { data: rows } = await service
        .from('participants').select('id').eq('league_id', LEAGUE_ID).eq('display_name', name)
      expect(rows).toHaveLength(1)
      const history = await handicapRows(rows?.[0]?.id as string)
      expect(history.map((r) => Number(r.value))).toEqual([20, 18])
    })

    it('refuses to apply a file with a row error, and writes nothing', async () => {
      const tag = randomUUID().slice(0, 8)
      const csv =
        'display_name,handicap_index,handicap_source\n' +
        `Bad Source ${tag},10,not_a_source\n` +
        `Good Row ${tag},11,league_value\n`

      const response = await callFunction<{
        status: string; applied: number; ok: boolean
        issues: Array<{ row: number; column?: string; code: string; warning: boolean }>
      }>('catalog-admin', {
        action: 'import-participants', leagueId: LEAGUE_ID, csv, mode: 'apply',
      }, owner.accessToken)
      expect(response.status, JSON.stringify(response.body)).toBe(200)
      expect(response.body).toMatchObject({ status: 'previewed', applied: 0, ok: false })
      expect(response.body.issues.some((i) => i.code === 'invalid_enum' && !i.warning)).toBe(true)

      const { data } = await service
        .from('participants').select('id').eq('league_id', LEAGUE_ID).ilike('display_name', `%${tag}%`)
      expect(data ?? []).toHaveLength(0)
    })

    it('links a row to an existing account by username and reports one that has none', async () => {
      const tag = randomUUID().slice(0, 8)
      const username = `csv${tag}`
      const created = await callFunction<{ profileId: string }>('account-admin', {
        action: 'create', username, displayName: `Linked ${tag}`,
      }, owner.accessToken)
      expect(created.status, JSON.stringify(created.body)).toBe(200)

      const csv =
        'display_name,username\n' +
        `Linked ${tag},${username}\n` +
        `Guest ${tag},missing${tag}\n`
      const response = await callFunction<{
        applied: number
        plan: Array<{ displayName: string; account: string }>
        issues: Array<{ code: string; column?: string; warning: boolean }>
      }>('catalog-admin', {
        action: 'import-participants', leagueId: LEAGUE_ID, csv, mode: 'apply',
      }, owner.accessToken)
      expect(response.status, JSON.stringify(response.body)).toBe(200)
      expect(response.body.applied).toBe(2)
      expect(response.body.plan[0]?.account).toBe('linked')
      expect(response.body.plan[1]?.account).toBe('unknown_username')
      // A missing account is a warning, not a rejection: the player still
      // belongs on the roster, they just cannot sign in yet.
      expect(response.body.issues.some((i) => i.column === 'username' && i.warning)).toBe(true)

      const { data } = await service
        .from('participants').select('display_name, profile_id')
        .eq('league_id', LEAGUE_ID).ilike('display_name', `%${tag}%`)
      const linked = data?.find((row) => row.display_name === `Linked ${tag}`)
      const guest = data?.find((row) => row.display_name === `Guest ${tag}`)
      expect(linked?.profile_id).toBe(created.body.profileId)
      expect(guest?.profile_id).toBeNull()
    })

    it('refuses an import from an account with no role in the league', async () => {
      const response = await callFunction('catalog-admin', {
        action: 'import-participants',
        leagueId: LEAGUE_ID,
        csv: 'display_name\nIntruder\n',
        mode: 'apply',
      }, outsider.accessToken)
      expect(response.status).toBe(403)
    })
  })
})
