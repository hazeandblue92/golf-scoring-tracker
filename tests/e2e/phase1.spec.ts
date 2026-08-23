import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

import {
  buildScoringFixture,
  createAccount,
  LEAGUE_ID,
  scoreRequest,
  totpCode,
  type ScoringFixture,
  type TestAccount,
} from '../integration/helpers/fixture.ts';
import { callFunction, serviceClient } from '../integration/helpers/stack.ts';

let organizer: Awaited<ReturnType<typeof createAccount>>;
const PHASE_2_PLAYERS = ['Dev Player One', 'Dev Player Two', 'Dev Player Three', 'Dev Player Four'];
const PHASE_3_PLAYERS = [
  ...PHASE_2_PLAYERS,
  'Dev Player Five',
  'Dev Player Six',
  'Dev Player Seven',
  'Dev Player Eight',
];
const MATCH_RULES = {
  format: 'match',
  schemaVersion: 1,
  metric: 'gross',
  holeScope: Array.from({ length: 18 }, (_, index) => index + 1),
  handicap: {
    profile: 'none',
    allowance: 1,
    rounding: 'half_up_toward_positive_infinity',
    matchNormalizeFromLowest: false,
    allocation: 'stroke_index',
  },
  ties: { mode: 'tied', sequence: [] },
  incomplete: { live: 'provisional', final: 'no_return' },
  visibility: 'league',
} as const;

test.describe.configure({ mode: 'serial' });

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
}

async function expectNarrowReflow(page: Page) {
  await page.setViewportSize({ width: 320, height: 720 });
  const overflow = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const scrollingElement = document.scrollingElement;
    if (scrollingElement) scrollingElement.scrollLeft = 10_000;
    const rootScrollLeft = scrollingElement?.scrollLeft ?? 0;
    if (scrollingElement) scrollingElement.scrollLeft = 0;
    return {
      viewportWidth,
      scrollWidth: document.documentElement.scrollWidth,
      rootScrollLeft,
      offenders: [...document.querySelectorAll('body *')]
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            tag: element.tagName.toLowerCase(),
            className: element.className,
            text: element.textContent?.trim().slice(0, 80),
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            insideScrollRegion: element.closest('.handicap-review-table, .competition-switcher') !== null,
          };
        })
        .filter((element) => !element.insideScrollRegion && (element.left < 0 || element.right > viewportWidth + 1))
        .slice(0, 10),
    };
  });
  expect(overflow.rootScrollLeft, JSON.stringify(overflow)).toBe(0);
  expect(overflow.offenders, JSON.stringify(overflow)).toEqual([]);
}

async function uncheckAll(checkboxes: Locator) {
  await checkboxes.evaluateAll((elements) => {
    for (const element of elements) {
      if (element instanceof HTMLInputElement && element.checked) element.click();
    }
  });
  await expect.poll(() => checkboxes.evaluateAll((elements) =>
    elements.filter((element) => element instanceof HTMLInputElement && element.checked).length,
  )).toBe(0);
}

async function readOutbox(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gtt-offline');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<Array<{
        idempotencyKey: string;
        state: string;
        mutation: { target?: { holeId?: string } };
      }>>((resolve, reject) => {
        const transaction = database.transaction('outbox', 'readonly');
        const request = transaction.objectStore('outbox').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  });
}

async function readEventSnapshots(page: Page, eventId: string) {
  return page.evaluate(async (targetEventId) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gtt-offline');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<Array<{
        eventId: string;
        snapshotRevision: number;
        userId: string;
        payload: unknown;
      }>>((resolve, reject) => {
        const transaction = database.transaction('eventSnapshots', 'readonly');
        const request = transaction.objectStore('eventSnapshots').getAll();
        request.onsuccess = () => resolve(request.result.filter((row) => row.eventId === targetEventId));
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  }, eventId);
}

