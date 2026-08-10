import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';

import { downloadEventExport, invokePhase1 } from '../lib/phase1.ts';
import { getSupabaseClient } from '../lib/supabase.ts';

interface OperationsHealth {
  status: 'ok' | 'degraded' | 'unavailable';
  appVersion: string;
  edgeVersion: string;
  engineVersion: string;
  schemaVersion: number;
  authOk: boolean;
  dbOk: boolean;
  correlationId: string;
}

interface OperationsSnapshot {
  generatedAt: string;
  database: {
    usedBytes: number;
    limitBytes: number;
    usedFraction: number;
    warningLevel: 'healthy' | 'warning' | 'action' | 'critical';
    publishBlocked: boolean;
  };
  manualQuotas: Array<{ name: string; limit: string }>;
  events: Array<{
    id: string;
    name: string;
    status: string;
    starts_at: string;
    eventRevision: number;
    competitionCount: number;
    laggingCompetitions: number;
    maxProjectionLag: number;
  }>;
  recentErrors: Array<{
    errorCode: string;
    release: string | null;
    routeFamily: string | null;
    severity: 'warning' | 'error' | 'critical';
    occurrenceCount: number;
    lastSeenAt: string;
    correlationId: string | null;
  }>;
  backup: null | {
    status: string;
    startedAt: string;
    completedAt: string | null;
    artifactChecksum: string | null;
    artifactSizeBytes: number | null;
    lastTestedRestoreOn: string | null;
    workflowRunUrl: string | null;
  };
}

interface EventExportRow {
  id: string;
  name: string;
  status: string;
  starts_at: string;
}

