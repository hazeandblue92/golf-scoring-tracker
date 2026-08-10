import { createHash, randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'

import { createAccount, LEAGUE_ID, SEASON_ID, TEE_SET_BLUE } from '../helpers/fixture.ts'
import { callFunction, serviceClient, stackIsUp } from '../helpers/stack.ts'

const PARTICIPANT_ID = '00000000-0000-4000-8000-000000000201'

describe('Phase 1 launch workflow', () => {
  const service = serviceClient()
  let owner: Awaited<ReturnType<typeof createAccount>>
  let eventId: string
  let competitionId: string

  beforeAll(async () => {
    expect(await stackIsUp(), 'local Supabase stack must be running').toBe(true)
    owner = await createAccount(service, { displayName: 'Phase 1 Owner' })
    const membership = await service.from('league_memberships').insert({
      league_id: LEAGUE_ID,
      profile_id: owner.profileId,
      member_status: 'active',
    })
    if (membership.error) throw membership.error
    const role = await service.from('role_assignments').insert({
      league_id: LEAGUE_ID,
      profile_id: owner.profileId,
      role: 'owner',
    })
    if (role.error) throw role.error
  }, 60_000)

  it('saves a complete draft and publishes immutable snapshots', async () => {
    const start = new Date(Date.now() + 86_400_000).toISOString()
    const saved = await callFunction<{
      eventId: string
      roundId: string
      competitionId: string
    }>('save-event-draft', {
      leagueId: LEAGUE_ID,
      seasonId: SEASON_ID,
      name: `Phase 1 Event ${randomUUID().slice(0, 8)}`,
      timezone: 'America/Detroit',
      startsAt: start,
      endsAt: null,
      visibility: 'league',
      teeSetId: TEE_SET_BLUE,
      participantIds: [PARTICIPANT_ID],
      scorerProfileIds: [],
    }, owner.accessToken)
    expect(saved.status).toBe(200)
    eventId = saved.body.eventId
    competitionId = saved.body.competitionId

    const published = await callFunction<{ status: string; snapshotHash: string }>(
      'publish-event',
      { eventId, openScoring: true },
      owner.accessToken,
    )
    expect(published.status).toBe(200)
    expect(published.body.status).toBe('scoring_open')
    expect(published.body.snapshotHash).toMatch(/^[0-9a-f]{64}$/)

    const [snapshots, holes, entries, projection] = await Promise.all([
      service.from('event_tee_snapshots').select('snapshot_hash').eq('round_id', saved.body.roundId),
      service.from('event_holes').select('id').eq('round_id', saved.body.roundId),
      service.from('event_entries').select('snapshot_hash,tee_snapshot_id').eq('event_id', eventId),
      service.from('competition_projections').select('event_revision,status').eq('competition_id', competitionId),
    ])
    expect(snapshots.data).toHaveLength(1)
    expect(holes.data).toHaveLength(18)
    expect(entries.data?.[0]?.snapshot_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(projection.data?.[0]?.event_revision).toBe(0)
  })

  it('blocks incomplete finalization, records an override, and exports the final hash', async () => {
    const blocked = await callFunction<{ status: string; missingScores: number }>(
      'finalize-competition',
      { competitionId, overrideReason: null },
      owner.accessToken,
    )
    expect(blocked.status).toBe(409)
    expect(blocked.body.status).toBe('blocked')
    expect(blocked.body.missingScores).toBe(18)

    const finalized = await callFunction<{ status: string; finalResultHash: string }>(
      'finalize-competition',
      { competitionId, overrideReason: 'Committee approved test no-return override' },
      owner.accessToken,
    )
    expect(finalized.status).toBe(200)
    expect(finalized.body.status).toBe('finalized')
    expect(finalized.body.finalResultHash).toMatch(/^[0-9a-f]{64}$/)

    const exported = await callFunction<{
      format: string
      integrityHash: string
      finalResultHashes: Array<{ competitionId: string; hash: string }>
      tables: { events: unknown[]; event_holes: unknown[] }
    }>('export-league', { leagueId: LEAGUE_ID, eventId }, owner.accessToken)
    expect(exported.status).toBe(200)
    expect(exported.body.format).toBe('gtt-portable-export')
    expect(exported.body.integrityHash).toMatch(/^[0-9a-f]{64}$/)
    expect(exported.body.finalResultHashes).toContainEqual({
      competitionId,
      hash: finalized.body.finalResultHash,
    })
    expect(exported.body.tables.events).toHaveLength(1)
    expect(exported.body.tables.event_holes).toHaveLength(18)

    // A visibly nonempty digest guards against an accidentally empty export.
    expect(createHash('sha256').update(JSON.stringify(exported.body.tables)).digest('hex'))
      .not.toBe(createHash('sha256').update('{}').digest('hex'))
  })
})