async function preferenceCount(page: Page, userId: string) {
  return page.evaluate(async (targetUserId) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gtt-offline');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<number>((resolve, reject) => {
        const transaction = database.transaction('preferences', 'readonly');
        const request = transaction.objectStore('preferences')
          .index('userId')
          .count(IDBKeyRange.only(targetUserId));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  }, userId);
}

async function setOutboxNextAttemptAt(
  page: Page,
  idempotencyKey: string,
  nextAttemptAt: number,
) {
  await page.evaluate(async ({ key, next }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gtt-offline');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('outbox', 'readwrite');
        const store = transaction.objectStore('outbox');
        const request = store.get(key);
        request.onsuccess = () => {
          const row = request.result as Record<string, unknown> | undefined;
          if (row === undefined) {
            reject(new Error(`Missing outbox row ${key}`));
            return;
          }
          store.put({ ...row, nextAttemptAt: next });
        };
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  }, { key: idempotencyKey, next: nextAttemptAt });
}

async function signInOrganizer(page: Page, account: TestAccount = organizer) {
  await page.goto('/sign-in');
  await page.getByLabel('Username').fill(account.username);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });

  const secret = account.totpSecret;
  if (!secret) throw new Error('E2E organizer is missing its TOTP fixture secret');
  await page.goto('/settings');
  const security = page.getByRole('region', { name: 'Account security' });
  const code = security.getByLabel('Six-digit authenticator code');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await code.fill(totpCode(secret));
    await security.getByRole('button', { name: 'Verify this session' }).click();
    try {
      await expect(security.getByText('Authenticator verified.')).toBeVisible({ timeout: 5_000 });
      await page.goto('/dashboard');
      return;
    } catch {
      if (attempt === 1) throw new Error('E2E organizer MFA challenge did not verify');
      await page.waitForTimeout(1_000);
    }
  }
}

async function buildMatchScreenFixture(): Promise<{
  fixture: ScoringFixture;
  competitionId: string;
  matchId: string;
  sideAId: string;
  sideBId: string;
}> {
  const fixture = await buildScoringFixture({ playerCount: 2 });
  const competitionId = randomUUID();
  const sideAId = randomUUID();
  const sideBId = randomUUID();
  const matchId = randomUUID();

  const competition = await fixture.service.from('competitions').insert({
    id: competitionId,
    event_id: fixture.eventId,
    name: 'E2E Match Play',
    format: 'match',
    metric: 'gross',
    status: 'scoring_open',
    rules_schema_version: 1,
    rules_json: MATCH_RULES,
    rules_text: 'Individual gross match play; ties stand.',
    engine_version: 'test',
    sort_order: 40,
  });
  if (competition.error) throw competition.error;

  const roundLink = await fixture.service.from('competition_rounds').insert({
    competition_id: competitionId,
    round_id: fixture.roundId,
    hole_scope: null,
    weight: 1,
  });
  if (roundLink.error) throw roundLink.error;

  const entities = await fixture.service.from('competition_entities').insert([
    {
      id: sideAId,
      competition_id: competitionId,
      event_entry_id: fixture.entries[0]!.entryId,
      eligibility_status: 'eligible',
    },
    {
      id: sideBId,
      competition_id: competitionId,
      event_entry_id: fixture.entries[1]!.entryId,
      eligibility_status: 'eligible',
    },
  ]);
  if (entities.error) throw entities.error;

  const groupId = randomUUID();
  const group = await fixture.service.from('groups').insert({
    id: groupId,
    round_id: fixture.roundId,
    label: 'E2E match group',
    start_hole_ordinal: 1,
    sort_order: 1,
  });
  if (group.error) throw group.error;
  const groupMembers = await fixture.service.from('group_members').insert(
    fixture.entries.map((entry, index) => ({
      group_id: groupId,
      event_entry_id: entry.entryId,
      sort_order: index + 1,
    })),
  );
  if (groupMembers.error) throw groupMembers.error;

  const match = await fixture.service.from('matches').insert({
    id: matchId,
    competition_id: competitionId,
    round_id: fixture.roundId,
    side_a_entity_id: sideAId,
    side_b_entity_id: sideBId,
    bracket_position: 1,
    status: 'scheduled',
  });
  if (match.error) throw match.error;

  const projected = await callFunction<{ status?: string }>(
    'rebuild-projections',
    { eventId: fixture.eventId },
    fixture.director.accessToken,
  );
  expect(projected.status, JSON.stringify(projected.body)).toBe(200);

  return { fixture, competitionId, matchId, sideAId, sideBId };
}

