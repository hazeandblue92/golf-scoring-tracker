import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  anonClient,
  serviceClient,
  stackIsUp,
} from '../integration/helpers/stack.ts'

const BOOTSTRAP_MARKER = 'initial_owner_bootstrap'

describe('first owner in a fresh unseeded project', () => {
  const service = serviceClient()

  beforeAll(async () => {
    expect(await stackIsUp(), 'local Supabase stack must be running').toBe(true)
    const [leagues, owners] = await Promise.all([
      service.from('leagues').select('id', { count: 'exact', head: true }),
      service.from('role_assignments').select('id', { count: 'exact', head: true }).eq('role', 'owner'),
    ])
    expect(leagues.count, 'run only after db reset --no-seed').toBe(0)
    expect(owners.count, 'run only after db reset --no-seed').toBe(0)
  })

  async function createMarkedAuthUser() {
    const password = `Bootstrap-${randomUUID()}`
    const created = await service.auth.admin.createUser({
      email: `${randomUUID().replaceAll('-', '')}@users.invalid`,
      password,
      email_confirm: true,
      app_metadata: { [BOOTSTRAP_MARKER]: true },
    })
    if (created.error || !created.data.user) throw created.error ?? new Error('Auth user missing')
    return { id: created.data.user.id, password }
  }

  function createParams(profileId: string, index: number) {
    return {
      p_profile_id: profileId,
      p_username: `fresh-owner-${index}`,
      p_display_name: `Fresh Owner ${index}`,
      p_existing_league_id: null,
      p_league_name: `Fresh League ${index}`,
      p_league_slug: `fresh-league-${index}`,
      p_timezone: 'America/Detroit',
      p_locale: 'en-US',
    }
  }

  it('is not executable with the browser publishable role', async () => {
    const attempt = await anonClient().rpc('bootstrap_initial_owner', createParams(
      '11111111-1111-4111-8111-111111111111',
      9,
    ))
    expect(attempt.data).toBeNull()
    expect(attempt.error?.code).toBe('42501')
  })

  it('serializes racing attempts and creates one complete identity graph', async () => {
    const candidates = await Promise.all([createMarkedAuthUser(), createMarkedAuthUser()])
    const attempts = await Promise.all(candidates.map((candidate, index) =>
      service.rpc('bootstrap_initial_owner', createParams(candidate.id, index))))

    const successes = attempts
      .map((attempt, index) => ({ attempt, index }))
      .filter(({ attempt }) => attempt.error === null)
    const refusals = attempts.filter((attempt) => attempt.error !== null)
    expect(successes).toHaveLength(1)
    expect(refusals).toHaveLength(1)
    expect(refusals[0]?.error?.code).toBe('42501')

    const winnerIndex = successes[0]!.index
    const winner = candidates[winnerIndex]!
    const receipt = successes[0]!.attempt.data
    expect(receipt).toMatchObject({
      status: 'bootstrapped',
      profileId: winner.id,
      createdLeague: true,
    })

    const leagueId = receipt!.leagueId as string
    const [league, profile, membership, ownerRole, audit, leagueCount, ownerCount] = await Promise.all([
      service.from('leagues')
        .select('id,name,slug,timezone,locale,status,privacy_notice_version')
        .eq('id', leagueId).single(),
      service.from('profiles')
        .select('id,username,status,must_change_password,privacy_accepted_at')
        .eq('id', winner.id).single(),
      service.from('league_memberships')
        .select('league_id,profile_id,member_status')
        .eq('profile_id', winner.id).single(),
      service.from('role_assignments')
        .select('league_id,profile_id,role,granted_by,revoked_at')
        .eq('role', 'owner').single(),
      service.from('audit_events')
        .select('actor_profile_id,action,scope_league_id,target_id,before_json,after_json,reason')
        .eq('action', 'deployment.initial_owner_bootstrapped').single(),
      service.from('leagues').select('id', { count: 'exact', head: true }),
      service.from('role_assignments').select('id', { count: 'exact', head: true }).eq('role', 'owner'),
    ])

    expect(league.data).toEqual({
      id: leagueId,
      name: `Fresh League ${winnerIndex}`,
      slug: `fresh-league-${winnerIndex}`,
      timezone: 'America/Detroit',
      locale: 'en-US',
      status: 'active',
      privacy_notice_version: 1,
    })
    expect(profile.data).toEqual({
      id: winner.id,
      username: `fresh-owner-${winnerIndex}`,
      status: 'active',
      must_change_password: true,
      privacy_accepted_at: null,
    })
    expect(membership.data).toEqual({
      league_id: leagueId,
      profile_id: winner.id,
      member_status: 'active',
    })
    expect(ownerRole.data).toEqual({
      league_id: leagueId,
      profile_id: winner.id,
      role: 'owner',
      granted_by: null,
      revoked_at: null,
    })
    expect(audit.data).toEqual({
      actor_profile_id: null,
      action: 'deployment.initial_owner_bootstrapped',
      scope_league_id: leagueId,
      target_id: winner.id,
      before_json: null,
      after_json: { created_league: true },
      reason: null,
    })
    expect(leagueCount.count).toBe(1)
    expect(ownerCount.count).toBe(1)
    expect(JSON.stringify({ profile: profile.data, audit: audit.data })).not.toContain(winner.password)
  })
})
