import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

if (process.env.LOAD_ALLOW_SYNTHETIC !== 'true') {
  throw new Error('Capacity run refused. Set LOAD_ALLOW_SYNTHETIC=true for a disposable test event.');
}

const configPath = process.env.LOAD_CONFIG;
const supabaseUrl = process.env.SUPABASE_URL;
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
const accessToken = process.env.LOAD_TEST_ACCESS_TOKEN ?? (process.env.LOAD_TEST_ACCESS_TOKEN_FILE
  ? (await readFile(process.env.LOAD_TEST_ACCESS_TOKEN_FILE, 'utf8')).trim()
  : undefined);
if (!configPath || !supabaseUrl || !publishableKey || !accessToken) {
  throw new Error('LOAD_CONFIG, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, and a load-test access token are required.');
}

const config = JSON.parse(await readFile(configPath, 'utf8'));
if (!config.eventId || !config.competitionId || !Array.isArray(config.scoreCells) || config.scoreCells.length < 900) {
  throw new Error('Load config must contain eventId, competitionId, and at least 900 distinct disposable scoreCells.');
}

const authorization = { apikey: publishableKey, Authorization: `Bearer ${accessToken}` };
const percentile = (values, fraction) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
};
const timedFetch = async (url, init) => {
  const start = performance.now();
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    const responseText = await response.text();
    let errorCode;
    let detail;
    let eventRevision;
    let projectionRevision;
    try {
      const body = JSON.parse(responseText);
      errorCode = typeof body.errorCode === 'string' ? body.errorCode : undefined;
      detail = typeof body.detail === 'string' ? body.detail : undefined;
      eventRevision = typeof body.eventRevision === 'number' ? body.eventRevision : undefined;
      projectionRevision = typeof body.projectionRevision === 'number'
        ? body.projectionRevision
        : undefined;
    } catch {
      // Successful projection responses do not need body-level load evidence.
    }
    return {
      status: response.status,
      durationMs: Math.round(performance.now() - start),
      errorCode,
      detail,
      eventRevision,
      projectionRevision,
      completedAtMs: performance.now(),
    };
  } catch (error) {
    return {
      status: 0,
      durationMs: Math.round(performance.now() - start),
      error: error instanceof Error ? error.name : 'transport_error',
      completedAtMs: performance.now(),
    };
  }
};

const resilientFetch = async (url, init) => {
  const startedAt = performance.now();
  let result;
  let firstStatus;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    result = await timedFetch(url, init);
    firstStatus ??= result.status;
    if (result.status !== 0 && result.status < 500) {
      return {
        ...result,
        durationMs: Math.round(performance.now() - startedAt),
        requestStartedAtMs: startedAt,
        firstStatus,
        retryCount: attempt,
      };
    }
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
  }
  return {
    ...result,
    durationMs: Math.round(performance.now() - startedAt),
    requestStartedAtMs: startedAt,
    firstStatus,
    retryCount: 4,
  };
};

const resilientJson = async (url, init) => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
      if (response.ok) return await response.json();
    } catch {
      // Retry the same authenticated read below.
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
  }
  throw new Error('Projection convergence read failed after retries.');
};

const realtimeClients = Array.from({ length: 120 }, () => createClient(supabaseUrl, publishableKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { Authorization: `Bearer ${accessToken}` } },
  realtime: { params: { eventsPerSecond: 10 } },
}));

await Promise.all(realtimeClients.map((client) => client.realtime.setAuth(accessToken)));
const realtimeStartedAt = performance.now();
const realtimeDeliveries = Array.from({ length: realtimeClients.length }, () => ({
  revision: -1,
  receivedAtMs: -1,
}));
const subscriptions = await Promise.all(realtimeClients.map((client, index) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ index, status: 'TIMED_OUT' }), 20_000);
  client.channel(`capacity-${index}`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'event_revision_feed',
      filter: `event_id=eq.${config.eventId}`,
    }, (payload) => {
      const revision = Number(payload.new?.projection_revision ?? -1);
      if (revision >= realtimeDeliveries[index].revision) {
        realtimeDeliveries[index] = { revision, receivedAtMs: performance.now() };
      }
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        clearTimeout(timer);
        resolve({ index, status });
      }
    });
})));
const realtimeSetupDurationMs = Math.round(performance.now() - realtimeStartedAt);

