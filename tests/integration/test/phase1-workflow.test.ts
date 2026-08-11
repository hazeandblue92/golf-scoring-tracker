import { createHash, randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'

import { createAccount, LEAGUE_ID, SEASON_ID, TEE_SET_BLUE } from '../helpers/fixture.ts'
import { callFunction, serviceClient, stackIsUp, userClient } from '../helpers/stack.ts'

const PARTICIPANT_ID = '00000000-0000-4000-8000-000000000201'

describe('Phase 1 launch workflow', () => {
  const service = serviceClient()
  let owner: Awaited<ReturnType<typeof createAccount>>
  let eventId: string
  let roundId: string
  let competitionId: string

  beforeAll(async () => {
    expect(await stackIsUp(), 'local Supabase stack must be running').toBe(true)
    owner = await createAccount(service, { displayName: 'Phase 1 Owner', withMfa: true })
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
    roundId = saved.body.roundId
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

  it('AC-003: later catalog edits leave frozen inputs unchanged and published inputs reject edits', async () => {
    const participantId = PARTICIPANT_ID
    const handicapId = '00000000-0000-4000-8000-000000000221'
    const courseId = '00000000-0000-4000-8000-000000000301'

    const [snapshotBefore, holesBefore, entryBefore, entityBefore, competitionBefore,
      projectionBefore, teeBefore, teeHoleBefore, participantBefore, handicapBefore,
      courseBefore] = await Promise.all([
      service.from('event_tee_snapshots')
        .select('course_name,layout_name,tee_name,rating_category,course_rating,slope_rating,par,hole_count,snapshot_hash')
        .eq('round_id', roundId).single(),
      service.from('event_holes')
        .select('hole_ordinal,label,par,yardage,stroke_index')
        .eq('round_id', roundId).order('hole_ordinal'),
      service.from('event_entries')
        .select('participant_id,status,handicap_source,handicap_value,course_handicap_unrounded,playing_handicap,allowance,handicap_profile,tee_snapshot_id,snapshot_hash')
        .eq('event_id', eventId).single(),
      service.from('competition_entities')
        .select('event_entry_id,eligibility_status')
        .eq('competition_id', competitionId).single(),
      service.from('competitions')
        .select('format,metric,rules_schema_version,rules_json,rules_text,engine_version')
        .eq('id', competitionId).single(),
      service.from('competition_projections')
        .select('event_revision,projection_hash')
        .eq('competition_id', competitionId).single(),
      service.from('tee_sets')
        .select('course_rating,slope_rating,par,status')
        .eq('id', TEE_SET_BLUE).single(),
      service.from('tee_holes')
        .select('course_hole_label,par,yardage,stroke_index')
        .eq('tee_set_id', TEE_SET_BLUE).eq('hole_ordinal', 1).single(),
      service.from('participants')
        .select('display_name,sort_name,status')
        .eq('id', participantId).single(),
      service.from('participant_handicaps')
        .select('value,source')
        .eq('id', handicapId).single(),
      service.from('courses')
        .select('name,location_text,status')
        .eq('id', courseId).single(),
    ])

    for (const result of [snapshotBefore, holesBefore, entryBefore, entityBefore,
      competitionBefore, projectionBefore, teeBefore, teeHoleBefore,
      participantBefore, handicapBefore, courseBefore]) {
      if (result.error) throw result.error
    }

    let snapshotAfter: typeof snapshotBefore
    let holesAfter: typeof holesBefore
    let entryAfter: typeof entryBefore
    let entityAfter: typeof entityBefore
    let competitionAfter: typeof competitionBefore
    let projectionAfter: typeof projectionBefore
    let entryEdit: { error: { code?: string } | null } | undefined
    let rulesEdit: { error: { code?: string } | null } | undefined
    let privilegedEntryEdit: { error: { code?: string } | null } | undefined
    let privilegedRulesEdit: { error: { code?: string } | null } | undefined
    let restoreErrors: unknown[] = []

    try {
      const sourceEdits = await Promise.all([
        service.from('courses').update({ name: 'Later catalog course name' }).eq('id', courseId),
        service.from('tee_sets').update({ course_rating: 79.9, slope_rating: 155 }).eq('id', TEE_SET_BLUE),
        service.from('tee_holes').update({ yardage: 777 }).eq('tee_set_id', TEE_SET_BLUE).eq('hole_ordinal', 1),
        service.from('participants').update({
          display_name: 'Later roster name',
          sort_name: 'Name, Later Roster',
          status: 'inactive',
        }).eq('id', participantId),
        service.from('participant_handicaps').update({ value: 24.9 }).eq('id', handicapId),
      ])
      for (const edit of sourceEdits) {
        if (edit.error) throw edit.error
      }

      ;[snapshotAfter, holesAfter, entryAfter, entityAfter, competitionAfter,
        projectionAfter] = await Promise.all([
        service.from('event_tee_snapshots')
          .select('course_name,layout_name,tee_name,rating_category,course_rating,slope_rating,par,hole_count,snapshot_hash')
          .eq('round_id', roundId).single(),
        service.from('event_holes')
          .select('hole_ordinal,label,par,yardage,stroke_index')
          .eq('round_id', roundId).order('hole_ordinal'),
        service.from('event_entries')
          .select('participant_id,status,handicap_source,handicap_value,course_handicap_unrounded,playing_handicap,allowance,handicap_profile,tee_snapshot_id,snapshot_hash')
          .eq('event_id', eventId).single(),
        service.from('competition_entities')
          .select('event_entry_id,eligibility_status')
          .eq('competition_id', competitionId).single(),
        service.from('competitions')
          .select('format,metric,rules_schema_version,rules_json,rules_text,engine_version')
          .eq('id', competitionId).single(),
        service.from('competition_projections')
          .select('event_revision,projection_hash')
          .eq('competition_id', competitionId).single(),
      ])

      const organizer = userClient(owner.accessToken)
      entryEdit = await organizer.from('event_entries')
        .update({ playing_handicap: 25 })
        .eq('event_id', eventId)
      rulesEdit = await organizer.from('competitions')
        .update({ rules_json: { compromised: true } })
        .eq('id', competitionId)
      privilegedEntryEdit = await service.from('event_entries')
        .update({ playing_handicap: 25 })
        .eq('event_id', eventId)
      privilegedRulesEdit = await service.from('competitions')
        .update({ rules_json: { compromised: true } })
        .eq('id', competitionId)
    } finally {
      const restoreRequests: Array<PromiseLike<{ error: unknown }>> = [
        service.from('courses').update(courseBefore.data!).eq('id', courseId),
        service.from('tee_sets').update(teeBefore.data!).eq('id', TEE_SET_BLUE),
        service.from('tee_holes').update(teeHoleBefore.data!).eq('tee_set_id', TEE_SET_BLUE).eq('hole_ordinal', 1),
        service.from('participants').update(participantBefore.data!).eq('id', participantId),
        service.from('participant_handicaps').update(handicapBefore.data!).eq('id', handicapId),
      ]
      if (entryEdit?.error === null || privilegedEntryEdit?.error === null) {
        restoreRequests.push(
          service.from('event_entries').update(entryBefore.data!).eq('event_id', eventId),
        )
      }
      if (rulesEdit?.error === null || privilegedRulesEdit?.error === null) {
        restoreRequests.push(
          service.from('competitions').update(competitionBefore.data!).eq('id', competitionId),
        )
      }
      const restores = await Promise.all(restoreRequests)
      restoreErrors = restores
        .map((restore) => restore.error)
        .filter((error) => error !== null)
    }

    expect(restoreErrors).toEqual([])
    for (const result of [snapshotAfter!, holesAfter!, entryAfter!, entityAfter!,
      competitionAfter!, projectionAfter!]) {
      if (result.error) throw result.error
    }
    expect(snapshotAfter!.data).toEqual(snapshotBefore.data)
    expect(holesAfter!.data).toEqual(holesBefore.data)
    expect(entryAfter!.data).toEqual(entryBefore.data)
    expect(entityAfter!.data).toEqual(entityBefore.data)
    expect(competitionAfter!.data).toEqual(competitionBefore.data)
    expect(projectionAfter!.data).toEqual(projectionBefore.data)
    expect(entryEdit?.error?.code, 'the browser role must have no direct event-entry update grant')
      .toBe('42501')
    expect(rulesEdit?.error?.code, 'the browser role must have no direct competition update grant')
      .toBe('42501')
    expect(privilegedEntryEdit?.error?.code, 'published frozen handicaps must reject privileged edits')
      .toBe('23514')
    expect(privilegedRulesEdit?.error?.code, 'published rules must reject privileged edits')
      .toBe('23514')
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
    const [{ data: eventAfterBlock }, { data: competitionAfterBlock }] = await Promise.all([
      service.from('events').select('status').eq('id', eventId).single(),
      service.from('competitions').select('status').eq('id', competitionId).single(),
    ])
    expect(eventAfterBlock?.status).toBe('scoring_open')
    expect(competitionAfterBlock?.status).toBe('scoring_open')

    const finalized = await callFunction<{ status: string; finalResultHash: string }>(
      'finalize-competition',
      { competitionId, overrideReason: 'Committee approved test no-return override' },
      owner.accessToken,
    )
    expect(finalized.status).toBe(200)
    expect(finalized.body.status).toBe('finalized')
    expect(finalized.body.finalResultHash).toMatch(/^[0-9a-f]{64}$/)

    const [{ data: sealedCompetition }, { data: finalProjection }] = await Promise.all([
      service.from('competitions')
        .select('final_result_hash')
        .eq('id', competitionId)
        .single(),
      service.from('competition_projections')
        .select('projection_hash,status')
        .eq('competition_id', competitionId)
        .eq('event_revision', 0)
        .single(),
    ])
    expect(finalProjection?.status).toBe('final')
    expect(sealedCompetition?.final_result_hash).toBe(finalProjection?.projection_hash)
    expect(finalized.body.finalResultHash).toBe(finalProjection?.projection_hash)

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
