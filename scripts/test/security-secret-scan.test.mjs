import assert from 'node:assert/strict';
import { test } from 'node:test';

import { scanSecretText } from '../lib/secret-scan.mjs';

const labels = (contents, options) =>
  scanSecretText(contents, options).map((finding) => finding.label);

test('detects Supabase secret keys without echoing the value', () => {
  const value = 'sb_' + 'secret_' + 'A'.repeat(28);
  const findings = scanSecretText(`key=${value}`);
  assert.deepEqual(findings.map((finding) => finding.label), ['Supabase secret key']);
  assert.equal(JSON.stringify(findings).includes(value), false);
});

test('detects a service-role JWT but permits a publishable JWT', () => {
  const jwt = (role) => [
    Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url'),
    Buffer.from(JSON.stringify({ role, padding: 'x'.repeat(20) })).toString('base64url'),
    Buffer.from('signature-signature').toString('base64url'),
  ].join('.');
  assert.deepEqual(labels(jwt('service_role')), ['Supabase privileged JWT']);
  assert.deepEqual(labels(jwt('anon')), []);
});

test('detects database credentials but permits the fixed loopback database', () => {
  const protectedUrl = 'postgresql://operator:' +
    'high-entropy-password@db.example.test/postgres';
  assert.deepEqual(
    labels(protectedUrl),
    ['database credential in connection URL'],
  );
  assert.deepEqual(labels('postgresql://postgres:postgres@127.0.0.1:54322/postgres'), []);
});

test('detects literal Cloudflare and VAPID assignments while permitting references', () => {
  const cloudflare = 'CLOUDFLARE_' + `API_TOKEN=${'c'.repeat(40)}`;
  const vapid = 'VAPID_' + `PRIVATE_KEY=${'v'.repeat(43)}`;
  assert.deepEqual(labels(`${cloudflare}\n${vapid}`), [
    'literal privileged environment value',
    'literal privileged environment value',
  ]);
  assert.deepEqual(labels(JSON.stringify({
    ['cloudflare' + 'ApiToken']: 'c'.repeat(40),
    ['vapid' + 'PrivateKey']: 'v'.repeat(43),
  })), [
    'literal privileged environment value',
  ]);
  assert.deepEqual(labels([
    'CLOUDFLARE_' + 'API_TOKEN=${{ secrets.CLOUDFLARE_API_TOKEN }}',
    'VAPID_' + 'PRIVATE_KEY=<configure-in-vendor-secret-store>',
  ].join('\n')), []);
});

test('detects private-key blocks and privileged identifiers in browser bundles', () => {
  const privateKeyBlock = '-----BEGIN ' +
    'PRIVATE KEY-----\nnot-real\n-----END PRIVATE KEY-----';
  assert.deepEqual(
    labels(privateKeyBlock),
    ['private key material'],
  );
  const ageKey = 'AGE-' + 'SECRET-KEY-1' + 'A'.repeat(30);
  assert.deepEqual(labels(ageKey), ['age private key material']);
  const identifier = 'SUPABASE_' + 'SERVICE_ROLE_KEY';
  assert.deepEqual(
    labels(`throw new Error('${identifier} missing')`, { scope: 'browser-bundle' }),
    [`privileged identifier ${identifier}`],
  );
});

test('allows documented placeholders and the exact fixed local-stack key only in its fixture', () => {
  assert.deepEqual(labels([
    'SUPABASE_' + 'SERVICE_ROLE_KEY=server-only-key',
    'SUPABASE_' + 'DB_URL=${{ secrets.SUPABASE_DB_URL }}',
    'CF_' + 'API_TOKEN=...',
  ].join('\n')), []);

  const localKey = 'sb_' + 'secret_' + 'N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz';
  assert.deepEqual(labels(localKey, {
    filePath: 'tests/integration/helpers/stack.ts',
    scope: 'repository',
  }), []);
  assert.deepEqual(labels(localKey, {
    filePath: 'apps/web/src/example.ts',
    scope: 'repository',
  }), ['Supabase secret key']);
});
