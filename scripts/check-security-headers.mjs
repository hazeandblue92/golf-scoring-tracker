import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const requiredHeaders = [
  'Content-Security-Policy:',
  'Cross-Origin-Opener-Policy: same-origin',
  'Permissions-Policy:',
  'Referrer-Policy: no-referrer',
  'Strict-Transport-Security:',
  'X-Content-Type-Options: nosniff',
  'X-Frame-Options: DENY',
];
const requiredDirectives = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
];
const forbiddenCsp = ["script-src 'self' 'unsafe-inline'", "script-src 'self' 'unsafe-eval'"];
const forbiddenBundlePatterns = [
  ['service role variable', /SUPABASE_SERVICE_ROLE_KEY/g],
  ['database connection string', /postgres(?:ql)?:\/\//g],
  ['Supabase legacy service token', /eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/g],
];

const headersPath = path.resolve('apps/web/public/_headers');
const distHeadersPath = path.resolve('apps/web/dist/_headers');
const [headers, distHeaders] = await Promise.all([
  readFile(headersPath, 'utf8'),
  readFile(distHeadersPath, 'utf8').catch(() => {
    throw new Error('Built deployment headers are missing. Run `npm run build` first.');
  }),
]);

const failures = [];
for (const expected of requiredHeaders) {
  if (!headers.includes(expected)) failures.push(`missing deployment header: ${expected}`);
  if (!distHeaders.includes(expected)) failures.push(`missing built deployment header: ${expected}`);
}
for (const directive of requiredDirectives) {
  if (!headers.includes(directive) || !distHeaders.includes(directive)) {
    failures.push(`missing CSP directive in source or built deployment policy: ${directive}`);
  }
}
for (const forbidden of forbiddenCsp) {
  if (headers.includes(forbidden) || distHeaders.includes(forbidden)) {
    failures.push(`unsafe CSP allowance: ${forbidden}`);
  }
}

// The deployment policy is host-delivered and applies ONLY to the built site.
// Nothing local reads it: Vite's dev server (which Playwright drives) never
// applies _headers, so a localhost or plaintext origin here buys no local
// convenience and only widens what the production page may talk to.
for (const [label, pattern] of [
  ['loopback origin', /(?:127\.0\.0\.1|\[?::1\]?|localhost)/],
  ['plaintext http origin', /(?:^|\s)http:\/\//],
  ['plaintext websocket origin', /(?:^|\s)ws:\/\//],
]) {
  for (const [source, policy] of [['source', headers], ['built', distHeaders]]) {
    const csp = policy
      .split('\n')
      .find((line) => line.includes('Content-Security-Policy:'));
    if (csp && pattern.test(csp)) {
      failures.push(`${label} in ${source} deployment CSP: production policy must not allow it`);
    }
  }
}

const distAssets = path.resolve('apps/web/dist/assets');
const assetNames = await readdir(distAssets).catch(() => []);
for (const assetName of assetNames.filter((name) => name.endsWith('.js'))) {
  const contents = await readFile(path.join(distAssets, assetName), 'utf8');
  for (const [label, pattern] of forbiddenBundlePatterns) {
    if (pattern.test(contents)) failures.push(`${label} found in ${assetName}`);
    pattern.lastIndex = 0;
  }
}

if (failures.length > 0) {
  throw new Error(`Security release gate failed:\n- ${failures.join('\n- ')}`);
}

console.log(`Security release gate passed (${assetNames.filter((name) => name.endsWith('.js')).length} bundles scanned).`);
