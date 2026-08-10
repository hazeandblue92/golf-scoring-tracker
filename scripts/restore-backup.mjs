import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const artifactPath = args.find((arg) => !arg.startsWith('--'));
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

if (!artifactPath || !args.includes('--reset-local')) {
  throw new Error('Usage: npm run restore:backup -- BACKUP.age --reset-local [--checksum FILE] [--report FILE]');
}

const databaseUrl = process.env.LOCAL_DATABASE_URL ??
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const parsedDatabaseUrl = new URL(databaseUrl);
if (!['127.0.0.1', 'localhost'].includes(parsedDatabaseUrl.hostname) || parsedDatabaseUrl.port !== '54322') {
  throw new Error('Restore refused: LOCAL_DATABASE_URL must point to localhost port 54322.');
}

const identityFile = process.env.AGE_IDENTITY_FILE;
if (!identityFile) throw new Error('AGE_IDENTITY_FILE must point to the owner-held private age key.');

const checksumPath = option('--checksum') ?? `${artifactPath}.sha256`;
const reportPath = path.resolve(option('--report') ?? 'phase4-restore-report.json');
const encrypted = await readFile(artifactPath);
const expectedChecksum = (await readFile(checksumPath, 'utf8')).trim().split(/\s+/)[0];
const actualChecksum = createHash('sha256').update(encrypted).digest('hex');
if (expectedChecksum !== actualChecksum) throw new Error('Encrypted backup checksum does not match.');

const startedAt = new Date();
const scratch = await mkdtemp(path.join(tmpdir(), 'gtt-restore-'));
try {
  const archivePath = path.join(scratch, 'backup.tar.gz');
  execFileSync('age', ['--decrypt', '--identity', identityFile, '--output', archivePath, artifactPath], {
    stdio: 'inherit',
  });

  const entries = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  if (entries.some((entry) => entry.startsWith('/') || entry.split('/').includes('..'))) {
    throw new Error('Backup archive contains an unsafe path.');
  }
  execFileSync('tar', ['-xzf', archivePath, '-C', scratch], { stdio: 'inherit' });

  const files = await readdir(scratch);
  const dumpPath = path.join(scratch, files.find((file) => file.endsWith('.dump')) ?? 'database.dump');
  const manifestPath = path.join(scratch, files.find((file) => file.endsWith('manifest.json')) ?? 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const migrationFiles = (await readdir(path.resolve('supabase/migrations')))
    .filter((file) => file.endsWith('.sql')).sort();
  const latestMigration = migrationFiles.at(-1);
  if (manifest.latestMigration !== latestMigration) {
    throw new Error(`Backup schema ${manifest.latestMigration} does not match repository schema ${latestMigration}.`);
  }

  execFileSync('npx', ['supabase', 'db', 'reset', '--local', '--no-seed', '--yes'], { stdio: 'inherit' });
  execFileSync('pg_restore', [
    '--dbname', databaseUrl,
    '--data-only',
    '--disable-triggers',
    '--exit-on-error',
    '--no-owner',
    dumpPath,
  ], { stdio: 'inherit' });

  const integrity = execFileSync('psql', [databaseUrl, '--no-psqlrc', '-At', '-c', [
    "select json_build_object(",
    "'events', (select count(*) from public.events),",
    "'scoreMutations', (select count(*) from public.score_mutations),",
    "'openConflicts', (select count(*) from public.score_conflicts where status = 'open'),",
    "'orphanIndividualScores', (select count(*) from public.individual_hole_scores s left join public.events e on e.id = s.event_id where e.id is null),",
    "'orphanTeamScores', (select count(*) from public.team_hole_scores s left join public.events e on e.id = s.event_id where e.id is null)",
    ");",
  ].join(' ')], { encoding: 'utf8' }).trim();

  const completedAt = new Date();
  const report = {
    status: 'restored_pending_verification',
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationSeconds: Math.round((completedAt.getTime() - startedAt.getTime()) / 1000),
    encryptedChecksum: actualChecksum,
    backupRunId: manifest.backupRunId ?? null,
    latestMigration,
    integrity: JSON.parse(integrity),
    requiredVerification: [
      'Run the RLS integration suite against the restored database.',
      'Rebuild projections from the Operations screen.',
      'Compare a representative leaderboard with its event export.',
    ],
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(`Restore completed; verification is still required. Pending report: ${reportPath}`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
