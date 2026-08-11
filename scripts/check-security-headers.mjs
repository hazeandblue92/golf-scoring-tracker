import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  scanBrowserBundles,
  scanRepositorySecrets,
} from './lib/secret-scan.mjs';
import {
  FORBIDDEN_CSP_ALLOWANCES,
  FORBIDDEN_CSP_ORIGINS,
  headerExpectation,
  REQUIRED_CSP_DIRECTIVES,
  REQUIRED_HEADERS,
} from './lib/security-headers.mjs';

const requiredHeaders = REQUIRED_HEADERS.map(headerExpectation);
const requiredDirectives = REQUIRED_CSP_DIRECTIVES;
const forbiddenCsp = FORBIDDEN_CSP_ALLOWANCES;
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
for (const [label, pattern] of FORBIDDEN_CSP_ORIGINS) {
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
const [bundleScan, repositoryScan] = await Promise.all([
  scanBrowserBundles(distAssets),
  scanRepositorySecrets(),
]);
if (bundleScan.bundlesScanned === 0) {
  failures.push('no built JavaScript bundles found; run `npm run build` first');
}
for (const finding of [...bundleScan.findings, ...repositoryScan.findings]) {
  failures.push(`${finding.label} found in ${finding.filePath}:${finding.lineNumber}`);
}

if (failures.length > 0) {
  throw new Error(`Security release gate failed:\n- ${failures.join('\n- ')}`);
}

console.log(
  `Security release gate passed (${bundleScan.bundlesScanned} bundles and ` +
  `${repositoryScan.filesScanned} repository/artifact files scanned).`,
);
