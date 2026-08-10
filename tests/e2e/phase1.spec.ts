import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { createAccount, LEAGUE_ID } from '../integration/helpers/fixture.ts';
import { serviceClient } from '../integration/helpers/stack.ts';

let organizer: Awaited<ReturnType<typeof createAccount>>;
const PHASE_2_PLAYERS = ['Dev Player One', 'Dev Player Two', 'Dev Player Three', 'Dev Player Four'];
const PHASE_3_PLAYERS = [
  ...PHASE_2_PLAYERS,
  'Dev Player Five',
  'Dev Player Six',
  'Dev Player Seven',
  'Dev Player Eight',
];

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

test('operator can review release health, capacity, recovery, and repair readiness', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByLabel('Username').fill(organizer.username);
  await page.getByLabel('Password').fill(organizer.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });

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
  await page.goto('/sign-in');
  await page.getByLabel('Username').fill(organizer.username);
  await page.getByLabel('Password').fill(organizer.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });

  await page.getByRole('link', { name: 'Create event' }).click();
  await page.getByLabel('Event name').fill('E2E Four-Player Scramble');
  await page.getByLabel('Competition preset').selectOption('four_player_scramble');
  const fieldPlayers = page.getByRole('group', { name: 'Event field' }).getByRole('checkbox');
  for (const checkbox of await fieldPlayers.all()) await checkbox.uncheck();
  for (const player of PHASE_3_PLAYERS) {
    await page.getByRole('checkbox', { name: new RegExp(player) }).check();
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
