import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

import { createAccount, LEAGUE_ID } from '../helpers/fixture.ts'
import {
  callFunction,
  serviceClient,
  stackIsUp,
  userClient,
} from '../helpers/stack.ts'

describe('Phase 4 operations hardening', () => {
  const service = serviceClient()
  const seededEventId = '00000000-0000-4000-8000-000000000401'
  let owner: Awaited<ReturnType<typeof createAccount>>
  let outsider: Awaited<ReturnType<typeof createAccount>>

  beforeAll(async () => {
    expect(await stackIsUp(), 'local Supabase stack must be running').toBe(true)
    owner = await createAccount(service, { displayName: 'Phase 4 Operator' })
    outsider = await createAccount(service, { displayName: 'Phase 4 Outsider' })
    const membership = await service.from('league_memberships').insert([
      { league_id: LEAGUE_ID, profile_id: owner.profileId, member_status: 'active' },
      { league_id: LEAGUE_ID, profile_id: outsider.profileId, member_status: 'active' },
    ])
    if (membership.error) throw membership.error
    const role = await service.from('role_assignments').insert({
      league_id: LEAGUE_ID,
      profile_id: owner.profileId,
      role: 'owner',
    })
    if (role.error) throw role.error
  }, 60_000)

  it('reports a schema version that matches the migrations actually shipped', async () => {
    // health/index.ts hard-codes schemaVersion, and AdminOperations renders it
    // to operators as "Schema v<n>". Nothing forces the constant to move when a
    // migration lands, so without this guard the readiness screen would keep
    // asserting a stale version that operators have no way to distrust.
    const migrationDir = fileURLToPath(
      new URL('../../../supabase/migrations', import.meta.url),
    )
    const migrationCount = (await readdir(migrationDir))
      .filter((name) => name.endsWith('.sql')).length

    const health = await callFunction<{ schemaVersion: number }>(
      'health',
      {},
      owner.accessToken,
    )
    expect(health.status).toBe(200)
    expect(
      health.body.schemaVersion,
      `health reports schema v${health.body.schemaVersion} but ${migrationCount} migrations are committed — ` +
        'bump schemaVersion in supabase/functions/health/index.ts',
    ).toBe(migrationCount)
  })

  it('returns measured capacity and recovery state only to operators', async () => {
    const operator = userClient(owner.accessToken)
    const { data, error } = await operator.rpc('phase4_operations_snapshot')
    expect(error).toBeNull()
    const snapshot = data as {
      database: { usedBytes: number; limitBytes: number; warningLevel: string; publishBlocked: boolean }
      events: unknown[]
      recentErrors: unknown[]
      manualQuotas: unknown[]
      retention: { errorDays: number; revisionRowsPerEvent: number }
    }
    expect(snapshot.database.usedBytes).toBeGreaterThan(0)
    expect(snapshot.database.limitBytes).toBe(500 * 1024 * 1024)
    expect(snapshot.database.warningLevel).toBe('healthy')
    expect(snapshot.database.publishBlocked).toBe(false)
    expect(snapshot.events).toBeInstanceOf(Array)
    expect(snapshot.manualQuotas).toHaveLength(4)
    expect(snapshot.retention).toEqual({ errorDays: 30, revisionRowsPerEvent: 20 })

    const denied = await userClient(outsider.accessToken).rpc('phase4_operations_snapshot')
    expect(denied.data).toBeNull()
    expect(denied.error?.code).toBe('42501')
  })

  it('accepts only sanitized, capped error aggregates', async () => {
    const correlationId = randomUUID()
    const body = {
      errorCode: 'RENDER_BOUNDARY',
      routeFamily: '/events/:eventId/score',
      correlationId,
      severity: 'error',
    }
    const before = await userClient(owner.accessToken).rpc('phase4_operations_snapshot')
    expect(before.error).toBeNull()
    const priorCount = ((before.data as { recentErrors: Array<{
      errorCode: string
      routeFamily: string
      occurrenceCount: number
    }> }).recentErrors.find((row) =>
      row.errorCode === body.errorCode && row.routeFamily === body.routeFamily
    )?.occurrenceCount) ?? 0
    const first = await callFunction('report-error', body)
    const second = await callFunction('report-error', body)
    expect(first.status, JSON.stringify(first.body)).toBe(202)
    expect(second.status, JSON.stringify(second.body)).toBe(202)

    const invalid = await callFunction('report-error', {
      ...body,
      message: 'Player name and private stack text must not be accepted',
    })
    expect(invalid.status).toBe(400)

    const unknownCode = await callFunction('report-error', {
      ...body,
      errorCode: 'ATTACKER_CONTROLLED_BUCKET',
    })
    expect(unknownCode.status).toBe(400)

    const { data, error } = await userClient(owner.accessToken).rpc('phase4_operations_snapshot')
    expect(error).toBeNull()
    const rows = (data as { recentErrors: Array<{
      errorCode: string
      occurrenceCount: number
      correlationId: string
    }> }).recentErrors
    expect(rows).toContainEqual(expect.objectContaining({
      errorCode: 'RENDER_BOUNDARY',
      occurrenceCount: priorCount + 2,
      correlationId,
    }))
  })

  it('reports the newest backup and the latest tested restore independently', async () => {
    const older = new Date(Date.now() - 2 * 86_400_000)
    const latest = new Date(Date.now() - 86_400_000)
    const testedOn = older.toISOString().slice(0, 10)
    const inserted = await service.from('backup_runs').insert([
      {
        started_at: older.toISOString(),
        completed_at: older.toISOString(),
        status: 'succeeded',
        artifact_checksum: 'a'.repeat(64),
        last_tested_restore_on: testedOn,
      },
      {
        started_at: latest.toISOString(),
        completed_at: latest.toISOString(),
        status: 'succeeded',
        artifact_checksum: 'b'.repeat(64),
      },
    ])
    if (inserted.error) throw inserted.error

    const { data, error } = await userClient(owner.accessToken).rpc('phase4_operations_snapshot')
    expect(error).toBeNull()
    const backup = (data as { backup: {
      artifactChecksum: string
      lastTestedRestoreOn: string
    } }).backup
    expect(backup.artifactChecksum).toBe('b'.repeat(64))
    expect(backup.lastTestedRestoreOn).toBe(testedOn)
  })

  it('prunes expired error aggregates without touching scoring facts', async () => {
    const oldId = randomUUID()
    const oldTime = new Date(Date.now() - 40 * 86_400_000).toISOString()
    const inserted = await service.from('app_error_events').insert({
      id: oldId,
      error_code: 'EXPIRED_TEST_ERROR',
      release: '0.1.0',
      route_family: '/test',
      severity: 'warning',
      window_started_at: oldTime,
      first_seen_at: oldTime,
      last_seen_at: oldTime,
    })
    if (inserted.error) throw inserted.error

    const { data, error } = await service.rpc('prune_phase4_error_events', {
      p_before: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    })
    expect(error).toBeNull()
    expect((data as { deleted: number }).deleted).toBeGreaterThanOrEqual(1)
    const remaining = await service.from('app_error_events').select('id').eq('id', oldId)
    expect(remaining.data).toEqual([])
  })

  it('fences projection leases to their current owner token', async () => {
    const ownerToken = randomUUID()
    const fallbackToken = randomUUID()
    const first = await service.rpc('claim_projection_publish', {
      p_event_id: seededEventId,
      p_revision: 1,
      p_lease_token: ownerToken,
    })
    expect(first.error).toBeNull()
    expect(first.data).toBe('claimed')

    const waiter = await service.rpc('claim_projection_publish', {
      p_event_id: seededEventId,
      p_revision: 2,
      p_lease_token: fallbackToken,
    })
    expect(waiter.data).toBe('wait')

    const wrongRelease = await service.rpc('release_projection_publish', {
      p_event_id: seededEventId,
      p_revision: 2,
      p_lease_token: fallbackToken,
    })
    expect(wrongRelease.data).toBe(false)

    const ownerStillFenced = await service.rpc('renew_projection_publish_lease', {
      p_event_id: seededEventId,
      p_lease_token: ownerToken,
    })
    expect(ownerStillFenced.data).toBe(true)
    const waiterSurvivesRenewal = await service.rpc('claim_projection_publish', {
      p_event_id: seededEventId,
      p_revision: 2,
      p_lease_token: fallbackToken,
    })
    expect(waiterSurvivesRenewal.data).toBe('wait')

    const release = await service.rpc('release_projection_publish', {
      p_event_id: seededEventId,
      p_revision: 2,
      p_lease_token: ownerToken,
    })
    expect(release.data).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 600))

    const fallback = await service.rpc('claim_projection_publish', {
      p_event_id: seededEventId,
      p_revision: 2,
      p_lease_token: fallbackToken,
    })
    expect(fallback.data).toBe('claimed')

    const staleOwnerRelease = await service.rpc('release_projection_publish', {
      p_event_id: seededEventId,
      p_revision: 2,
      p_lease_token: ownerToken,
    })
    expect(staleOwnerRelease.data).toBe(false)
    const fallbackStillFenced = await service.rpc('renew_projection_publish_lease', {
      p_event_id: seededEventId,
      p_lease_token: fallbackToken,
    })
    expect(fallbackStillFenced.data).toBe(true)
    await service.rpc('release_projection_publish', {
      p_event_id: seededEventId,
      p_revision: 2,
      p_lease_token: fallbackToken,
    })
  })
})
