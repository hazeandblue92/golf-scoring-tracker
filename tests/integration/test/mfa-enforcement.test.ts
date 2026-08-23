import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  buildScoringFixture,
  LEAGUE_ID,
  SEASON_ID,
  TEE_SET_BLUE,
  type ScoringFixture,
} from '../helpers/fixture.ts'
import { callFunction, stackIsUp } from '../helpers/stack.ts'

describe('privileged organizer MFA enforcement (FR-AUTH-005)', () => {
  let fx: ScoringFixture

  function validDraft(name: string) {
    return {
      leagueId: LEAGUE_ID,
      seasonId: SEASON_ID,
      name,
      timezone: 'America/Detroit',
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      endsAt: null,
      visibility: 'league',
      teeSetId: TEE_SET_BLUE,
      participantIds: [fx.entries[0].participantId],
      scorerProfileIds: [],
    }
  }

  beforeAll(async () => {
    expect(await stackIsUp(), 'local Supabase stack must be running').toBe(true)
    fx = await buildScoringFixture({ playerCount: 2, leaveClosed: true })
    const owner = await fx.service.from('role_assignments').insert({
      league_id: LEAGUE_ID,
      profile_id: fx.director.profileId,
      role: 'owner',
    })
    if (owner.error) throw owner.error
  }, 120_000)

  it.each([
    ['publish-event', () => ({ eventId: fx.eventId, openScoring: true })],
    ['finalize-competition', () => ({
      competitionId: fx.competitions.grossId,
      overrideReason: 'MFA negative test',
    })],
    ['export-league', () => ({ leagueId: LEAGUE_ID, eventId: fx.eventId })],
    ['rebuild-projections', () => ({ eventId: fx.eventId })],
    ['resolve-score-conflict', () => ({})],
  ])('%s rejects a valid organizer session that has not completed its TOTP challenge',
    async (functionName, body) => {
      const aal1 = fx.director.aal1AccessToken
      expect(aal1).toBeTruthy()
      const response = await callFunction<{ errorCode: string }>(
        functionName,
        body(),
        aal1,
      )
      expect(response.status).toBe(403)
      expect(response.body.errorCode).toBe('MFA_REQUIRED')
    })

  it('account administration also requires the current session to be AAL2', async () => {
    const aal1 = fx.director.aal1AccessToken
    expect(aal1).toBeTruthy()
    const response = await callFunction<{ error_code: string }>(
      'account-admin',
      { action: 'unsupported-test-action' },
      aal1,
    )
    expect(response.status).toBe(403)
    expect(response.body.error_code).toBe('MFA_REQUIRED')
  })

  it('rejects valid catalog and event-draft writes at AAL1 without changing state', async () => {
    const aal1 = fx.director.aal1AccessToken
    expect(aal1).toBeTruthy()
    const seasonName = `MFA-blocked season ${randomUUID()}`
    const eventName = `MFA-blocked event ${randomUUID()}`

    const [seasonBefore, eventBefore] = await Promise.all([
      fx.service.from('seasons').select('id').eq('league_id', LEAGUE_ID).eq('name', seasonName),
      fx.service.from('events').select('id').eq('league_id', LEAGUE_ID).eq('name', eventName),
    ])
    if (seasonBefore.error || eventBefore.error) {
      throw seasonBefore.error ?? eventBefore.error
    }
    expect(seasonBefore.data).toHaveLength(0)
    expect(eventBefore.data).toHaveLength(0)

    const catalog = await callFunction<{ errorCode: string }>(
      'catalog-admin',
      {
        action: 'save-season',
        leagueId: LEAGUE_ID,
        name: seasonName,
        startsOn: '2030-01-01',
        endsOn: '2030-12-31',
      },
      aal1,
    )
    const draft = await callFunction<{ errorCode: string }>(
      'save-event-draft',
      validDraft(eventName),
      aal1,
    )
    expect(catalog.status).toBe(403)
    expect(catalog.body.errorCode).toBe('MFA_REQUIRED')
    expect(draft.status).toBe(403)
    expect(draft.body.errorCode).toBe('MFA_REQUIRED')

    const [seasonAfter, eventAfter] = await Promise.all([
      fx.service.from('seasons').select('id').eq('league_id', LEAGUE_ID).eq('name', seasonName),
      fx.service.from('events').select('id').eq('league_id', LEAGUE_ID).eq('name', eventName),
    ])
    if (seasonAfter.error || eventAfter.error) {
      throw seasonAfter.error ?? eventAfter.error
    }
    expect(seasonAfter.data).toHaveLength(0)
    expect(eventAfter.data).toHaveLength(0)
  })

  it('allows the same catalog and event-draft workflows after an AAL2 challenge', async () => {
    const seasonName = `MFA-verified season ${randomUUID()}`
    const eventName = `MFA-verified event ${randomUUID()}`
    const catalog = await callFunction<{ status: string; id: string }>(
      'catalog-admin',
      {
        action: 'save-season',
        leagueId: LEAGUE_ID,
        name: seasonName,
        startsOn: '2031-01-01',
        endsOn: '2031-12-31',
      },
      fx.director.accessToken,
    )
    const draft = await callFunction<{ status: string; eventId: string }>(
      'save-event-draft',
      validDraft(eventName),
      fx.director.accessToken,
    )
    expect(catalog.status).toBe(200)
    expect(catalog.body.status).toBe('saved')
    expect(draft.status).toBe(200)
    expect(draft.body.status).toBe('draft')

    const [savedSeason, savedEvent] = await Promise.all([
      fx.service.from('seasons').select('name').eq('id', catalog.body.id).single(),
      fx.service.from('events').select('name,status').eq('id', draft.body.eventId).single(),
    ])
    if (savedSeason.error || savedEvent.error) {
      throw savedSeason.error ?? savedEvent.error
    }
    expect(savedSeason.data.name).toBe(seasonName)
    expect(savedEvent.data).toMatchObject({ name: eventName, status: 'draft' })
  })

  it('accepts the challenged AAL2 token before applying workflow validation', async () => {
    const response = await callFunction<{ error_code: string }>(
      'account-admin',
      { action: 'unsupported-test-action' },
      fx.director.accessToken,
    )
    expect(response.status).toBe(400)
    expect(response.body.error_code).not.toBe('MFA_REQUIRED')
  })

  it('FR-AUTH-003 blocks temporary-password organizers at HTTP and SQL boundaries', async () => {
    const flagged = await fx.service.from('profiles')
      .update({ must_change_password: true })
      .eq('id', fx.director.profileId)
    if (flagged.error) throw flagged.error

    let restoreErrorMessage: string | null = null
    try {
      const [portable, accountAdmin, directWorkflow, directExport] = await Promise.all([
        callFunction<{ errorCode: string }>(
          'export-league',
          { leagueId: LEAGUE_ID, eventId: fx.eventId },
          fx.director.accessToken,
        ),
        callFunction<{ error_code: string }>(
          'account-admin',
          { action: 'unsupported-test-action' },
          fx.director.accessToken,
        ),
        fx.service.rpc('publish_phase1_event', {
          p_actor: fx.director.profileId,
          p_event_id: fx.eventId,
          p_open_scoring: false,
        }),
        fx.service.rpc('export_portable_snapshot', {
          p_actor: fx.director.profileId,
          p_league_id: LEAGUE_ID,
          p_event_id: fx.eventId,
        }),
      ])

      expect(portable.status).toBe(401)
      expect(portable.body.errorCode).toBe('AUTH_REQUIRED')
      expect(accountAdmin.status).toBe(401)
      expect(accountAdmin.body.error_code).toBe('AUTH_REQUIRED')
      expect(directWorkflow.error?.code).toBe('42501')
      expect(directExport.error).toBeNull()
      expect(directExport.data).toMatchObject({ authorized: false })
    } finally {
      const restored = await fx.service.from('profiles')
        .update({ must_change_password: false })
        .eq('id', fx.director.profileId)
      restoreErrorMessage = restored.error?.message ?? null
    }
    expect(restoreErrorMessage).toBeNull()
  })
})
