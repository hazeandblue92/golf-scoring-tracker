const [command, runId, value] = process.argv.slice(2);
const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
}

const headers = {
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  'Content-Type': 'application/json',
};

async function request(path, init) {
  const response = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/${path}`, {
    ...init,
    headers: { ...headers, ...init.headers },
  });
  if (!response.ok) {
    throw new Error(`Backup metadata request failed with HTTP ${response.status}.`);
  }
  return response;
}

if (command === 'start') {
  const response = await request('backup_runs', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      started_at: new Date().toISOString(),
      workflow_run_url: process.env.BACKUP_WORKFLOW_URL ?? null,
      status: 'running',
    }),
  });
  const rows = await response.json();
  if (!rows[0]?.id) throw new Error('Backup metadata did not return a run id.');
  process.stdout.write(rows[0].id);
} else if (command === 'finish') {
  if (!runId || !['succeeded', 'failed'].includes(value)) {
    throw new Error('Usage: record-backup-run.mjs finish RUN_ID succeeded|failed');
  }
  await request(`backup_runs?id=eq.${encodeURIComponent(runId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      status: value,
      completed_at: new Date().toISOString(),
      artifact_checksum: process.env.BACKUP_CHECKSUM ?? null,
      artifact_size_bytes: process.env.BACKUP_SIZE_BYTES
        ? Number(process.env.BACKUP_SIZE_BYTES)
        : null,
    }),
  });
} else if (command === 'restore-tested') {
  if (!runId) throw new Error('Usage: record-backup-run.mjs restore-tested RUN_ID');
  await request(`backup_runs?id=eq.${encodeURIComponent(runId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ last_tested_restore_on: new Date().toISOString().slice(0, 10) }),
  });
} else {
  throw new Error('Expected start, finish, or restore-tested command.');
}