const leaderboardUrl = new URL(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/competition_projections`);
leaderboardUrl.searchParams.set('select', 'competition_id,event_revision,calculated_at');
leaderboardUrl.searchParams.set('competition_id', `eq.${config.competitionId}`);
leaderboardUrl.searchParams.set('order', 'event_revision.desc');
leaderboardUrl.searchParams.set('limit', '1');

const leaderboardRequests = Array.from({ length: 120 }, () => resilientFetch(leaderboardUrl, {
  headers: authorization,
}));

const scoreRequests = [];
for (let second = 0; second < 30; second += 1) {
  for (let index = 0; index < 30; index += 1) {
    const cell = config.scoreCells[(second * 30) + index];
    scoreRequests.push(new Promise((resolve) => setTimeout(async () => {
      const body = {
        idempotencyKey: randomUUID(),
        eventId: config.eventId,
        roundId: cell.roundId,
        target: cell.target,
        baseRevision: Number(cell.baseRevision ?? 0),
        value: { status: 'complete', grossStrokes: 4 + (index % 2), notes: null },
        clientRecordedAt: new Date().toISOString(),
        clientRelease: '0.1.0',
      };
      try {
        resolve(await resilientFetch(`${supabaseUrl.replace(/\/$/, '')}/functions/v1/submit-score`, {
          method: 'POST',
          headers: { ...authorization, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }));
      } catch (error) {
        resolve({ status: 0, durationMs: 0, error: String(error) });
      }
    }, second * 1000)));
  }
}

const [leaderboards, scores] = await Promise.all([
  Promise.all(leaderboardRequests),
  Promise.all(scoreRequests),
]);

const eventRows = await resilientJson(
  `${supabaseUrl.replace(/\/$/, '')}/rest/v1/events?select=scoring_revision&id=eq.${config.eventId}`,
  { headers: authorization },
);
const eventRevision = Number(eventRows[0]?.scoring_revision ?? -1);
const competitionIds = Array.isArray(config.competitionIds)
  ? config.competitionIds
  : [config.competitionId];
let projectionRows = [];
let projectionsCurrent = false;
const visibilityDeadline = performance.now() + 3_500;
do {
  projectionRows = await Promise.all(competitionIds.map(async (competitionId) => {
    const rows = await resilientJson(
      `${supabaseUrl.replace(/\/$/, '')}/rest/v1/competition_projections?select=event_revision&competition_id=eq.${competitionId}&order=event_revision.desc&limit=1`,
      { headers: authorization },
    );
    return { competitionId, projectionRevision: Number(rows[0]?.event_revision ?? -1) };
  }));
  projectionsCurrent = eventRevision >= 0 &&
    projectionRows.every((row) => row.projectionRevision === eventRevision);
  const allRealtimeCurrent = realtimeDeliveries.every((delivery) =>
    delivery.revision >= eventRevision);
  if (projectionsCurrent && allRealtimeCurrent) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
} while (performance.now() < visibilityDeadline);

await Promise.all(realtimeClients.map((client) => client.removeAllChannels()));
const scoreSuccess = scores.filter((result) => result.status >= 200 && result.status < 300);
const leaderboardSuccess = leaderboards.filter((result) => result.status >= 200 && result.status < 300);
const finalRevisionRequestStartedAtMs = Math.min(...scoreSuccess
  .filter((result) => result.eventRevision === eventRevision)
  .map((result) => result.requestStartedAtMs));
const projectionVisibilityMs = realtimeDeliveries
  .filter((delivery) => delivery.revision >= eventRevision)
  .map((delivery) => Math.max(
    0,
    Math.round(delivery.receivedAtMs - finalRevisionRequestStartedAtMs),
  ));
const report = {
  generatedAt: new Date().toISOString(),
  profile: {
    realtimeClients: 120,
    scoreWritesPerSecond: 30,
    scoreBurstSeconds: 30,
    leaderboardRefreshes: 120,
  },
  realtime: {
    connected: subscriptions.filter((result) => result.status === 'SUBSCRIBED').length,
    setupDurationMs: realtimeSetupDurationMs,
    finalScoreRevisionObserved: Number.isFinite(finalRevisionRequestStartedAtMs),
    deliveredFinalRevision: projectionVisibilityMs.length,
    projectionVisibilityP95Ms: percentile(projectionVisibilityMs, 0.95),
    statuses: Object.fromEntries([...new Set(subscriptions.map((result) => result.status))]
      .map((status) => [status, subscriptions.filter((result) => result.status === status).length])),
  },
  scoreWrites: {
    attempted: scores.length,
    successful: scoreSuccess.length,
    statusCounts: Object.fromEntries([...new Set(scores.map((result) => result.status))]
      .map((status) => [status, scores.filter((result) => result.status === status).length])),
    errorCounts: Object.fromEntries([...new Set(scores.map((result) => result.errorCode ?? result.error).filter(Boolean))]
      .map((error) => [error, scores.filter((result) => (result.errorCode ?? result.error) === error).length])),
    retried: scores.filter((result) => result.retryCount > 0).length,
    p50Ms: percentile(scores.map((result) => result.durationMs), 0.50),
    p95Ms: percentile(scores.map((result) => result.durationMs), 0.95),
  },
  leaderboard: {
    attempted: leaderboards.length,
    successful: leaderboardSuccess.length,
    statusCounts: Object.fromEntries([...new Set(leaderboards.map((result) => result.status))]
      .map((status) => [status, leaderboards.filter((result) => result.status === status).length])),
    retried: leaderboards.filter((result) => result.retryCount > 0).length,
    p50Ms: percentile(leaderboards.map((result) => result.durationMs), 0.50),
    p95Ms: percentile(leaderboards.map((result) => result.durationMs), 0.95),
  },
  projectionConvergence: {
    eventRevision,
    current: projectionsCurrent,
    competitions: projectionRows,
  },
};

const reportPath = path.resolve(process.env.LOAD_REPORT ?? 'phase4-capacity-report.json');
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (
  report.realtime.connected !== 120 ||
  !report.realtime.finalScoreRevisionObserved ||
  report.realtime.deliveredFinalRevision !== 120 ||
  report.realtime.projectionVisibilityP95Ms === null ||
  report.realtime.projectionVisibilityP95Ms > 3000 ||
  scoreSuccess.length !== scores.length ||
  report.scoreWrites.p95Ms === null ||
  report.scoreWrites.p95Ms > 2000 ||
  leaderboardSuccess.length !== 120 ||
  !report.projectionConvergence.current
) {
  throw new Error(`Capacity profile did not pass. Evidence written to ${reportPath}.`);
}
