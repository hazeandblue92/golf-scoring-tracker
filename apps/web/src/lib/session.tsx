/**
 * Session context (spec §14.2) and route guards.
 *
 * - RequireAuth redirects signed-out visitors to /sign-in.
 * - RequireActivation forces /activate while must_change_password is true,
 *   so no score mutation is reachable before the password change
 *   (FR-AUTH-003); the server enforces the same rule independently.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import type { Session } from '@supabase/supabase-js';

import {
  handleAutomaticSignOut,
  noteLocalDataOwner,
  prepareLocalDataForAccount,
} from './auth.ts';
import { db } from './offline/db.ts';
import { startOutboxScheduler } from './offline/outbox.ts';
import { getSupabaseClient } from './supabase.ts';
import { browserIsOffline } from './useOnlineStatus.ts';

export interface SessionProfile {
  mustChangePassword: boolean;
  displayName: string;
}

export interface SessionContextValue {
  session: Session | null;
  /** Null while signed out or while the profile row is still loading. */
  profile: SessionProfile | null;
  /** True until the initial session AND profile lookup have settled. */
  loading: boolean;
  /** Re-read the profile row (e.g. after complete-activation succeeds). */
  refreshProfile: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);
const PROFILE_CACHE_KEY = 'session-profile-v1';

async function readProfileRow(userId: string) {
  return getSupabaseClient()
    .from('profiles')
    .select('must_change_password, display_name')
    .eq('id', userId)
    .single();
}

async function readCachedProfile(userId: string): Promise<SessionProfile | null> {
  const cached = await db.preferences.get([userId, PROFILE_CACHE_KEY]);
  if (!isSessionProfile(cached?.value)) return null;
  return cached.value;
}

/**
 * A profile lookup must never strand the app on its loading screen.
 *
 * `browserIsOffline()` is a heuristic over `navigator.onLine` plus a handoff
 * marker, and it can be wrong: after an offline reload the browser may still
 * report onLine while every request fails, in which case this function used
 * to issue a network read that never settled. `profileLoading` then stayed
 * true forever and RequireActivation held the player on "Loading your
 * profile…" instead of their scorecard — the exact reload-on-the-course case
 * offline support exists for. Bound the wait and fall back to the cached
 * profile, which is what the offline branch would have returned anyway.
 */
const PROFILE_FETCH_TIMEOUT_MS = 2_500;

async function fetchProfile(userId: string): Promise<SessionProfile | null> {
  const cached = await readCachedProfile(userId);
  if (browserIsOffline()) return cached;

  let response: Awaited<ReturnType<typeof readProfileRow>> | null = null;
  try {
    response = await Promise.race([
      readProfileRow(userId),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), PROFILE_FETCH_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // Transport failure, not a rejected row: the cached profile still holds.
    return cached;
  }
  if (response === null) return cached;
  const { data, error } = response;
  if (error !== null || data === null) {
    return cached;
  }
  const row = data as { must_change_password: boolean; display_name: string };
  const profile = {
    mustChangePassword: row.must_change_password,
    displayName: row.display_name,
  } satisfies SessionProfile;
  await db.preferences.put({ userId, key: PROFILE_CACHE_KEY, value: profile });
  return profile;
}

function isSessionProfile(value: unknown): value is SessionProfile {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SessionProfile>;
  return typeof candidate.mustChangePassword === 'boolean'
    && typeof candidate.displayName === 'string';
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<SessionProfile | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);
  const previousUserIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const supabase = getSupabaseClient();
    let cancelled = false;
    let sessionUpdate = 0;

    const applySession = (nextSession: Session | null): void => {
      const update = ++sessionUpdate;
      const previousUserId = previousUserIdRef.current;
      const nextUserId = nextSession?.user.id;
      previousUserIdRef.current = nextUserId;

      if (nextSession === null || nextUserId === undefined) {
        if (!cancelled) {
          setSession(null);
          setSessionLoading(false);
        }
        void handleAutomaticSignOut(previousUserId).catch(() => {
          // Cleanup is retried on the next signed-out app start. Never erase
          // retained unsynced rows merely because IndexedDB was unavailable.
        });
        return;
      }

      void prepareLocalDataForAccount(nextUserId).then(() => {
        if (cancelled || update !== sessionUpdate) return;
        noteLocalDataOwner(nextUserId);
        setSession(nextSession);
        setSessionLoading(false);
      }).catch(() => {
        // A persisted session for a different local-data owner must not expose
        // that owner's unscoped offline rows. End it and retain those rows.
        if (!cancelled && update === sessionUpdate) {
          setSession(null);
          setSessionLoading(false);
          void supabase.auth.signOut();
        }
      });
    };

    void supabase.auth.getSession().then(({ data }) => {
      if (!cancelled) applySession(data.session);
    });

    // Per supabase-js guidance, do not await Supabase calls inside the
    // callback. Ownership reconciliation runs outside its stack; the profile
    // fetch remains in the effect below, keyed on the accepted user id.
    const { data: subscription } = supabase.auth.onAuthStateChange(
      (_event, nextSession) => {
        applySession(nextSession);
      },
    );

    return () => {
      cancelled = true;
      subscription.subscription.unsubscribe();
    };
  }, []);

  const userId = session?.user.id;

  useEffect(() => {
    if (userId === undefined) {
      setProfile(null);
      setProfileLoading(false);
      return;
    }
    let cancelled = false;
    setProfileLoading(true);
    void fetchProfile(userId).then((next) => {
      if (!cancelled) {
        setProfile(next);
        setProfileLoading(false);
      }
    }).catch(() => {
      // fetchProfile already falls back to cache; this only guarantees the
      // loading flag clears, so no failure can leave the app on a spinner.
      if (!cancelled) setProfileLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // Outbox scheduler runs while signed in: online/visibility/15s triggers
  // (§10.3). Stopped on sign-out or unmount.
  useEffect(() => {
    if (userId === undefined) {
      return;
    }
    return startOutboxScheduler();
  }, [userId]);

  const refreshProfile = useCallback(async () => {
    if (userId === undefined) {
      return;
    }
    setProfile(await fetchProfile(userId));
  }, [userId]);

  const value: SessionContextValue = {
    session,
    profile,
    loading: sessionLoading || profileLoading,
    refreshProfile,
  };

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) {
    throw new Error('useSession must be used inside <SessionProvider>');
  }
  return value;
}

/**
 * Layout route: renders children only with a signed-in session; otherwise
 * redirects to /sign-in. While the initial session check runs it renders a
 * status paragraph rather than flashing a redirect.
 */
export function RequireAuth() {
  const { session, loading } = useSession();
  const location = useLocation();

  if (session === null && loading) {
    return <p role="status">Checking your session…</p>;
  }
  if (session === null) {
    return <Navigate to="/sign-in" replace state={{ from: location.pathname }} />;
  }
  return <Outlet />;
}

/**
 * Layout route inside RequireAuth: while the profile still has
 * must_change_password set, every route funnels to /activate
 * (FR-AUTH-003). Waits for the profile row before rendering so a
 * temporary-password session can never reach score entry first.
 */
export function RequireActivation() {
  const { profile, loading } = useSession();

  if (profile === null && loading) {
    return <p role="status">Loading your profile…</p>;
  }
  if (profile !== null && profile.mustChangePassword) {
    return <Navigate to="/activate" replace />;
  }
  return <Outlet />;
}
