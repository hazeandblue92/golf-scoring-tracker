import { readFile } from 'node:fs/promises';

const approved = new Set([
  '(MIT OR CC0-1.0)',
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'CC-BY-4.0',
  'ISC',
  'MIT',
  'MPL-2.0',
]);

const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const packages = Object.entries(lock.packages ?? {});
const unknown = [];
const counts = new Map();

for (const [packagePath, metadata] of packages) {
  if (metadata.link) continue;
  const license = metadata.license;
  if (typeof license !== 'string' || !approved.has(license)) {
    unknown.push({ packagePath: packagePath || '(root)', license: license ?? '(missing)' });
    continue;
  }
  counts.set(license, (counts.get(license) ?? 0) + 1);
}

console.log(JSON.stringify({
  checkedPackages: packages.length,
  approvedLicenses: Object.fromEntries([...counts].sort()),
  exceptions: unknown,
}, null, 2));

if (unknown.length > 0) {
  throw new Error('Dependency license review is required before release.');
}