test.beforeAll(async () => {
  const service = serviceClient();
  organizer = await createAccount(service, { displayName: 'E2E Organizer', withMfa: true });
  const { error: membershipError } = await service.from('league_memberships').insert({
    league_id: LEAGUE_ID,
    profile_id: organizer.profileId,
    member_status: 'active',
  });
  if (membershipError) throw membershipError;
  const { error: roleError } = await service.from('role_assignments').insert({
    league_id: LEAGUE_ID,
    profile_id: organizer.profileId,
    role: 'owner',
  });
  if (roleError) throw roleError;
});

test('sign-in and privacy pages meet the automated accessibility baseline', async ({ page }) => {
  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { name: 'Ready for the first tee?' })).toBeVisible();
  await expectAccessible(page);

  await page.goto('/privacy');
  await expect(page.getByRole('heading', { name: 'Privacy notice' })).toBeVisible();
  await expectAccessible(page);
});

test('temporary credentials force password change and persist privacy acceptance', async ({ page }) => {
  const service = serviceClient();
  const account = await createAccount(service, {
    displayName: 'E2E New Player',
    mustChangePassword: true,
    privacyAccepted: false,
  });
  const membership = await service.from('league_memberships').insert({
    league_id: LEAGUE_ID,
    profile_id: account.profileId,
    member_status: 'active',
  });
  if (membership.error) throw membership.error;

  await page.goto('/sign-in');
  await page.getByLabel('Username').fill(account.username);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/activate$/, { timeout: 30_000 });
  await expectAccessible(page);

  const activatedPassword = `Activated-${account.profileId}`;
  await page.getByLabel('New passphrase').fill(activatedPassword);
  await page.getByLabel('Confirm passphrase').fill(activatedPassword);
  await page.getByRole('checkbox', { name: /privacy notice/ }).check();
  await page.getByRole('button', { name: 'Activate account' }).click();
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });

  const { data: profile, error: profileError } = await service.from('profiles')
    .select('must_change_password,privacy_accepted_at')
    .eq('id', account.profileId)
    .single();
  if (profileError) throw profileError;
  expect(profile.must_change_password).toBe(false);
  expect(profile.privacy_accepted_at).not.toBeNull();
  const { count: auditCount, error: auditError } = await service.from('audit_events')
    .select('id', { count: 'exact', head: true })
    .eq('actor_profile_id', account.profileId)
    .eq('action', 'account.activation_completed');
  if (auditError) throw auditError;
  expect(auditCount).toBe(1);

  await page.goto('/settings');
  const signOutButton = page.getByRole('button', { name: 'Sign out' });
  // Password replacement can race the current-session refresh in Firefox.
  // Continue if Auth has already returned to sign-in; otherwise use the real
  // Settings action once it is ready. The following credential assertions
  // prove the old password is revoked and the replacement password works.
  await Promise.race([
    page.waitForURL(/\/sign-in$/),
    signOutButton.waitFor({ state: 'visible' }),
  ]);
  if (!/\/sign-in$/.test(page.url())) {
    try {
      await page.evaluate(() => {
        const button = [...document.querySelectorAll('button')]
          .find((candidate) => candidate.textContent?.trim() === 'Sign out');
        if (!(button instanceof HTMLButtonElement)) return false;
        button.click();
        return true;
      });
    } catch (cause) {
      // The authenticated document may be replaced between the readiness
      // check and evaluation. That is success only when sign-in is current.
      if (!/\/sign-in$/.test(page.url())) throw cause;
    }
  }
  await expect(page).toHaveURL(/\/sign-in$/);
  // Both Settings sign-out and a password-change-triggered automatic
  // SIGNED_OUT event must finish the same durable local-data cleanup.
  await expect.poll(() => preferenceCount(page, account.profileId)).toBe(0);
  await page.getByLabel('Username').fill(account.username);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Incorrect username or password.');
  await page.getByLabel('Password').fill(activatedPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });
});

