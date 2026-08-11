/**
 * Prove the DEPLOYED site serves the production response policy (spec §23.3,
 * AC-SEC-003).
 *
 * `check-security-headers.mjs` proves the policy is declared in `_headers` and
 * survives the build. It cannot prove the host applies it: a Pages project
 * with the wrong output directory, a stale deployment, or a `_headers` file
 * that never shipped all look identical from the repository. This gate asks
 * the real origin.
 *
 * Usage: node scripts/check-deployed-headers.mjs https://<project>.pages.dev
 *        DEPLOYMENT_URL=https://... node scripts/check-deployed-headers.mjs
 */

import {
  FORBIDDEN_CSP_ALLOWANCES,
  FORBIDDEN_CSP_ORIGINS,
  REQUIRED_CSP_DIRECTIVES,
  REQUIRED_HEADERS,
} from './lib/security-headers.mjs';

const rawUrl = process.argv[2] ?? process.env.DEPLOYMENT_URL ?? '';
if (rawUrl.trim() === '') {
  throw new Error(
    'No deployment URL. Pass it as an argument or set DEPLOYMENT_URL, e.g.\n' +
    '  node scripts/check-deployed-headers.mjs https://<project>.pages.dev',
  );
}

const origin = new URL(rawUrl.trim());
if (origin.protocol !== 'https:') {
  throw new Error(`Deployment URL must be https, received ${origin.protocol}//`);
}

const failures = [];
const notes = [];

/** One request, following redirects, with a bounded wait. */
async function fetchPath(pathname) {
  const target = new URL(pathname, origin);
  const response = await fetch(target, {
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
    headers: { 'User-Agent': 'gtt-deployment-gate' },
  });
  return { target, response };
}

// ── The document itself carries the policy ──────────────────────────────────
const { response: root } = await fetchPath('/');
if (!root.ok) failures.push(`GET / returned ${root.status}`);

for (const requirement of REQUIRED_HEADERS) {
  const actual = root.headers.get(requirement.name);
  if (actual === null) {
    failures.push(`missing response header: ${requirement.name}`);
    continue;
  }
  if (
    requirement.value !== undefined &&
    actual.trim().toLowerCase() !== requirement.value.toLowerCase()
  ) {
    failures.push(
      `${requirement.name} is "${actual.trim()}", expected "${requirement.value}"`,
    );
  }
}

const csp = root.headers.get('Content-Security-Policy') ?? '';
for (const directive of REQUIRED_CSP_DIRECTIVES) {
  if (!csp.includes(directive)) failures.push(`served CSP is missing: ${directive}`);
}
for (const forbidden of FORBIDDEN_CSP_ALLOWANCES) {
  if (csp.includes(forbidden)) failures.push(`served CSP grants an unsafe allowance: ${forbidden}`);
}
for (const [label, pattern] of FORBIDDEN_CSP_ORIGINS) {
  if (pattern.test(csp)) failures.push(`${label} in the served CSP`);
}

// ── Cache rules: a stale shell is how a bad release survives a rollback ──────
const { response: indexHtml } = await fetchPath('/index.html');
const indexCache = indexHtml.headers.get('Cache-Control') ?? '';
if (!indexCache.includes('no-store')) {
  failures.push(`/index.html Cache-Control is "${indexCache}", expected no-store`);
}

const html = await root.text();
const assetPath = /\/assets\/[A-Za-z0-9._-]+\.js/.exec(html)?.[0];
if (assetPath === undefined) {
  failures.push('the served document references no hashed /assets/*.js bundle');
} else {
  const { response: asset } = await fetchPath(assetPath);
  const assetCache = asset.headers.get('Cache-Control') ?? '';
  if (!assetCache.includes('immutable')) {
    failures.push(`${assetPath} Cache-Control is "${assetCache}", expected immutable`);
  }
  notes.push(`hashed asset ${assetPath} served with "${assetCache}"`);
}

// ── SPA fallback: a deep link must reach the app, not a host 404 ─────────────
const deepLink = '/events/00000000-0000-4000-8000-000000000000';
const { response: deep } = await fetchPath(deepLink);
if (!deep.ok) {
  failures.push(`SPA fallback failed: GET ${deepLink} returned ${deep.status}`);
} else if (!(deep.headers.get('Content-Type') ?? '').includes('text/html')) {
  failures.push(`SPA fallback returned ${deep.headers.get('Content-Type')}, expected text/html`);
}

if (failures.length > 0) {
  throw new Error(
    `Deployed security gate failed for ${origin.origin}:\n- ${failures.join('\n- ')}`,
  );
}

console.log(
  `Deployed security gate passed for ${origin.origin} ` +
  `(${REQUIRED_HEADERS.length} headers, ${REQUIRED_CSP_DIRECTIVES.length} CSP directives, ` +
  `cache rules, and SPA fallback verified).`,
);
for (const note of notes) console.log(`  ${note}`);
