/**
 * Auth flows (spec §3.1, §14.1, §14.2) against the Edge Functions
 * username-login and complete-activation. The browser never sees the
 * internal auth email identifier; it exchanges username+password for a
 * Supabase session server-side.
 */

import { db } from './offline/db.ts';
import { outboxCounts, unsyncedCount } from './offline/outbox.ts';
import { functionUrl, getSupabaseClient, getSupabaseEnv } from './supabase.ts';

/**
 * The ONE nondisclosing error for unknown username or wrong password
 * (§14.1). Shown verbatim; never reveals which part failed.
 */
export const SIGN_IN_FAILED_MESSAGE = 'Incorrect username or password.';

/** Presentational message when the sign-in service cannot be reached. */
export const SIGN_IN_UNAVAILABLE_MESSAGE =
  'Sign-in is unavailable right now. Check your connection and try again.';

export type SignInErrorKind = 'credentials' | 'unavailable';

export class SignInError extends Error {
  readonly kind: SignInErrorKind;

  constructor(kind: SignInErrorKind) {
    super(
      kind === 'credentials'
        ? SIGN_IN_FAILED_MESSAGE
        : SIGN_IN_UNAVAILABLE_MESSAGE,
    );
    this.name = 'SignInError';
    this.kind = kind;
  }
}

export interface SignInResult {
  mustChangePassword: boolean;
  displayName: string;
}

interface UsernameLoginPayload {
  access_token?: string;
  refresh_token?: string;
  session?: { access_token?: string; refresh_token?: string };
  must_change_password?: boolean;
  mustChangePassword?: boolean;
  display_name?: string;
  displayName?: string;
}

/**
 * POST username-login (§12.2, §14.1), then adopt the returned session on
 * this device via supabase.auth.setSession so refresh tokens persist only
 * here (§14.2).
 */
export async function signInWithUsername(
  username: string,
  password: string,
): Promise<SignInResult> {
  const { publishableKey } = getSupabaseEnv();
  let response: Response;
  try {
    response = await fetch(functionUrl('username-login'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: publishableKey,
      },
      body: JSON.stringify({ username, password }),
    });
  } catch {
    throw new SignInError('unavailable');
  }
  if (response.status >= 500) {
    throw new SignInError('unavailable');
  }
  if (!response.ok) {
    // 4xx: unknown username or wrong password — ONE nondisclosing error
    // regardless of which (§14.1). Rate limiting also lands here rather
    // than disclosing account existence.
    throw new SignInError('credentials');
  }

  let payload: UsernameLoginPayload;
  try {
    payload = (await response.json()) as UsernameLoginPayload;
  } catch {
    throw new SignInError('unavailable');
  }
  const accessToken = payload.session?.access_token ?? payload.access_token;
  const refreshToken = payload.session?.refresh_token ?? payload.refresh_token;
  if (accessToken === undefined || refreshToken === undefined) {
    throw new SignInError('unavailable');
  }

  const supabase = getSupabaseClient();
  const { error } = await supabase.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });
  if (error !== null) {
    throw new SignInError('unavailable');
  }

  return {
    mustChangePassword:
      payload.must_change_password ?? payload.mustChangePassword ?? false,
    displayName: payload.display_name ?? payload.displayName ?? username,
  };
}

/**
 * POST complete-activation with the current (temporary) session token
 * (§14.1). The server updates the password and clears must_change_password
 * atomically; the call is idempotent, so retrying after a partial failure
 * is safe.
 */
export async function completeActivation(newPassword: string): Promise<void> {
  const supabase = getSupabaseClient();
  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  if (accessToken === undefined) {
    throw new Error('You must be signed in to activate your account.');
  }
  const { publishableKey } = getSupabaseEnv();
  let response: Response;
  try {
    response = await fetch(functionUrl('complete-activation'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        apikey: publishableKey,
      },
      body: JSON.stringify({ newPassword }),
    });
  } catch {
    throw new Error(
      'Activation is unavailable right now. Check your connection and try again.',
    );
  }
  if (!response.ok) {
    throw new Error(
      'Could not complete activation. Review the passphrase requirements and try again.',
    );
  }
}

export type SignOutResult =
  | { status: 'signed-out' }
  | { status: 'blocked'; unsyncedCount: number };

export interface SignOutOptions {
  /**
   * Callers MUST first receive a 'blocked' result and obtain the user's
   * explicit confirmation (naming the unsynced count) before passing true
   * (§10.3, §14.2: never silently clear an unsynced outbox).
   */
  discardUnsynced?: boolean;
}

/**
 * Sign out per §14.2: warn about any unsynced outbox first; on a confirmed
 * sign-out, end the Supabase session and clear IndexedDB league data for
 * this device (§10.1).
 */
export async function signOut(
  options?: SignOutOptions,
): Promise<SignOutResult> {
  const counts = await outboxCounts();
  const unsynced = unsyncedCount(counts);
  if (unsynced > 0 && options?.discardUnsynced !== true) {
    return { status: 'blocked', unsyncedCount: unsynced };
  }

  const supabase = getSupabaseClient();
  const { data } = await supabase.auth.getSession();
  const userId = data.session?.user.id;

  await supabase.auth.signOut();

  // Clear league data on sign-out (§10.1, §14.2). League-scoped stores are
  // cleared wholesale; preferences only for the signing-out user.
  await db.transaction(
    'rw',
    db.eventSnapshots,
    db.scoreDrafts,
    db.outbox,
    db.receipts,
    db.preferences,
    async () => {
      await db.eventSnapshots.clear();
      await db.scoreDrafts.clear();
      await db.outbox.clear();
      await db.receipts.clear();
      if (userId !== undefined) {
        await db.preferences.where('userId').equals(userId).delete();
      }
    },
  );

  return { status: 'signed-out' };
}
