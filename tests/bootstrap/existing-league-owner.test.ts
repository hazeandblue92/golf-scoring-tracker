import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'

import { LEAGUE_ID } from '../integration/helpers/fixture.ts'
import {
  anonClient,
  serviceClient,
  stackIsUp,
} from '../integration/helpers/stack.ts'

const BOOTSTRAP_MARKER = 'initial_owner_bootstrap'

describe('first owner attached to an existing seeded league', () => {
  const service = serviceClient()

  beforeAll(async () => {
    expect(await stackIsUp(), 'local Supabase stack must be running').toBe(true)
    const owners = await service
      .from('role_assignments')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'owner')
    expect(owners.count, 'run only immediately after backend:seed').toBe(0)
  })

  async function createMarkedAuthUser() {
    const password = `Bootstrap-${randomUUID()}`
    const email = `${randomUUID().replaceAll('-', '')}@users.invalid`
    const created = await service.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { [BOOTSTRAP_MARKER]: true },
    })
    if (created.error || !created.data.user) throw created.error ?? new Error('Auth user missing')
    return { id: created.data.user.id, password }
  }

  function attachParams(profileId: string, username: string) {
    return {
      p_profile_id: profileId,
      p_username: username,
      p_display_name: 'Bootstrap Owner',
      p_existing_league_id: LEAGUE_ID,
      p_league_name: null,
      p_league_slug: null,
      p_timezone: null,
      p_locale: null,
    }
  }

  it('is not executable with the browser publishable role', async () => {
    const attempt = await anonClient().rpc('bootstrap_initial_owner', attachParams(
      '11111111-1111-4111-8111-111111111111',
      'blocked-owner',
    ))
    expect(attempt.data).toBeNull()
    expect(attempt.error?.code).toBe('42501')
  })

  it('refuses implicit second-league creation when seeded data exists', async () => {
    const candidate = await createMarkedAuthUser()
    const attempt = await service.rpc('bootstrap_initial_owner', {
      ...attachParams(candidate.id, `create-${randomUUID().slice(0, 8)}`),
      p_existing_league_id: null,
      p_league_name: 'Second League',
      p_league_slug: `second-${randomUUID().slice(0, 8)}`,
      p_timezone: 'America/Detroit',
      p_locale: 'en-US',
    })
    expect(attempt.data).toBeNull()
    expect(attempt.error?.code).toBe('42501')
    const profile = await service.from('profiles').select('id').eq('id', candidate.id).maybeSingle()
    expect(profile.data).toBeNull()
  })

  it('serializes concurrent attach attempts and atomically installs exactly one owner', async () => {
    const candidates = await Promise.all([createMarkedAuthUser(), createMarkedAuthUser()])
    const usernames = candidates.map((_candidate, index) => `bootstrap-owner-${index}`)
    const attempts = await Promise.all(candidates.map((candidate, index) =>
      service.rpc('bootstrap_initial_owner', attachParams(candidate.id, usernames[index]!))))

    const successes = attempts
      .map((attempt, index) => ({ attempt, index }))
      .filter(({ attempt }) => attempt.error === null)
    const refusals = attempts.filter((attempt) => attempt.error !== null)
    expect(successes).toHaveLength(1)
    expect(refusals).toHaveLength(1)
    expect(refusals[0]?.error?.code).toBe('42501')

    const winnerIndex = successes[0]!.index
    const winner = candidates[winnerIndex]!
    expect(successes[0]!.attempt.data).toMatchObject({
      status: 'bootstrapped',
      profileId: winner.id,
      leagueId: LEAGUE_ID,
      createdLeague: false,
    })

    const [profile, membership, ownerRole, audit, allOwners] = await Promise.all([
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
      service.from('role_assignments').select('id', { count: 'exact', head: true }).eq('role', 'owner'),
    ])

    expect(profile.error).toBeNull()
    expect(profile.data).toEqual({
      id: winner.id,
      username: usernames[winnerIndex],
      status: 'active',
      must_change_password: true,
      privacy_accepted_at: null,
    })
    expect(membership.data).toMatchObject({
      league_id: LEAGUE_ID,
      profile_id: winner.id,
      member_status: 'active',
    })
    expect(ownerRole.data).toMatchObject({
      league_id: LEAGUE_ID,
      profile_id: winner.id,
      role: 'owner',
      granted_by: null,
      revoked_at: null,
    })
    expect(allOwners.count).toBe(1)
    expect(audit.data).toMatchObject({
      actor_profile_id: null,
      action: 'deployment.initial_owner_bootstrapped',
      scope_league_id: LEAGUE_ID,
      target_id: winner.id,
      before_json: null,
      after_json: { created_league: false },
      reason: null,
    })
    expect(JSON.stringify({ profile: profile.data, audit: audit.data })).not.toContain(winner.password)
  })

  it('stays closed after the owner grant is revoked', async () => {
    const owner = await service.from('role_assignments').select('id').eq('role', 'owner').single()
    expect(owner.error).toBeNull()
    const revoked = await service.from('role_assignments')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', owner.data!.id)
    expect(revoked.error).toBeNull()

    const candidate = await createMarkedAuthUser()
    const attempt = await service.rpc(
      'bootstrap_initial_owner',
      attachParams(candidate.id, `late-${randomUUID().slice(0, 8)}`),
    )
    expect(attempt.data).toBeNull()
    expect(attempt.error?.code).toBe('42501')
    const profile = await service.from('profiles').select('id').eq('id', candidate.id).maybeSingle()
    expect(profile.data).toBeNull()
  })
})
