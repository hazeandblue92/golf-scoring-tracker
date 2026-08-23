import { beforeAll, describe, expect, it } from 'vitest'

import { createAccount, type TestAccount } from '../helpers/fixture.ts'
import { callFunction, serviceClient, stackIsUp } from '../helpers/stack.ts'

describe('account activation privacy acknowledgement', () => {
  let account: TestAccount

  beforeAll(async () => {
    expect(await stackIsUp(), 'local Supabase stack must be running').toBe(true)
    account = await createAccount(serviceClient(), {
      displayName: 'Activation privacy player',
      mustChangePassword: true,
      privacyAccepted: false,
    })
  }, 120_000)

  it('persists explicit acceptance and never clears the temporary-password flag without it', async () => {
    const rejected = await callFunction<{ error_code?: string }>(
      'complete-activation',
      { newPassword: `Activated-${account.profileId}`, privacyAccepted: false },
      account.accessToken,
    )
    expect(rejected.status).toBe(400)
    expect(rejected.body.error_code).toBe('SCORE_INVALID')

    const service = serviceClient()
    const before = await service.from('profiles')
      .select('must_change_password,privacy_accepted_at')
      .eq('id', account.profileId)
      .single()
    if (before.error) throw before.error
    expect(before.data).toEqual({
      must_change_password: true,
      privacy_accepted_at: null,
    })

    const accepted = await callFunction<{
      status?: string
      mustChangePassword?: boolean
      privacyAccepted?: boolean
    }>(
      'complete-activation',
      { newPassword: `Activated-${account.profileId}`, privacyAccepted: true },
      account.accessToken,
    )
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200)
    expect(accepted.body).toMatchObject({
      status: 'activated',
      mustChangePassword: false,
      privacyAccepted: true,
    })

    const after = await service.from('profiles')
      .select('must_change_password,privacy_accepted_at')
      .eq('id', account.profileId)
      .single()
    if (after.error) throw after.error
    expect(after.data.must_change_password).toBe(false)
    expect(after.data.privacy_accepted_at).not.toBeNull()

    const audit = await service.from('audit_events')
      .select('id', { count: 'exact', head: true })
      .eq('actor_profile_id', account.profileId)
      .eq('action', 'account.activation_completed')
    if (audit.error) throw audit.error
    expect(audit.count).toBe(1)
  }, 120_000)
})
