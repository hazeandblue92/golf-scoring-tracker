import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { createAccount, LEAGUE_ID } from '../integration/helpers/fixture.ts';
import { serviceClient } from '../integration/helpers/stack.ts';

let organizer: Awaited<ReturnType<typeof createAccount>>;
const PHASE_2_PLAYERS = ['Dev Player One', 'Dev Player Two', 'Dev Player Three', 'Dev Player Four'];

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
}

async function expectNarrowReflow(page: Page) {
  await page.setViewportSize({ width: 320, height: 720 });
  const overflows = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflows).toBe(false);
}

test.beforeAll(async () => {
  const service = serviceClient();
  organizer = await createAccount(service, { displayName: 'E2E Organizer' });
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

test('organizer creates, publishes, scores, finalizes, and exports a gross event', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByLabel('Username').fill(organizer.username);
  await page.getByLabel('Password').fill(organizer.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });

  await page.getByRole('link', { name: 'Create event' }).click();
  await page.getByLabel('Event name').fill('E2E Gross Championship');
  await page.getByLabel('Competition preset').selectOption('individual_gross');
  const fieldPlayers = page.getByRole('group', { name: 'Event field' }).getByRole('checkbox');
  for (const checkbox of await fieldPlayers.all()) await checkbox.uncheck();
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

  await page.context().setOffline(true);
  await expect(page.getByText('Offline · showing saved event data')).toBeVisible();
  await page.getByRole('link', { name: 'Back to E2E Gross Championship' }).click();
  await page.getByRole('link', { name: 'Enter scores' }).click();
  await expect(page.getByText(/Offline copy from/)).toBeVisible();
  await page.context().setOffline(false);

  await page.goto(`/admin/events/${eventId}/scoring`);
  await expect(page.getByRole('heading', { name: 'Scoring control room' })).toBeVisible();
  await page.getByLabel('Override reason (required only with blockers)').fill('E2E launch-path finalization override');
  await page.getByRole('button', { name: 'Finalize all 1' }).click();
  await expect(page.getByText(/Finalized 1 competition/)).toBeVisible({ timeout: 30_000 });

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export event' }).click();
  expect((await download).suggestedFilename()).toMatch(/^gtt-.*\.json$/);
});

test('organizer publishes the two-person preset and moves between shared-score results', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByLabel('Username').fill(organizer.username);
  await page.getByLabel('Password').fill(organizer.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });

  await page.getByRole('link', { name: 'Create event' }).click();
  await page.getByLabel('Event name').fill('E2E Two-Person Throwdown');
  await expect(page.getByLabel('Competition preset')).toHaveValue('two_person_throwdown');
  const fieldPlayers = page.getByRole('group', { name: 'Event field' }).getByRole('checkbox');
  for (const checkbox of await fieldPlayers.all()) await checkbox.uncheck();
  for (const player of PHASE_2_PLAYERS) await page.getByRole('checkbox', { name: new RegExp(player) }).check();
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
  await page.locator('.leaderboard-row').first().click();
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
