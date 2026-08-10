import { readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

const distRoot = path.resolve('apps/web/dist');
const indexPath = path.join(distRoot, 'index.html');
const budgetBytes = 250 * 1024;

const html = await readFile(indexPath, 'utf8').catch(() => {
  throw new Error('Production build is missing. Run `npm run build` first.');
});

const initialFiles = new Set();
for (const match of html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+\.js)"/g)) {
  initialFiles.add(match[1]);
}

if (initialFiles.size === 0) {
  throw new Error('No initial JavaScript files were found in the production index.');
}

let totalBytes = 0;
const rows = [];
for (const browserPath of [...initialFiles].sort()) {
  const filePath = path.join(distRoot, browserPath.replace(/^\//, ''));
  await stat(filePath);
  const gzipBytes = gzipSync(await readFile(filePath), { level: 9 }).byteLength;
  totalBytes += gzipBytes;
  rows.push({ file: browserPath, gzipKiB: Number((gzipBytes / 1024).toFixed(2)) });
}

console.log(JSON.stringify({
  budgetKiB: budgetBytes / 1024,
  initialGzipKiB: Number((totalBytes / 1024).toFixed(2)),
  files: rows,
}, null, 2));

if (totalBytes > budgetBytes) {
  throw new Error(`Initial JavaScript is ${(totalBytes / 1024).toFixed(2)} KiB gzip; budget is 250 KiB.`);
}
