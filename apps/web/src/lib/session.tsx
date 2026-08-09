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
  useState,
  type ReactNode,
} from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import type { Session } from '@supabase/supabase-js';

import { startOutboxScheduler } from './offline/outbox.ts';
import { getSupabaseClient } from './supabase.ts';

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

async function fetchProfile(userId: string): Promise<SessionProfile | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('profiles')
    .select('must_change_password, display_name')
    .eq('id', userId)
    .single();
  if (error !== null || data === null) {
    return null;
  }
  const row = data as { must_change_password: boolean; display_name: string };
  return {
    mustChangePassword: row.must_change_password,
    displayName: row.display_name,
  };
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<SessionProfile | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);

  useEffect(() => {
    const supabase = getSupabaseClient();
    let cancelled = false;

    void supabase.auth.getSession().then(({ data }) => {
      if (!cancelled) {
        setSession(data.session);
        setSessionLoading(false);
      }
    });

    // Per supabase-js guidance, do not await Supabase calls inside the
    // callback; only update state here. The profile fetch runs in the
    // effect below, keyed on the user id.
    const { data: subscription } = supabase.auth.onAuthStateChange(
      (_event, nextSession) => {
        setSession(nextSession);
        setSessionLoading(false);
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
