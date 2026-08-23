import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  generateTemporaryPassword,
  parseBootstrapArgs,
  runBootstrap,
  validateSupabaseUrl,
} from '../bootstrap-owner.mjs'

const SERVICE_ROLE_ENV = 'SUPABASE_' + 'SERVICE_ROLE_KEY'

const CREATE_ARGS = [
  '--username', 'first.owner',
  '--display-name', 'First Owner',
  '--league-name', 'Test League',
  '--league-slug', 'test-league',
  '--timezone', 'America/Detroit',
  '--confirm',
]

const ATTACH_ARGS = [
  '--username', 'first.owner',
  '--display-name', 'First Owner',
  '--league-id', '00000000-0000-4000-8000-000000000001',
  '--confirm',
]

function fakeClient(options = {}) {
  const calls = {
    create: [],
    update: [],
    delete: [],
    rpc: [],
  }
  const user = {
    id: options.userId ?? '11111111-1111-4111-8111-111111111111',
    email: options.email ?? '0123456789abcdef0123456789abcdef@users.invalid',
    app_metadata: options.appMetadata ?? { initial_owner_bootstrap: true, provider: 'email' },
  }

  const client = {
    from(table) {
      const filters = {}
      return {
        select() { return this },
        eq(column, value) { filters[column] = value; return this },
        limit() { return this },
        async maybeSingle() {
          if (table === 'role_assignments') {
            return { data: options.existingOwner ? { id: 'owner-grant' } : null, error: null }
          }
          if (table === 'leagues') {
            return {
              data: options.existingLeague
                ? { id: filters.id ?? '00000000-0000-4000-8000-000000000001', status: 'active' }
                : null,
              error: null,
            }
          }
          throw new Error(`Unexpected fake table ${table}`)
        },
      }
    },
    auth: {
      admin: {
        async createUser(attributes) {
          calls.create.push(attributes)
          return { data: { user }, error: options.createError ?? null }
        },
        async getUserById(id) {
          return { data: { user: { ...user, id } }, error: options.lookupError ?? null }
        },
        async updateUserById(id, attributes) {
          calls.update.push({ id, attributes })
          return { data: { user: { ...user, id } }, error: options.updateError ?? null }
        },
        async deleteUser(id) {
          calls.delete.push(id)
          return { data: {}, error: options.deleteError ?? null }
        },
      },
    },
    async rpc(name, params) {
      calls.rpc.push({ name, params })
      return {
        data: options.rpcData ?? {
          status: 'bootstrapped',
          profileId: user.id,
          leagueId: '00000000-0000-4000-8000-000000000001',
          createdLeague: !options.existingLeague,
        },
        error: options.rpcError ?? null,
      }
    },
  }
  return { client, calls, user }
}

function capture() {
  let value = ''
  return {
    stream: { write(chunk) { value += chunk; return true } },
    read() { return value },
  }
}

test('parses and normalizes a confirmed fresh-league bootstrap', () => {
  assert.deepEqual(parseBootstrapArgs([
    '--username', 'First.Owner',
    '--display-name', '  First Owner  ',
    '--league-name', '  Test League  ',
    '--league-slug', 'TEST-LEAGUE',
    '--timezone', 'America/Detroit',
    '--confirm',
  ]), {
    username: 'first.owner',
    displayName: 'First Owner',
    leagueId: null,
    leagueName: 'Test League',
    leagueSlug: 'test-league',
    timezone: 'America/Detroit',
    locale: 'en-US',
    recoverUserId: null,
  })
})

test('requires explicit confirmation and a single league mode', () => {
  assert.throws(() => parseBootstrapArgs([
    '--username', 'owner',
    '--display-name', 'Owner',
    '--league-name', 'League',
    '--league-slug', 'league-one',
    '--timezone', 'UTC',
  ]), /--confirm/)

  assert.throws(() => parseBootstrapArgs([
    '--username', 'owner',
    '--display-name', 'Owner',
    '--league-id', '00000000-0000-4000-8000-000000000001',
    '--league-name', 'Unexpected second league',
    '--confirm',
  ]), /cannot be combined/)
})

test('validates recovery ids and account inputs without reading a credential argument', () => {
  assert.throws(() => parseBootstrapArgs([
    '--username', 'Owner With Spaces',
    '--display-name', 'Owner',
    '--league-id', '00000000-0000-4000-8000-000000000001',
    '--confirm',
  ]), /Username/)

  assert.throws(() => parseBootstrapArgs([
    '--username', 'owner',
    '--display-name', 'Owner',
    '--league-id', '00000000-0000-4000-8000-000000000001',
    '--recover-user-id', 'not-a-uuid',
    '--confirm',
  ]), /Recovery user id/)

  assert.throws(() => parseBootstrapArgs(['--service-role-key', 'never', '--confirm']), /Unknown option/)
})