export function AdminOperations() {
  const [exporting, setExporting] = useState<string | null>(null);
  const [repairing, setRepairing] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['operations'],
    refetchInterval: 30_000,
    queryFn: async () => {
      const supabase = getSupabaseClient();
      const [{ data: roles, error: rolesError }, health, snapshotResult] = await Promise.all([
        supabase.from('role_assignments').select('league_id,role').is('revoked_at', null).in('role', ['owner', 'league_admin']),
        invokePhase1<OperationsHealth>('health', {}),
        supabase.rpc('phase4_operations_snapshot'),
      ]);
      if (rolesError) throw rolesError;
      if (snapshotResult.error) throw snapshotResult.error;
      const leagueId = roles?.[0]?.league_id;
      if (!leagueId) throw new Error('Owner or league administrator access is required.');
      const { data: events, error: eventsError } = await supabase
        .from('events')
        .select('id,name,status,starts_at')
        .eq('league_id', leagueId)
        .order('starts_at', { ascending: false });
      if (eventsError) throw eventsError;
      return {
        leagueId,
        health,
        snapshot: snapshotResult.data as OperationsSnapshot,
        events: (events ?? []) as EventExportRow[],
      };
    },
  });

  const readiness = useMemo(() => {
    if (!query.data) return [];
    const { health, snapshot } = query.data;
    const backupAge = snapshot.backup?.completedAt
      ? Date.now() - new Date(snapshot.backup.completedAt).getTime()
      : Number.POSITIVE_INFINITY;
    const restoreAge = snapshot.backup?.lastTestedRestoreOn
      ? Date.now() - new Date(`${snapshot.backup.lastTestedRestoreOn}T00:00:00Z`).getTime()
      : Number.POSITIVE_INFINITY;
    const criticalErrors = snapshot.recentErrors.filter((item) =>
      item.severity === 'critical' && Date.now() - new Date(item.lastSeenAt).getTime() <= 86_400_000).length;
    const lagging = snapshot.events.reduce((sum, event) => sum + event.laggingCompetitions, 0);
    return [
      { label: 'Auth, database, and Edge Function respond', ready: health.status === 'ok' && health.authOk && health.dbOk, detail: health.status === 'ok' ? 'Current' : 'Degraded' },
      { label: 'Database remains below the 60% warning line', ready: snapshot.database.usedFraction < 0.6, detail: `${Math.round(snapshot.database.usedFraction * 100)}% used` },
      { label: 'Every event projection is current', ready: lagging === 0, detail: lagging === 0 ? 'Current' : `${lagging} lagging` },
      { label: 'Encrypted backup completed within 24 hours', ready: backupAge <= 86_400_000, detail: backupAge <= 86_400_000 ? 'Current' : 'Due' },
      { label: 'Restore drill completed within the quarter', ready: restoreAge <= 100 * 86_400_000, detail: restoreAge <= 100 * 86_400_000 ? 'Current' : 'Due' },
      { label: 'No critical client errors in the last 24 hours', ready: criticalErrors === 0, detail: criticalErrors === 0 ? 'Clear' : `${criticalErrors} critical` },
    ];
  }, [query.data]);

  async function download(eventId: string) {
    if (!query.data?.leagueId) return;
    setExporting(eventId);
    setError(null);
    setMessage(null);
    try {
      await downloadEventExport(query.data.leagueId, eventId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Export failed.');
    } finally {
      setExporting(null);
    }
  }

  async function rebuild(eventId: string, eventName: string) {
    setRepairing(eventId);
    setError(null);
    setMessage(null);
    try {
      const result = await invokePhase1<{ eventRevision: number; competitions: number }>(
        'rebuild-projections',
        { eventId },
      );
      setMessage(`${eventName} rebuilt at revision ${result.eventRevision} across ${result.competitions} competition${result.competitions === 1 ? '' : 's'}.`);
      await query.refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Projection rebuild failed.');
    } finally {
      setRepairing(null);
    }
  }

  if (query.isLoading) return <div className="screen"><div className="skeleton skeleton--rows" /></div>;
  if (!query.data) return <div className="screen"><p className="form-message form-message--error" role="alert">Operations could not load. Confirm operator access and service availability, then try again.</p></div>;

  const { health, snapshot, events } = query.data;
  const readyCount = readiness.filter((item) => item.ready).length;
  const laggingEvents = snapshot.events.filter((event) => event.laggingCompetitions > 0);
  const databasePercent = Math.round(snapshot.database.usedFraction * 100);

  return (
    <div className="screen operations-screen">
      <header className="page-header page-header--split">
        <div><Link className="back-link" to="/dashboard">Back to dashboard</Link><h1>Operations</h1><p>Launch readiness, cost guardrails, projection repair, and recovery evidence.</p></div>
        <button className="button button--quiet" type="button" disabled={query.isFetching} onClick={() => void query.refetch()}>{query.isFetching ? 'Refreshing…' : 'Refresh checks'}</button>
      </header>
      {error && <p className="form-message form-message--error" role="alert">{error}</p>}
      {message && <p className="form-message form-message--success" role="status">{message}</p>}

      <section className="operations-readiness" aria-labelledby="readiness-title">
        <div className="operations-readiness__heading"><div><h2 id="readiness-title">Season launch readiness</h2><p>Run these checks 24–48 hours before every event.</p></div><strong>{readyCount === readiness.length ? 'Ready' : `${readiness.length - readyCount} due`}</strong></div>
        <ul className="readiness-list">{readiness.map((item) => <li key={item.label}><span>{item.label}</span><b className={item.ready ? 'state-ready' : 'state-due'}>{item.detail}</b></li>)}</ul>
      </section>

      <div className="operations-grid">
        <section aria-labelledby="service-health-title">
          <div className="section-heading"><h2 id="service-health-title">Service health</h2><span className={health.status === 'ok' ? 'state-success' : 'state-warning'}>{health.status}</span></div>
          <dl className="fact-list"><dt>Authentication</dt><dd>{health.authOk ? 'Available' : 'Degraded'}</dd><dt>Database</dt><dd>{health.dbOk ? 'Available' : 'Degraded'}</dd><dt>App release</dt><dd>{health.appVersion}</dd><dt>Edge release</dt><dd>{health.edgeVersion}</dd><dt>Scoring engine</dt><dd>{health.engineVersion}</dd><dt>Schema</dt><dd>v{health.schemaVersion}</dd></dl>
        </section>

        <section aria-labelledby="capacity-title">
          <div className="section-heading"><h2 id="capacity-title">Database capacity</h2><span className={snapshot.database.warningLevel === 'healthy' ? 'state-success' : 'state-warning'}>{snapshot.database.warningLevel}</span></div>
          <div className="capacity-readout"><strong>{formatBytes(snapshot.database.usedBytes)}</strong><span>of {formatBytes(snapshot.database.limitBytes)} · {databasePercent}%</span></div>
          <progress aria-label="Database capacity used" value={snapshot.database.usedBytes} max={snapshot.database.limitBytes}>{databasePercent}%</progress>
          <p className="muted">Warnings begin at 60%, action at 75%, and critical at 90%. New publication stops at 95%; scoring and exports remain available.</p>
        </section>
      </div>

      <section className="section-block" aria-labelledby="projection-repair-title">
        <div className="section-heading"><div><h2 id="projection-repair-title">Projection repair</h2><p>Rebuilds replace derived results only. Frozen snapshots and raw scores remain unchanged.</p></div><span className={laggingEvents.length ? 'state-warning' : 'state-success'}>{laggingEvents.length ? `${laggingEvents.length} lagging` : 'All current'}</span></div>
        <div className="operations-ledger">{snapshot.events.length === 0 ? <p className="muted">No active event projections.</p> : snapshot.events.map((event) => {
          const canRebuild = event.status !== 'draft' && event.competitionCount > 0;
          return <article key={event.id}><div><strong>{event.name}</strong><span>{event.status.replaceAll('_', ' ')} · event r{event.eventRevision} · {event.competitionCount} competition{event.competitionCount === 1 ? '' : 's'}</span></div><div><b className={event.laggingCompetitions ? 'state-warning' : 'state-success'}>{event.laggingCompetitions ? `${event.maxProjectionLag} behind` : 'Current'}</b>{canRebuild && <button className="button button--quiet button--small" type="button" disabled={repairing !== null} onClick={() => void rebuild(event.id, event.name)}>{repairing === event.id ? 'Rebuilding…' : 'Rebuild'}</button>}</div></article>;
        })}</div>
      </section>

      <div className="operations-grid operations-grid--recovery">
        <section aria-labelledby="recovery-title">
          <div className="section-heading"><h2 id="recovery-title">Recovery evidence</h2><span>{snapshot.backup?.status ?? 'No run'}</span></div>
          <dl className="fact-list"><dt>Last encrypted backup</dt><dd>{snapshot.backup?.completedAt ? formatDateTime(snapshot.backup.completedAt) : 'Not recorded'}</dd><dt>Artifact size</dt><dd>{snapshot.backup?.artifactSizeBytes ? formatBytes(snapshot.backup.artifactSizeBytes) : '—'}</dd><dt>Restore drill</dt><dd>{snapshot.backup?.lastTestedRestoreOn ?? 'Due before launch'}</dd></dl>
          <p className="muted">RPO target: seven days normally and 24 hours around events. Prepared-operator RTO target: four hours.</p>
          {snapshot.backup?.workflowRunUrl && <a className="text-link" href={snapshot.backup.workflowRunUrl} target="_blank" rel="noreferrer">Open backup workflow run</a>}
        </section>

        <section aria-labelledby="quota-title">
          <div className="section-heading"><h2 id="quota-title">Manual quota review</h2><span>Vendor dashboard</span></div>
          <p className="muted">The free plan exposes no metrics API for these values. Check the vendor dashboard; the app never invents usage.</p>
          <dl className="quota-list">{snapshot.manualQuotas.map((quota) => <div key={quota.name}><dt>{quota.name}</dt><dd>{quota.limit}</dd></div>)}</dl>
        </section>
      </div>

      <section className="section-block" aria-labelledby="errors-title">
        <div className="section-heading"><div><h2 id="errors-title">Recent client errors</h2><p>Sanitized code, route family, release, and count only. Retained for 30 days.</p></div><span>{snapshot.recentErrors.length}</span></div>
        <div className="error-ledger">{snapshot.recentErrors.length === 0 ? <p className="muted">No client errors recorded in the last 30 days.</p> : snapshot.recentErrors.map((item) => <article key={`${item.errorCode}-${item.routeFamily}-${item.lastSeenAt}`}><div><code>{item.errorCode}</code><span>{item.routeFamily ?? 'Unknown route'} · release {item.release ?? 'unknown'}</span></div><div><b className={`state-${item.severity === 'warning' ? 'warning' : 'error'}`}>{item.severity}</b><strong>{item.occurrenceCount}×</strong><time dateTime={item.lastSeenAt}>{formatDateTime(item.lastSeenAt)}</time></div></article>)}</div>
      </section>

      <section className="section-block" aria-labelledby="exports-title">
        <div className="section-heading"><div><h2 id="exports-title">Portable event exports</h2><p>Frozen snapshots, raw score facts, projections, and final hashes; account identities excluded.</p></div><span>{events.length}</span></div>
        <div className="export-list">{events.map((event) => <div key={event.id}><div><strong>{event.name}</strong><span>{event.status.replaceAll('_', ' ')} · {formatDate(event.starts_at)}</span></div><button className="button button--quiet" type="button" disabled={exporting !== null} onClick={() => void download(event.id)}>{exporting === event.id ? 'Preparing…' : 'Download JSON'}</button></div>)}</div>
        <p><Link to="/privacy">Review data handling</Link> · Backup, restore, and incident procedures live in the repository runbooks.</p>
      </section>
    </div>
  );
}

function formatBytes(value: number) {
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KiB`;
  return `${(value / (1024 * 1024)).toFixed(value >= 100 * 1024 * 1024 ? 0 : 1)} MiB`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value));
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