test('player reaches the active scorecard within three interactions after sign-in', async ({ page }) => {
  const fixture = await buildScoringFixture({ playerCount: 2 });

  await page.goto('/sign-in');
  await page.getByLabel('Username').fill(fixture.player.username);
  await page.getByLabel('Password').fill(fixture.player.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });
  // A shared league may have more than one open event. Select this player's
  // fixture from the schedule, then enter its card: sign in + two clicks.
  await page.getByRole('link', {
    name: new RegExp(`Integration Event ${fixture.eventId.slice(0, 8)}`),
  }).click();
  await page.getByRole('link', { name: 'Enter scores' }).click();
  await expect(page.getByRole('heading', { name: 'Hole 1' })).toBeVisible();
  await expect(page.getByLabel(`${fixture.entries[0].displayName} gross score`)).toBeVisible();
});

test('leaderboard polling converges when realtime delivery is unavailable', async ({ page }) => {
  const fixture = await buildScoringFixture({ playerCount: 2 });
  const rebuilt = await callFunction<{ status: string }>(
    'rebuild-projections',
    { eventId: fixture.eventId },
    fixture.director.accessToken,
  );
  expect(rebuilt.status, JSON.stringify(rebuilt.body)).toBe(200);

  // Keep the browser's Realtime socket open but silent. The leaderboard must
  // still converge through its bounded polling fallback (§15.2, AC-REL-004).
  await page.routeWebSocket(/\/realtime\/v1\/websocket/, (socket) => {
    socket.onMessage(() => undefined);
  });
  await page.goto('/sign-in');
  await page.getByLabel('Username').fill(fixture.player.username);
  await page.getByLabel('Password').fill(fixture.player.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });
  await page.goto(`/events/${fixture.eventId}/leaderboards/${fixture.competitions.grossId}`);

  const playerRow = page.getByRole('row').filter({
    hasText: fixture.entries[0].displayName,
  });
  await expect(playerRow).toBeVisible();
  await expect(playerRow.getByRole('cell').last()).toHaveText('—');

  const request = scoreRequest(fixture, {
    value: { status: 'complete', grossStrokes: 5, notes: null },
  });
  const submitted = await callFunction<{ status: string }>(
    'submit-score',
    request,
    fixture.director.accessToken,
  );
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  await expect(playerRow.getByRole('cell').last()).toHaveText('5', { timeout: 20_000 });

  const { count, error } = await fixture.service
    .from('score_mutations')
    .select('idempotency_key', { count: 'exact', head: true })
    .eq('idempotency_key', request.idempotencyKey as string);
  if (error) throw error;
  expect(count).toBe(1);
});

