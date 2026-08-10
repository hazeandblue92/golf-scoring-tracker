import { useCallback, useEffect, useState } from 'react';

import {
  EMPTY_OUTBOX_COUNTS,
  outboxCounts,
  syncOutbox,
  type OutboxCounts,
} from './offline/outbox.ts';

export function useOutboxStatus(eventId?: string) {
  const [counts, setCounts] = useState<OutboxCounts>(EMPTY_OUTBOX_COUNTS);
  const [syncing, setSyncing] = useState(false);

  const refresh = useCallback(async () => {
    setCounts(await outboxCounts(eventId));
  }, [eventId]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const sync = useCallback(async () => {
    setSyncing(true);
    try {
      await syncOutbox();
      await refresh();
    } finally {
      setSyncing(false);
    }
  }, [refresh]);

  return { counts, syncing, refresh, sync };
}
