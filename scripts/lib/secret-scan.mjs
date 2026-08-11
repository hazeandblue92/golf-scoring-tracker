import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SECRET_ASSIGNMENT_NAMES = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SECRET_KEY',
  'SUPABASE_ACCESS_TOKEN',
  'SUPABASE_DB_URL',
  'SUPABASE_DB_PASSWORD',
  'DATABASE_URL',
  'PGPASSWORD',
  'POSTGRES_PASSWORD',
  'POSTGRES_DB_PASSWORD',
  'DB_PASSWORD',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_API_KEY',
  'CLOUDFLARE_GLOBAL_API_KEY',
  'CF_API_TOKEN',
  'CF_API_KEY',
  'VAPID_PRIVATE_KEY',
  'WEB_PUSH_PRIVATE_KEY',
  'supabaseServiceRoleKey',
  'serviceRoleKey',
  'databaseUrl',
  'dbPassword',
  'postgresPassword',
  'cloudflareApiToken',
  'cloudflareApiKey',
  'vapidPrivateKey',
  'webPushPrivateKey',
];

const BROWSER_ONLY_IDENTIFIERS = [
  ...SECRET_ASSIGNMENT_NAMES,
  'PRIVATE_VAPID_KEY',
];

const LOCAL_STACK_SERVICE_KEY_HASH =
  'c85debb55f2f204d868cc1552c42faa143b4c675f61363ab040dd50b5b5304cd';

