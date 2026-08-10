import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { createAccount, LEAGUE_ID } from '../integration/helpers/fixture.ts';
import { serviceClient } from '../integration/helpers/stack.ts';

let organizer: Awaited<ReturnType<typeof createAccount>>;

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
  let results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);

  await page.goto('/privacy');
  await expect(page.getByRole('heading', { name: 'Privacy notice' })).toBeVisible();
  results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test('organizer creates, publishes, scores, finalizes, and exports a gross event', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByLabel('Username').fill(organizer.username);
  await page.getByLabel('Password').fill(organizer.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });

  await page.getByRole('link', { name: 'Create event' }).click();
  await page.getByLabel('Event name').fill('E2E Gross Championship');
  const fieldPlayers = page.getByRole('group', { name: 'Event field' }).getByRole('checkbox');
  for (const checkbox of await fieldPlayers.all()) await checkbox.uncheck();
  await fieldPlayers.first().check();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved. Preflight passed and is ready to publish.')).toBeVisible();
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
  await page.getByRole('button', { name: 'Close and finalize' }).click();
  await expect(page.getByText(/Finalized\. Result hash/)).toBeVisible({ timeout: 30_000 });

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export event' }).click();
  expect((await download).suggestedFilename()).toMatch(/^gtt-.*\.json$/);
});
