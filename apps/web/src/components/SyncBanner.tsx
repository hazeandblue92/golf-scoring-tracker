import { unsyncedCount } from '../lib/offline/outbox.ts';
import { useOnlineStatus } from '../lib/useOnlineStatus.ts';
import { useOutboxStatus } from '../lib/useOutboxStatus.ts';
import { AppIcon } from './AppIcon.tsx';

export function SyncBanner({ eventId }: { eventId?: string }) {
  const { counts, syncing, sync } = useOutboxStatus(eventId);
  const online = useOnlineStatus();
  const unsynced = unsyncedCount(counts);
  const attention = counts.conflict + counts.rejected;

  if (online && unsynced === 0) return null;
  return (
    <aside className={attention > 0 ? 'sync-banner sync-banner--error' : 'sync-banner'} aria-live="polite">
      <AppIcon name="sync" />
      <div>
        <strong>{unsynced > 0 ? `${unsynced} score${unsynced === 1 ? '' : 's'} not synced` : 'Offline · showing saved event data'}</strong>
        <span>{attention > 0 ? `${attention} need review` : online ? 'Saved on this device' : unsynced > 0 ? 'Will send when online' : 'Reconnect to refresh server results'}</span>
      </div>
      {unsynced > 0 && <button className="button button--small button--quiet" type="button" onClick={() => void sync()} disabled={syncing || !online}>
        {syncing ? 'Syncing…' : 'Try now'}
      </button>}
    </aside>
  );
}