const SKIPPED_WALK_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'supabase/.branches',
  'supabase/.temp',
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function decodeJwtPayload(token) {
  try {
    const payload = token.split('.')[1];
    if (payload === undefined) return null;
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function isPlaceholder(rawValue) {
  const value = rawValue
    .trim()
    .replace(/^["']|["'`,;\\]+$/g, '')
    .trim();
  if (value === '') return true;
  if (/^(?:\$\{\{|\$\{|\$|process\.env\.|Deno\.env\.|import\.meta\.env\.)/.test(value)) {
    return true;
  }
  if (/^(?:string|number|boolean|unknown|never)(?:\s|$)/.test(value)) return true;
  if (/^(?:\.{3}(?:\s|$)|<[^>]+>|\[[^\]]+\])/.test(value)) return true;
  return /(?:example|placeholder|redacted|replace[-_ ]?me|change[-_ ]?me|your[-_]|server[-_ ]?only|local[-_]|not[-_ ]?a[-_ ]?secret)/i
    .test(value);
}

function isAllowedLocalDatabaseUrl(candidate) {
  try {
    const url = new URL(candidate);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    return loopback && url.username === 'postgres' && url.password === 'postgres';
  } catch {
    return false;
  }
}

function isAllowedLocalStackKey(filePath, value, scope) {
  return scope === 'repository' &&
    filePath.replaceAll('\\', '/') === 'tests/integration/helpers/stack.ts' &&
    sha256(value) === LOCAL_STACK_SERVICE_KEY_HASH;
}

function pushFinding(findings, label, lineNumber) {
  if (!findings.some((finding) =>
    finding.label === label && finding.lineNumber === lineNumber)) {
    findings.push({ label, lineNumber });
  }
}

/**
 * Inspect text without ever returning the matched value. Release logs may
 * safely print the label, file, and line number without echoing a credential.
 */
export function scanSecretText(
  contents,
  { filePath = '(memory)', scope = 'repository' } = {},
) {
  const findings = [];
  const lines = contents.split(/\r?\n/);

  for (const match of contents.matchAll(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g)) {
    const lineNumber = contents.slice(0, match.index).split(/\r?\n/).length;
    pushFinding(findings, 'private key material', lineNumber);
  }

  for (const match of contents.matchAll(/\bAGE-SECRET-KEY-1[A-Z0-9]{20,}\b/g)) {
    const lineNumber = contents.slice(0, match.index).split(/\r?\n/).length;
    pushFinding(findings, 'age private key material', lineNumber);
  }

  for (const match of contents.matchAll(/\bsb_secret_[A-Za-z0-9_-]{20,}\b/g)) {
    const value = match[0];
    if (!isAllowedLocalStackKey(filePath, value, scope)) {
      const lineNumber = contents.slice(0, match.index).split(/\r?\n/).length;
      pushFinding(findings, 'Supabase secret key', lineNumber);
    }
  }

  for (const match of contents.matchAll(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g)) {
    const payload = decodeJwtPayload(match[0]);
    if (payload?.role === 'service_role' || payload?.role === 'supabase_admin') {
      const lineNumber = contents.slice(0, match.index).split(/\r?\n/).length;
      pushFinding(findings, 'Supabase privileged JWT', lineNumber);
    }
  }

  for (const match of contents.matchAll(/\bpostgres(?:ql)?:\/\/[^\s"'`<>]+/gi)) {
    const candidate = match[0].replace(/[),.;]+$/, '');
    try {
      const url = new URL(candidate);
      if (url.password !== '' && !isPlaceholder(url.password) &&
          !isAllowedLocalDatabaseUrl(candidate)) {
        const lineNumber = contents.slice(0, match.index).split(/\r?\n/).length;
        pushFinding(findings, 'database credential in connection URL', lineNumber);
      }
    } catch {
      // An invalid example URL is not a usable credential. Literal assignments
      // are still covered below.
    }
  }

  const assignmentPattern = new RegExp(
    `\\b(?:["']?)(?:${SECRET_ASSIGNMENT_NAMES.join('|')})(?:["']?)\\s*(?:=|:)\\s*(.+)$`,
    'i',
  );
  for (const [index, line] of lines.entries()) {
    const match = assignmentPattern.exec(line);
    if (match === null) continue;
    const rawValue = match[1]?.trim() ?? '';
    if (!isPlaceholder(rawValue)) {
      pushFinding(findings, 'literal privileged environment value', index + 1);
    }
  }

  if (scope === 'browser-bundle') {
    for (const identifier of BROWSER_ONLY_IDENTIFIERS) {
      const index = contents.indexOf(identifier);
      if (index >= 0) {
        const lineNumber = contents.slice(0, index).split(/\r?\n/).length;
        pushFinding(findings, `privileged identifier ${identifier}`, lineNumber);
      }
    }
  }

  return findings;
}

function looksBinary(buffer) {
  return buffer.subarray(0, Math.min(buffer.byteLength, 8_192)).includes(0);
}

async function scanFile(root, relativePath, scope) {
  const absolutePath = path.resolve(root, relativePath);
  const buffer = await readFile(absolutePath).catch(() => null);
  if (buffer === null || looksBinary(buffer)) return [];
  return scanSecretText(buffer.toString('utf8'), { filePath: relativePath, scope })
    .map((finding) => ({ ...finding, filePath: relativePath }));
}

async function trackedFiles(root) {
  const { stdout } = await execFileAsync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: root,
      encoding: 'buffer',
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  return stdout.toString('utf8').split('\0').filter(Boolean);
}

function isArtifactCandidate(relativePath) {
  const normalized = relativePath.replaceAll('\\', '/');
  const basename = path.basename(normalized);
  if (/^\.env(?:\.|$)/.test(basename) || /\.log$/i.test(basename)) return true;
  if (/^gtt-.+\.json$/i.test(basename)) return true;
  if (/(?:^|\/)(?:logs?|exports?|backups?|reports?)(?:\/|$)/i.test(normalized)) return true;
  return /(?:export|backup|report|dump).+\.(?:json|txt|csv)$/i.test(basename);
}

async function artifactFiles(root) {
  const result = [];
  async function walk(directory, relativeDirectory = '') {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const relativePath = path.join(relativeDirectory, entry.name);
      const normalized = relativePath.replaceAll('\\', '/');
      if (entry.isDirectory()) {
        if ([...SKIPPED_WALK_DIRECTORIES].some((skipped) =>
          normalized === skipped || normalized.startsWith(`${skipped}/`))) continue;
        await walk(path.join(directory, entry.name), relativePath);
      } else if (entry.isFile() && isArtifactCandidate(relativePath)) {
        result.push(normalized);
      }
    }
  }
  await walk(root);
  return result;
}

export async function scanRepositorySecrets(root = process.cwd()) {
  const [tracked, artifacts] = await Promise.all([
    trackedFiles(root),
    artifactFiles(root),
  ]);
  const paths = [...new Set([...tracked, ...artifacts])].sort();
  const findings = [];
  for (const filePath of paths) {
    findings.push(...await scanFile(root, filePath, 'repository'));
  }
  return { filesScanned: paths.length, findings };
}

export async function scanBrowserBundles(distAssets) {
  const assetNames = await readdir(distAssets).catch(() => []);
  const bundles = assetNames.filter((name) => name.endsWith('.js')).sort();
  const findings = [];
  for (const assetName of bundles) {
    const contents = await readFile(path.join(distAssets, assetName), 'utf8');
    for (const finding of scanSecretText(contents, {
      filePath: assetName,
      scope: 'browser-bundle',
    })) {
      findings.push({ ...finding, filePath: assetName });
    }
  }
  return { bundlesScanned: bundles.length, findings };
}
