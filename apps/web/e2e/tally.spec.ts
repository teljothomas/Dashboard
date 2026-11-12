import { expect, test, type Page } from '@playwright/test';
import { installFakeApi, REGISTRATION_CODE } from './fakeApi';

async function noHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
}

test('status page shows heartbeat, lease holder, watermarks and the stale badge', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const api = await installFakeApi(page, { signedIn: true });

  // Reach it from More, as a user would.
  await page.goto('/more');
  await page.getByRole('link', { name: 'Tally status' }).click();
  await expect(page).toHaveURL(/\/tally$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tally status');

  const card = page.getByRole('article', { name: 'Acme Meats' });
  await expect(card.getByText('Stale', { exact: true })).toBeVisible();
  await expect(card.getByText('Test company')).toBeVisible();
  await expect(card.getByText('TALLY-PC holds the connection (epoch 4)')).toBeVisible();
  await expect(card.getByText('Tally reachable')).toBeVisible();
  await expect(card.getByText('Company matches')).toBeVisible();
  await expect(card.getByText('Vouchers', { exact: true })).toBeVisible();
  await expect(card.getByText(/position 5400/)).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  expect(api.csrfFailures).toEqual([]);
});

test('issuing a registration code shows it once with a copy button', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ width: 360, height: 740 });
  const api = await installFakeApi(page, { signedIn: true });

  await page.goto('/tally/companies');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tally companies');
  expect(await noHorizontalScroll(page)).toBe(true);

  const company = page.getByRole('listitem', { name: 'Acme Meats' });
  await company.getByRole('button', { name: 'Issue registration code' }).click();

  const region = page.getByRole('region', { name: 'Registration code' });
  await expect(region.getByTestId('registration-code')).toHaveText(REGISTRATION_CODE);
  await expect(region).toContainText('shown only once');
  expect(await noHorizontalScroll(page)).toBe(true);
  expect(api.registrationCodesIssued()).toBe(1);
  expect(api.csrfFailures).toEqual([]);

  await region.getByRole('button', { name: 'Copy code' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(REGISTRATION_CODE);

  // Hidden for good: leaving the page and coming back does not bring it back.
  await region.getByRole('button', { name: 'Done, hide code' }).click();
  await expect(page.getByText(REGISTRATION_CODE)).toHaveCount(0);
  await page.goto('/tally/companies');
  await expect(page.getByRole('listitem', { name: 'TALLY-PC' })).toBeVisible();
  await expect(page.getByText(REGISTRATION_CODE)).toHaveCount(0);
  expect(api.registrationCodesIssued()).toBe(1);
});

test('ledger and voucher browse show the TALLY source label and as-of', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await installFakeApi(page, { signedIn: true });

  await page.goto('/tally/ledgers');
  await expect(page.getByText('Sharma Traders And Sons', { exact: false })).toBeVisible();
  await expect(page.getByText('Source: Tally')).toBeVisible();
  await expect(page.getByText(/as of/)).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);

  await page.goto('/tally/vouchers');
  await expect(page.getByText(/S-101/)).toBeVisible();
  await expect(page.getByText('Source: Tally')).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
});
