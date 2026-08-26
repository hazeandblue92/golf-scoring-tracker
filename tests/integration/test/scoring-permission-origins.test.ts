/**
 * Scoring permission origins (migration 37).
 *
 * Regression: self grants, organizer-selected field markers, and tee-group
 * derived markers were all stored as permission_type = 'marker'/'self' with
 * nothing distinguishing them. The event builder reloaded every marker row
 * into its field-marker control, so reopening and resaving a draft promoted
 * automatic same-group grants into deliberate field-wide ones and widened
 * access on each edit.
 */

import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  createAccount,
  LEAGUE_ID,
  SEASON_ID,
  TEE_SET_BLUE,
} from '../helpers/fixture.ts'
import { serviceClient, stackIsUp } from '../helpers/stack.ts'

const SEED_PLAYERS = [
  '00000000-0000-4000-8000-000000000201',
  '00000000-0000-4000-8000-000000000202',
  '00000000-0000-4000-8000-000000000203',
]

describe('scoring permission grant origins', () => {
  const service = serviceClient()
  let eventId: string
  let scorerProfileId: string

  beforeAll(async () => {
    expect(await stackIsUp(), 'local Supabase stack must be running').toBe(true)

    const owner = await createAccount(service, { displayName: 'Origins Owner', withMfa: true })
    const scorer = await createAccount(service, { displayName: 'Origins Scorer' })
    scorerProfileId = scorer.profileId
    // A participant tied to an account: only these can receive a 'self' grant.
    const player = await createAccount(service, { displayName: 'Origins Player' })

    const memberships = await service.from('league_memberships').insert(
      [owner.profileId, scorer.profileId, player.profileId].map((profileId) => ({
        league_id: LEAGUE_ID,
        profile_id: profileId,
        member_status: 'active',
      })),
    )
    if (memberships.error) throw memberships.error

    const role = await service.from('role_assignments').insert({
      league_id: LEAGUE_ID,
      profile_id: owner.profileId,
      role: 'owner',
    })
    if (role.error) throw role.error

    const linkedParticipantId = randomUUID()
    const participant = await service.from('participants').insert({
      id: linkedParticipantId,
      league_id: LEAGUE_ID,
      display_name: 'Origins Linked Player',
      sort_name: `Linked Player, Origins ${linkedParticipantId}`,
      status: 'active',
      profile_id: player.profileId,
    })
    if (participant.error) throw participant.error

    const saved = await service.rpc('save_phase1_event_draft', {
      p_actor: owner.profileId,
      p_event_id: null,
      p_league_id: LEAGUE_ID,
      p_season_id: SEASON_ID,
      p_name: `Origin probe ${linkedParticipantId.slice(0, 8)}`,
      p_timezone: 'America/Detroit',
      p_starts_at: new Date(Date.now() + 172_800_000).toISOString(),
      p_ends_at: null,
      p_visibility: 'league',
      p_tee_set_id: TEE_SET_BLUE,
      p_participant_ids: [linkedParticipantId, ...SEED_PLAYERS],
      p_scorer_profile_ids: [scorer.profileId],
    })
    if (saved.error) throw saved.error
    eventId = (saved.data as { eventId: string }).eventId
    expect(eventId).toBeTruthy()
  }, 240_000)

  it('stamps a player scoring their own card as self', async () => {
    const rows = await service
      .from('scoring_permissions')
      .select('grant_origin,permission_type')
      .eq('event_id', eventId)
      .eq('permission_type', 'self')
    if (rows.error) throw rows.error
    expect(rows.data?.length ?? 0).toBeGreaterThan(0)
    for (const row of rows.data ?? []) {
      expect(row.grant_origin).toBe('self')
    }
  }, 60_000)

  it('stamps an organizer-selected field marker as explicit_field', async () => {
    const rows = await service
      .from('scoring_permissions')
      .select('grant_origin,scorer_profile_id')
      .eq('event_id', eventId)
      .eq('permission_type', 'marker')
      .eq('scorer_profile_id', scorerProfileId)
    if (rows.error) throw rows.error
    expect(rows.data?.length ?? 0).toBeGreaterThan(0)
    for (const row of rows.data ?? []) {
      // The ONLY origin the event builder reloads into its marker control.
      expect(row.grant_origin).toBe('explicit_field')
    }
  }, 60_000)

  it('never leaves a grant it created at the legacy default', async () => {
    // 'legacy' means "created before origins existed, intent unknown". A row
    // written by the current workflow must always state its own origin.
    const rows = await service
      .from('scoring_permissions')
      .select('grant_origin')
      .eq('event_id', eventId)
      .eq('grant_origin', 'legacy')
    if (rows.error) throw rows.error
    expect(rows.data ?? []).toHaveLength(0)
  }, 60_000)
})
