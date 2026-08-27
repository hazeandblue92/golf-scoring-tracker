import { useEffect, useState } from 'react';

export const OFFLINE_SESSION_KEY = 'gtt.networkOffline';
export const OFFLINE_MARKER_MAX_AGE_MS = 5_000;

/** Pure reconciliation rule for offline-reload markers. */
export function offlineMarkerIsActive(
  marker: string | null,
  navigatorOnline: boolean,
  now: number,
): boolean {
  if (!navigatorOnline) return true;
  if (marker === null) return false;
  const markedAt = Number(marker);
  const age = now - markedAt;
  return Number.isFinite(markedAt)
    && age >= 0
    && age < OFFLINE_MARKER_MAX_AGE_MS;
}

/** Refresh the handoff marker only when the departing document is offline. */
export function refreshOfflineMarkerOnPageExit(
  navigatorOnline: boolean,
  storage: Pick<Storage, 'setItem'>,
  now: number,
): void {
  if (navigatorOnline) return;
  storage.setItem(OFFLINE_SESSION_KEY, String(now));
}

/**
 * Record first-hand evidence that the network is unusable.
 *
 * `navigator.onLine` only reports whether an interface exists, not whether it
 * carries anything: a phone on a captive portal or parked under a dead cell
 * tower reports true while every request stalls. A component that has just
 * watched a request time out knows better than the browser does, and this
 * lets it say so once, for the whole app, rather than each screen drawing its
 * own conclusion.
 */
export function noteNetworkUnreachable(now = Date.now()): void {
  window.sessionStorage.setItem(OFFLINE_SESSION_KEY, String(now));
  window.dispatchEvent(new Event('offline'));
}

/**
 * `navigator.onLine` can briefly report true during an offline document
 * reload. Preserve the browser's explicit offline event for this tab so the
 * new document can choose IndexedDB before attempting a network request.
 */
export function browserIsOffline(now = Date.now()): boolean {
  return offlineMarkerIsActive(
    window.sessionStorage.getItem(OFFLINE_SESSION_KEY),
    navigator.onLine,
    now,
  );
}

export function useOnlineStatus() {
  const [online, setOnline] = useState(() => !browserIsOffline());

  useEffect(() => {
    let expiryTimer: number | undefined;
    const clearExpiryTimer = () => {
      if (expiryTimer !== undefined) window.clearTimeout(expiryTimer);
      expiryTimer = undefined;
    };
    const markOnline = () => {
      clearExpiryTimer();
      window.sessionStorage.removeItem(OFFLINE_SESSION_KEY);
      setOnline(true);
    };
    const markOffline = () => {
      clearExpiryTimer();
      window.sessionStorage.setItem(OFFLINE_SESSION_KEY, String(Date.now()));
      setOnline(false);
    };
    const reconcile = () => {
      if (!navigator.onLine) {
        markOffline();
        return;
      }
      const marker = window.sessionStorage.getItem(OFFLINE_SESSION_KEY);
      if (!offlineMarkerIsActive(marker, true, Date.now())) {
        markOnline();
        return;
      }
      setOnline(false);
      const markedAt = Number(marker);
      const remaining = Math.max(0, OFFLINE_MARKER_MAX_AGE_MS - (Date.now() - markedAt));
      expiryTimer = window.setTimeout(() => {
        // Multiple hook instances may reconcile the same marker. Only the
        // first timer still owning it emits the recovery event.
        if (navigator.onLine
          && window.sessionStorage.getItem(OFFLINE_SESSION_KEY) === marker) {
          window.sessionStorage.removeItem(OFFLINE_SESSION_KEY);
          setOnline(true);
          window.dispatchEvent(new Event('online'));
        }
      }, remaining + 1);
    };
    const refreshOfflineMarker = () => {
      refreshOfflineMarkerOnPageExit(
        navigator.onLine,
        window.sessionStorage,
        Date.now(),
      );
    };

    window.addEventListener('online', markOnline);
    window.addEventListener('offline', markOffline);
    window.addEventListener('pagehide', refreshOfflineMarker);
    reconcile();
    return () => {
      clearExpiryTimer();
      window.removeEventListener('online', markOnline);
      window.removeEventListener('offline', markOffline);
      window.removeEventListener('pagehide', refreshOfflineMarker);
    };
  }, []);

  return online;
}
