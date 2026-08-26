import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';

import { db } from '../lib/offline/db.ts';
import { outboxCounts, syncOutbox, unsyncedCount } from '../lib/offline/outbox.ts';

/**
 * The cached snapshot payload carries the event it was taken from, so a
 * cached row can be shown by name and opened directly. Listing bare UUIDs
 * made the one screen that proves offline data exists unusable for reaching
 * it — the user had to type a URL from memory.
 */
function snapshotEvent(payload: unknown): { id: string; name: string } | null {
  const event = (payload as { event?: { id?: unknown; name?: unknown } } | null)?.event;
  return typeof event?.id === 'string' && typeof event.name === 'string'
    ? { id: event.id, name: event.name }
    : null;
}

export function Offline() {
  const query = useQuery({ queryKey: ['offline-state'], refetchInterval: 2_000, queryFn: async () => { const [snapshots, counts, rows] = await Promise.all([db.eventSnapshots.toArray(), outboxCounts(), db.outbox.toArray()]); return { snapshots, counts, rows }; } });
  const counts = query.data?.counts;
  const unsynced = counts ? unsyncedCount(counts) : 0;
  return <div className="screen narrow-screen"><header className="page-header"><h1>Offline and sync</h1><p>Score entry works through interruptions because every submitted hole is written to this device first.</p></header><section className="offline-state"><div className={navigator.onLine ? 'connection-state state-success' : 'connection-state state-warning'}><strong>{navigator.onLine ? 'Online' : 'Offline'}</strong><span>{navigator.onLine ? 'Server sync is available' : 'Scores will remain on this device'}</span></div><dl className="fact-list"><dt>Waiting to sync</dt><dd>{unsynced}</dd><dt>Queued</dt><dd>{counts?.queued ?? 0}</dd><dt>Conflicts</dt><dd>{counts?.conflict ?? 0}</dd><dt>Rejected</dt><dd>{counts?.rejected ?? 0}</dd></dl><button className="button button--primary" type="button" disabled={!navigator.onLine || unsynced === 0} onClick={async () => { await syncOutbox(); await query.refetch(); }}>Sync now</button></section><section className="section-block"><div className="section-heading"><h2>Available event data</h2><span>{query.data?.snapshots.length ?? 0}</span></div>{query.data?.snapshots.length ? query.data.snapshots.map((snapshot) => { const event = snapshotEvent(snapshot.payload); return <div className="snapshot-row" key={`${snapshot.userId}:${snapshot.eventId}`}><div><strong>{event?.name ?? snapshot.eventId}</strong><span>Saved {new Date(snapshot.cachedAt).toLocaleString()}</span></div><Link className="button button--quiet" to={`/events/${snapshot.eventId}/score`}>Open scoring</Link></div>; }) : <p className="empty-inline">Open a published event while online to make its permitted snapshot available here.</p>}</section><p className="muted">Signing out clears league data from this device. The app always names the exact unsynced count before allowing that action.</p></div>;
}
