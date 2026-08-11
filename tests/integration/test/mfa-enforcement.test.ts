import { beforeAll, describe, expect, it } from 'vitest'

import { buildScoringFixture, LEAGUE_ID, type ScoringFixture } from '../helpers/fixture.ts'
import { callFunction, stackIsUp } from '../helpers/stack.ts'

describe('privileged organizer MFA enforcement (FR-AUTH-005)', () => {
  let fx: ScoringFixture

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

  it('accepts the challenged AAL2 token before applying workflow validation', async () => {
    const response = await callFunction<{ error_code: string }>(
      'account-admin',
      { action: 'unsupported-test-action' },
      fx.director.accessToken,
    )
    expect(response.status).toBe(400)
    expect(response.body.error_code).not.toBe('MFA_REQUIRED')
  })
})
