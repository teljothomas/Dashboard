import { expect, test } from '@playwright/test';
import { installFakeApi } from './fakeApi';

test('app shell renders and navigates at phone width', async ({ page }) => {
  await installFakeApi(page, { signedIn: true });
  await page.goto('/');
  await expect(page.getByRole('banner')).toContainText('TradeX ERP');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Home');

  // Permission-aware nav: the fake owner holds trip.view and expense.view but no approval permission.
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(nav.getByRole('link')).toHaveCount(4);

  await nav.getByRole('link', { name: 'Expenses' }).click();
  await expect(page).toHaveURL(/\/expenses$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Expenses');

  // No horizontal scroll at 375 px.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});