test('allows HTTPS and loopback HTTP but rejects unsafe service-key destinations', () => {
  assert.equal(validateSupabaseUrl('https://example.supabase.co/'), 'https://example.supabase.co')
  assert.equal(validateSupabaseUrl('http://127.0.0.1:54321'), 'http://127.0.0.1:54321')
  assert.throws(() => validateSupabaseUrl('http://example.test'), /HTTPS/)
  assert.throws(() => validateSupabaseUrl('https://user:pass@example.test'), /must not contain credentials/)
  assert.throws(() => validateSupabaseUrl('https://example.test/?target=elsewhere'), /query/)
})

test('generates high-entropy temporary credentials with no shell-hostile characters', () => {
  const values = new Set(Array.from({ length: 32 }, generateTemporaryPassword))
  assert.equal(values.size, 32)
  for (const value of values) {
    assert.match(value, /^[A-Za-z0-9_-]{24}$/)
  }
})

test('runs create, atomic RPC, and recovery-marker cleanup without sending the credential to SQL', async () => {
  const temporaryPassword = 'A_secure-one-time-value'
  const serviceKey = 'server-only-value-that-must-not-appear'
  const fake = fakeClient()
  const stdout = capture()
  const stderr = capture()

  await runBootstrap(CREATE_ARGS, {
    SUPABASE_URL: 'https://example.supabase.co',
    [SERVICE_ROLE_ENV]: serviceKey,
  }, {
    client: fake.client,
    stdout: stdout.stream,
    stderr: stderr.stream,
    generateTemporaryPassword: () => temporaryPassword,
  })

  assert.equal(fake.calls.create.length, 1)
  assert.equal(fake.calls.create[0].password, temporaryPassword)
  assert.equal(fake.calls.create[0].app_metadata.initial_owner_bootstrap, true)
  assert.equal(fake.calls.rpc.length, 1)
  assert.equal(fake.calls.rpc[0].name, 'bootstrap_initial_owner')
  assert.equal(JSON.stringify(fake.calls.rpc[0]).includes(temporaryPassword), false)
  assert.equal(JSON.stringify(fake.calls.rpc[0]).includes(serviceKey), false)
  assert.deepEqual(fake.calls.update.at(-1).attributes.app_metadata, { provider: 'email' })
  assert.deepEqual(fake.calls.delete, [])
  assert.equal(stdout.read().split(temporaryPassword).length - 1, 1)
  assert.equal(stdout.read().includes(serviceKey), false)
  assert.equal(stderr.read(), '')
})

test('deletes a newly created Auth user after an RPC refusal and sanitizes the thrown error', async () => {
  const temporaryPassword = 'B_secure-one-time-value'
  const serviceKey = 'another-server-only-value'
  const fake = fakeClient({
    rpcData: null,
    rpcError: {
      code: '42501',
      message: `hostile detail ${temporaryPassword} ${serviceKey}`,
    },
  })
  const stdout = capture()
  const stderr = capture()

  await assert.rejects(() => runBootstrap(CREATE_ARGS, {
    SUPABASE_URL: 'https://example.supabase.co',
    [SERVICE_ROLE_ENV]: serviceKey,
  }, {
    client: fake.client,
    stdout: stdout.stream,
    stderr: stderr.stream,
    generateTemporaryPassword: () => temporaryPassword,
  }), (error) => {
    assert.match(error.message, /code 42501/)
    assert.equal(error.message.includes(temporaryPassword), false)
    assert.equal(error.message.includes(serviceKey), false)
    return true
  })

  assert.deepEqual(fake.calls.delete, [fake.user.id])
  assert.equal(stdout.read().split(temporaryPassword).length - 1, 1)
  assert.equal(stderr.read().includes(temporaryPassword), false)
  assert.equal(stderr.read().includes(serviceKey), false)
})

test('recovery accepts only a marked internal orphan and rotates its credential before retry', async () => {
  const invalid = fakeClient({
    existingLeague: true,
    email: 'person@example.test',
    appMetadata: {},
  })
  await assert.rejects(() => runBootstrap([
    ...ATTACH_ARGS,
    '--recover-user-id', invalid.user.id,
  ], {
    SUPABASE_URL: 'https://example.supabase.co',
    [SERVICE_ROLE_ENV]: 'server-only',
  }, {
    client: invalid.client,
    stdout: capture().stream,
    stderr: capture().stream,
    generateTemporaryPassword: () => 'C_secure-one-time-value',
  }), /marked by this bootstrap script/)
  assert.equal(invalid.calls.update.length, 0)
  assert.equal(invalid.calls.rpc.length, 0)

  const valid = fakeClient({ existingLeague: true })
  await runBootstrap([
    ...ATTACH_ARGS,
    '--recover-user-id', valid.user.id,
  ], {
    SUPABASE_URL: 'https://example.supabase.co',
    [SERVICE_ROLE_ENV]: 'server-only',
  }, {
    client: valid.client,
    stdout: capture().stream,
    stderr: capture().stream,
    generateTemporaryPassword: () => 'D_secure-one-time-value',
  })
  assert.equal(valid.calls.create.length, 0)
  assert.equal(valid.calls.update[0].attributes.password, 'D_secure-one-time-value')
  assert.equal(valid.calls.rpc.length, 1)
  assert.equal(valid.calls.delete.length, 0)
})