test('organizer records and reloads an accessible match result at 320px', async ({ page }) => {
  const {
    fixture,
    competitionId,
    matchId,
    sideAId,
  } = await buildMatchScreenFixture();
  const sideAName = fixture.entries[0]!.displayName;
  const resultSummary = '3 & 2';
  const reason = 'Both sides confirmed the final margin to the Committee';

  await signInOrganizer(page, fixture.director);
  await page.goto(`/events/${fixture.eventId}/matches/${competitionId}`);
  await expect(page.getByRole('heading', { name: 'E2E Match Play' })).toBeVisible();
  await expect(page.getByText(sideAName, { exact: true })).toBeVisible();
  await expectAccessible(page);
  await expectNarrowReflow(page);

  await page.getByRole('button', { name: 'Record result' }).click();
  const winner = page.getByLabel(/Winning side/);
  await winner.selectOption(sideAId);
  // Selecting a winner must remove the incompatible default "Halved" text
  // and require an explicit winning margin before the audited write.
  await expect(page.getByLabel('Result summary')).toHaveValue('');
  await page.getByLabel('Result summary').fill(resultSummary);
  await page.getByLabel('Committee reason').fill(reason);
  await expectAccessible(page);
  await expectNarrowReflow(page);
  await page.getByRole('button', { name: 'Record match result' }).click();

  await expect(page.getByText(/Match result recorded/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(resultSummary, { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const { data, error } = await fixture.service.from('matches')
      .select('status,winner_entity_id,result_summary,concession_reason')
      .eq('id', matchId)
      .single();
    if (error) throw error;
    return data;
  }, { timeout: 30_000 }).toEqual({
    status: 'complete',
    winner_entity_id: sideAId,
    result_summary: resultSummary,
    concession_reason: null,
  });
  await expect.poll(async () => {
    const { data, error } = await fixture.service.from('audit_events')
      .select('action,reason')
      .eq('target_type', 'match')
      .eq('target_id', matchId)
      .single();
    if (error) throw error;
    return data;
  }, { timeout: 30_000 }).toEqual({
    action: 'match.result_set',
    reason,
  });

  await page.reload();
  await expect(page.getByText(resultSummary, { exact: true })).toBeVisible();
  await expect(page.locator('.match-side--winner')).toContainText(sideAName);
  await expect(page.locator('.match-side--winner')).toContainText('Winner');
});

test('operator can review release health, capacity, recovery, and repair readiness', async ({ page }) => {
  await signInOrganizer(page);

  await page.goto('/admin/operations');
  await expect(page.getByRole('heading', { name: 'Operations', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Season launch readiness' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Database capacity' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Projection repair' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recovery evidence' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Manual quota review' })).toBeVisible();
  await expect(page.getByText('the app never invents usage', { exact: false })).toBeVisible();
  await expectAccessible(page);
  await expectNarrowReflow(page);
});

test('organizer creates, publishes, scores, finalizes, reopens, and exports a gross event', async ({ page, browserName }) => {
  await signInOrganizer(page);

  await page.getByRole('link', { name: 'Create event' }).click();
  await page.getByLabel('Event name').fill('E2E Gross Championship');
  await page.getByLabel('Competition preset').selectOption('individual_gross');
  const fieldPlayers = page.getByRole('group', { name: 'Event field' }).getByRole('checkbox');
  await uncheckAll(fieldPlayers);
  await fieldPlayers.first().check();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved. Server preflight passed and the event is ready to publish.')).toBeVisible();
  await page.getByRole('button', { name: 'Publish and open scoring' }).click();
  await expect(page.getByRole('heading', { name: 'E2E Gross Championship' })).toBeVisible({ timeout: 30_000 });

  const eventUrl = page.url();
  const eventId = /\/events\/([^/]+)/.exec(eventUrl)?.[1];
  expect(eventId).toBeTruthy();
  await page.getByRole('link', { name: 'Enter scores' }).click();
  const firstScore = page.getByRole('spinbutton').first();
  await firstScore.fill('5');
  await page.getByRole('button', { name: 'Save hole 1' }).click();
  await expect(page.getByRole('status')).toContainText('Saved to server', { timeout: 30_000 });

  // The first production visit installs the PWA worker. Reload once while
  // online if needed so this page is controlled before exercising an offline
  // deep-link refresh.
  await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) throw new Error('Service workers are unavailable');
    await navigator.serviceWorker.ready;
  });
  if (!await page.evaluate(() => navigator.serviceWorker.controller !== null)) {
    await page.reload();
  }
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  const cachedSnapshots = await readEventSnapshots(page, eventId!);
  expect(cachedSnapshots, 'score entry must be cached before the network drops').not.toHaveLength(0);

  await page.context().setOffline(true);
  await expect(page.getByText('Offline · showing saved event data')).toBeVisible();
  await expect(page.getByText(/Offline copy from/)).toBeVisible();
  await page.getByRole('link', { name: 'Back to E2E Gross Championship' }).click();
  await page.getByRole('link', { name: 'Enter scores' }).click();
  await expect(page.getByText(/Offline copy from/)).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('spinbutton').first().fill('6');
  await page.getByRole('button', { name: 'Save hole 2' }).click();
  await expect(page.getByRole('spinbutton').first()).toHaveValue('6');
  await expect(page.getByText('1 score not synced')).toBeVisible();
  const queuedBeforeRefresh = await readOutbox(page);
  expect(queuedBeforeRefresh.filter((row) => row.state === 'queued')).toHaveLength(1);
  const queued = queuedBeforeRefresh.find((row) => row.state === 'queued');
  expect(queued).toBeDefined();

  if (browserName === 'webkit') {
    // Playwright does not automate service-worker navigations in WebKit and
    // its offline reload command fails inside the adapter. The Chromium and
    // Firefox projects exercise the true offline navigation fallback. Here,
    // keep the mutation ineligible for sync, reload a new document in the
    // same offline-app mode, and verify WebKit's IndexedDB persistence.
    await setOutboxNextAttemptAt(page, queued!.idempotencyKey, Date.now() + 60_000);
    await page.context().setOffline(false);
    await page.evaluate(() => {
      window.sessionStorage.setItem('gtt.networkOffline', String(Date.now()));
    });
    await page.reload();
  } else {
    // Simulate a long offline session. The pagehide handoff must refresh this
    // stale marker before the next document reconciles mobile connectivity.
    await page.evaluate(() => {
      window.sessionStorage.setItem('gtt.networkOffline', String(Date.now() - 60_000));
    });
    await page.reload();
  }
  await expect(page.getByText(/Offline copy from/)).toBeVisible();
  // Reload starts a fresh scoring document on Hole 1. Return to the hole that
  // owns the offline draft before asserting its durable value.
  await expect(page.getByRole('heading', { name: 'Hole 1' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Hole 2' })).toBeVisible();
  await expect(page.getByRole('spinbutton').first()).toHaveValue('6');
  const queuedAfterRefresh = await readOutbox(page);
  const preserved = queuedAfterRefresh.find((row) =>
    row.idempotencyKey === queued?.idempotencyKey);
  expect(preserved?.state).toBe('queued');
  if (browserName === 'webkit') {
    await setOutboxNextAttemptAt(page, queued!.idempotencyKey, 0);
  } else {
    await page.context().setOffline(false);
  }
  // Reconnection itself schedules a retry. Do not race the manual button:
  // it is correctly disabled while that automatic sync is in flight.
  await expect(page.getByText('1 score not synced')).toBeHidden({ timeout: 30_000 });
  const synced = (await readOutbox(page)).find((row) =>
    row.idempotencyKey === queued?.idempotencyKey);
  expect(synced?.state).toBe('synced');
  const { count: mutationCount, error: mutationError } = await serviceClient()
    .from('score_mutations')
    .select('idempotency_key', { count: 'exact', head: true })
    .eq('idempotency_key', queued!.idempotencyKey);
  if (mutationError) throw mutationError;
  expect(mutationCount).toBe(1);

  await page.goto(`/admin/events/${eventId}/scoring`);
  await expect(page.getByRole('heading', { name: 'Scoring control room' })).toBeVisible();
  await page.getByLabel('Committee override reason').fill('E2E launch-path finalization override');
  await page.getByRole('button', { name: 'Finalize', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm finalization' }).click();
  await expect(page.getByText(/Individual Gross finalized\. Result hash/)).toBeVisible({ timeout: 30_000 });

  // The audited correction loop from the §26 runbook: reopen the sealed
  // result, then seal it again so the export carries a real final hash.
  await page.getByRole('button', { name: 'Reopen', exact: true }).click();
  await page.getByLabel('Reason for reopening').fill('E2E committee correction after review');
  await page.getByRole('button', { name: 'Confirm reopen' }).click();
  await expect(page.getByText(/Individual Gross reopened/)).toBeVisible({ timeout: 30_000 });

  await page.getByLabel('Committee override reason').fill('E2E refinalization after the audited reopen');
  await page.getByRole('button', { name: 'Finalize', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm finalization' }).click();
  await expect(page.getByText(/Individual Gross finalized\. Result hash/)).toBeVisible({ timeout: 30_000 });

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export event' }).click();
  expect((await download).suggestedFilename()).toMatch(/^gtt-.*\.json$/);
});

test('organizer publishes the two-person preset and moves between shared-score results', async ({ page }) => {
  await signInOrganizer(page);

  await page.getByRole('link', { name: 'Create event' }).click();
  await page.getByLabel('Event name').fill('E2E Two-Person Throwdown');
  await expect(page.getByLabel('Competition preset')).toHaveValue('two_person_throwdown');
  const eventField = page.getByRole('group', { name: 'Event field' });
  const fieldPlayers = eventField.getByRole('checkbox');
  await uncheckAll(fieldPlayers);
  for (const player of PHASE_2_PLAYERS) await eventField.getByRole('checkbox', { name: new RegExp(player) }).check();
  await expect(page.getByText('2 teams')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Handicap review' })).toBeVisible();
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(5);
  await expectAccessible(page);
  await expectNarrowReflow(page);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved. Server preflight passed and the event is ready to publish.')).toBeVisible();
  await page.getByRole('button', { name: 'Publish and open scoring' }).click();
  await expect(page.getByRole('heading', { name: 'E2E Two-Person Throwdown' })).toBeVisible({ timeout: 30_000 });
  const eventId = /\/events\/([^/]+)/.exec(page.url())?.[1];
  expect(eventId).toBeTruthy();
  await expect(page.getByRole('navigation', { name: 'Event competitions' }).getByRole('link')).toHaveCount(6);
  await expect(page.getByText('1 group')).toBeVisible();
  await expectAccessible(page);

  await page.getByRole('link', { name: 'Enter scores' }).click();
  await expect(page.getByRole('spinbutton')).toHaveCount(4);
  const scoreInputs = await page.getByRole('spinbutton').all();
  for (const [index, input] of scoreInputs.entries()) await input.fill(String(5 + index));
  await page.getByRole('button', { name: 'Save hole 1' }).click();
  await expect(page.getByRole('status')).toContainText('Saved to server', { timeout: 30_000 });
  await page.getByRole('link', { name: 'Back to E2E Two-Person Throwdown' }).click();

  const bestBallLink = page.getByRole('link', { name: /Two-Person Best Ball Net/ });
  await bestBallLink.focus();
  await expect(bestBallLink).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Two-Person Best Ball Net' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Team' })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole('link', { name: /Back to E2E Two-Person Throwdown/ }).click();
  await page.getByRole('link', { name: /Net Skins/ }).click();
  await expect(page.getByRole('heading', { name: 'Net Skins' })).toBeVisible();
  await expectAccessible(page);

  await page.getByRole('link', { name: /Back to E2E Two-Person Throwdown/ }).click();
  await page.getByRole('link', { name: /Individual Gross/ }).click();
  await page.locator('.leaderboard-row').getByRole('link').first().click();
  const scorecard = page.getByRole('heading', { name: /’s scorecard$/ });
  await expect(scorecard).toBeVisible();
  const scorecardHeading = await scorecard.textContent();
  const attestedPlayer = scorecardHeading?.replace(/’s scorecard$/, '') ?? PHASE_2_PLAYERS[0];
  await expect(page.getByRole('columnheader')).toHaveCount(6);
  await expectAccessible(page);
  await expectNarrowReflow(page);
  await page.getByRole('button', { name: 'Attest scorecard' }).click();
  await expect(page.getByText('Current scorecard revision attested.')).toBeVisible({ timeout: 30_000 });

  await page.goto(`/events/${eventId}/score`);
  await page.getByLabel(`${attestedPlayer} gross score`).fill('9');
  await page.getByRole('button', { name: 'Save hole 1' }).click();
  await expect(page.getByRole('status')).toContainText('Saved to server', { timeout: 30_000 });
  await page.goto(`/admin/events/${eventId}/scoring`);
  await expect(page.getByText('0/4 cards attested')).toBeVisible();
  await expectAccessible(page);

  await page.goto(`/admin/events/${eventId}/setup`);
  await expect(page.getByRole('heading', { name: 'Setup is frozen' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open control room' })).toBeVisible();
  await expectAccessible(page);
});

test('organizer publishes a four-player scramble and enters one team ball', async ({ page }) => {
  await signInOrganizer(page);

  await page.getByRole('link', { name: 'Create event' }).click();
  await page.getByLabel('Event name').fill('E2E Four-Player Scramble');
  await page.getByLabel('Competition preset').selectOption('four_player_scramble');
  const eventField = page.getByRole('group', { name: 'Event field' });
  const fieldPlayers = eventField.getByRole('checkbox');
  await uncheckAll(fieldPlayers);
  for (const player of PHASE_3_PLAYERS) {
    await eventField.getByRole('checkbox', { name: new RegExp(player) }).check();
  }
  await expect(page.getByText('2 teams')).toBeVisible();
  await expect(page.getByRole('heading', { name: '4-player teams' })).toBeVisible();
  await expect(page.locator('.scramble-handicap-summary > p:not(.table-scroll-hint)')).toContainText('25% + 20% + 15% + 10%');
  await expectAccessible(page);
  await expectNarrowReflow(page);

  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved. Server preflight passed and the event is ready to publish.')).toBeVisible();
  await page.getByRole('button', { name: 'Publish and open scoring' }).click();
  await expect(page.getByRole('heading', { name: 'E2E Four-Player Scramble' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('navigation', { name: 'Event competitions' }).getByRole('link')).toHaveCount(2);
  await expectAccessible(page);

  await page.getByRole('link', { name: 'Enter scores' }).click();
  await expect(page.getByRole('spinbutton')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Save hole 1' })).toBeEnabled();
  await page.getByRole('button', { name: 'Save hole 1' }).click();
  await expect(page.getByRole('status')).toContainText('Saved to server', { timeout: 30_000 });
  await expect(page.getByText('2 of 36 scores received')).toBeVisible();
  await page.getByLabel('Team 1 gross score').fill('3');
  await page.getByLabel('Team 2 gross score').fill('5');
  await page.getByRole('button', { name: 'Save hole 1' }).click();
  await expect(page.getByRole('status')).toContainText('Saved to server', { timeout: 30_000 });
  await expect(page.getByText(/Team playing handicap/)).toHaveCount(2);
  await expectAccessible(page);

  await page.getByRole('link', { name: 'Back to E2E Four-Player Scramble' }).click();
  await page.getByRole('link', { name: /Four-Player Scramble Net/ }).click();
  await expect(page.getByRole('heading', { name: 'Four-Player Scramble Net' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Team' })).toBeVisible();
  await page.getByRole('link', { name: /Team [12]/ }).first().click();
  await expect(page.getByRole('heading', { name: /Team [12] scorecard/ })).toBeVisible();
  await page.getByRole('button', { name: 'Attest scorecard' }).click();
  await expect(page.getByText('Current scorecard revision attested.')).toBeVisible({ timeout: 30_000 });
  await expectAccessible(page);
});
