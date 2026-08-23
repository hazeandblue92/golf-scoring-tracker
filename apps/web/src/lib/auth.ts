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

export interface SignInOptions {
  /**
   * May only be set after the UI names the retained unsynced count and the
   * user explicitly confirms that switching accounts may discard it.
   */
  discardPreviousUnsynced?: boolean;
}

export const LOCAL_DATA_OWNER_KEY = 'gtt.localDataOwnerUserId';
const LEGACY_UNATTRIBUTED_OWNER = 'legacy-unattributed-local-data';

export type AccountSwitchDecision = 'reuse' | 'adopt' | 'clear' | 'block';

/** Pure ownership policy for the account-switch confirmation path. */
export function accountSwitchDecision(
  currentOwnerUserId: string | null,
  nextUserId: string,
  retainedUnsyncedCount: number,
  discardPreviousUnsynced: boolean,
): AccountSwitchDecision {
  if (currentOwnerUserId === nextUserId) return 'reuse';
  if (currentOwnerUserId === null) return 'adopt';
  if (retainedUnsyncedCount > 0 && !discardPreviousUnsynced) return 'block';
  return 'clear';
}

export class AccountSwitchBlockedError extends Error {
  readonly unsyncedCount: number;

  constructor(retainedUnsyncedCount: number) {
    super(`${retainedUnsyncedCount} unsynced score${retainedUnsyncedCount === 1 ? '' : 's'} belong to another account.`);
    this.name = 'AccountSwitchBlockedError';
    this.unsyncedCount = retainedUnsyncedCount;
  }
}

function readLocalDataOwner(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(LOCAL_DATA_OWNER_KEY);
}

function writeLocalDataOwner(userId: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(LOCAL_DATA_OWNER_KEY, userId);
}

function clearLocalDataOwner(expectedUserId?: string): void {
  if (typeof window === 'undefined') return;
  if (expectedUserId !== undefined && readLocalDataOwner() !== expectedUserId) return;
  window.localStorage.removeItem(LOCAL_DATA_OWNER_KEY);
}

async function resolveLocalDataOwner(): Promise<string | null> {
  const storedOwner = readLocalDataOwner();
  if (storedOwner !== null) return storedOwner;

  // Upgrade path for data created before the explicit owner marker existed.
  // Snapshot/preferences rows carry user ids, so recover a single owner when
  // possible. Unattributed outbox/draft data is locked behind confirmation.
  const [snapshots, preferences, genericRowCounts] = await Promise.all([
    db.eventSnapshots.toArray(),
    db.preferences.toArray(),
    Promise.all([
      db.scoreDrafts.count(),
      db.outbox.count(),
      db.receipts.count(),
    ]),
  ]);
  const candidateOwners = new Set([
    ...snapshots.map((row) => row.userId),
    ...preferences.map((row) => row.userId),
  ]);
  const recoveredOwner = candidateOwners.size === 1
    ? [...candidateOwners][0] ?? null
    : candidateOwners.size > 1 || genericRowCounts.some((count) => count > 0)
      ? LEGACY_UNATTRIBUTED_OWNER
      : null;
  if (recoveredOwner !== null) writeLocalDataOwner(recoveredOwner);
  return recoveredOwner;
}

/** Clear every browser store whose rows are authorized by one local session. */
export async function clearOfflineData(): Promise<void> {
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
      await db.preferences.clear();
    },
  );
}

let automaticCleanupInFlight: Promise<void> = Promise.resolve();

/**
 * Prepare unscoped IndexedDB stores for a session before Supabase adopts it.
 * A different account can never observe retained rows without an explicit
 * discard confirmation.
 */
export async function prepareLocalDataForAccount(
  nextUserId: string,
  options?: SignInOptions,
): Promise<void> {
  await automaticCleanupInFlight.catch(() => undefined);
  const currentOwnerUserId = await resolveLocalDataOwner();
  const counts = currentOwnerUserId !== null && currentOwnerUserId !== nextUserId
    ? await outboxCounts()
    : null;
  const retainedUnsyncedCount = counts === null ? 0 : unsyncedCount(counts);
  const decision = accountSwitchDecision(
    currentOwnerUserId,
    nextUserId,
    retainedUnsyncedCount,
    options?.discardPreviousUnsynced === true,
  );
  if (decision === 'block') {
    throw new AccountSwitchBlockedError(retainedUnsyncedCount);
  }
  if (decision === 'clear') {
    await clearOfflineData();
  }
  writeLocalDataOwner(nextUserId);
}

/** Mark an already-vetted session without overwriting another account. */
export function noteLocalDataOwner(userId: string): void {
  const currentOwnerUserId = readLocalDataOwner();
  if (currentOwnerUserId === null || currentOwnerUserId === userId) {
    writeLocalDataOwner(userId);
  }
}

/**
 * Supabase may end a disabled/expired session without the Settings button.
 * Clear automatically when there is no unsynced work; otherwise retain the
 * old account marker so a future account must explicitly discard it.
 */
export function handleAutomaticSignOut(userId?: string): Promise<void> {
  const cleanup = automaticCleanupInFlight.catch(() => undefined).then(async () => {
    const currentOwnerUserId = await resolveLocalDataOwner();
    if (currentOwnerUserId === null) return;
    if (userId !== undefined && currentOwnerUserId !== userId) return;
    const counts = await outboxCounts();
    if (unsyncedCount(counts) > 0) return;
    await clearOfflineData();
    clearLocalDataOwner(currentOwnerUserId);
  });
  automaticCleanupInFlight = cleanup;
  return cleanup;
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
  options?: SignInOptions,
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

  const nextUserId = jwtSubject(accessToken);
  if (nextUserId === null) {
    throw new SignInError('unavailable');
  }
  await prepareLocalDataForAccount(nextUserId, options);

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
 * (§14.1). The server updates the password before clearing the activation
 * flag; the call is idempotent, so retrying after a partial failure is safe.
 */
export async function completeActivation(
  newPassword: string,
  privacyAccepted: boolean,
): Promise<void> {
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
      body: JSON.stringify({ newPassword, privacyAccepted }),
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
  await clearOfflineData();
  clearLocalDataOwner(userId);

  return { status: 'signed-out' };
}

function jwtSubject(accessToken: string): string | null {
  const encodedPayload = accessToken.split('.')[1];
  if (encodedPayload === undefined) return null;
  const base64 = encodedPayload.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  try {
    const payload = JSON.parse(atob(padded)) as { sub?: unknown };
    return typeof payload.sub === 'string' && payload.sub !== ''
      ? payload.sub
      : null;
  } catch {
    return null;
  }
}
