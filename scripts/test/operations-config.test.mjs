import assert from 'node:assert/strict'
import { test } from 'node:test'
import { operationsConfig } from '../lib/operations-config.mjs'

const parts = {
  SUPABASE_DB_HOST: 'db.example.test',
  SUPABASE_DB_USER: 'postgres.example',
  SUPABASE_DB_PASSWORD: 'not-a-secret:@/?#% value',
}

test('encodes credentials and requires TLS without leaking them in errors', () => {
  const url = new URL(operationsConfig(parts).SUPABASE_DB_URL)
  assert.equal(decodeURIComponent(url.password), parts.SUPABASE_DB_PASSWORD)
  assert.equal(url.searchParams.get('sslmode'), 'require')
  for (const key of Object.keys(parts)) {
    assert.throws(() => operationsConfig({ ...parts, [key]: '' }), new RegExp(key))
  }
})

test('rejects incomplete URLs and malformed hosts before invoking PostgreSQL', () => {
  for (const value of ['', 'postgresql:///postgres', 'https://user:not-a-secret@db.example/db', 'secret string']) {
    assert.throws(() => operationsConfig({ SUPABASE_DB_URL: value }))
  }
  assert.throws(() => operationsConfig({ ...parts, SUPABASE_DB_HOST: 'db.test/other' }))
  assert.throws(() => operationsConfig({ ...parts, SUPABASE_DB_PASSWORD: 'not-a-secret\nOTHER=x' }))
})

test('supports a complete legacy URL and validates all backup prerequisites', () => {
  const env = {
    SUPABASE_DB_URL: 'postgresql://user:not-a-secret@db.example/postgres?sslmode=disable',
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'not-a-secret',
    AGE_BACKUP_RECIPIENT: `age1${'q'.repeat(58)}`,
  }
  assert.equal(new URL(operationsConfig(env).SUPABASE_DB_URL).searchParams.get('sslmode'), 'require')
  assert.equal(operationsConfig(env, { backup: true }).SUPABASE_URL, env.SUPABASE_URL)
  for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'AGE_BACKUP_RECIPIENT']) {
    assert.throws(() => operationsConfig({ ...env, [key]: '' }, { backup: true }), new RegExp(key))
  }
  assert.throws(() => operationsConfig({ ...env, AGE_BACKUP_RECIPIENT: 'AGE-SECRET-KEY-test' }, { backup: true }))
})
