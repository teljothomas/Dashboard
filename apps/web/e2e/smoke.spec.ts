import { expect, test } from '@playwright/test';

test('app shell renders and navigates at phone width', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('banner')).toContainText('TradeX ERP');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Home');

  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(nav.getByRole('link')).toHaveCount(5);

  await nav.getByRole('link', { name: 'Expenses' }).click();
  await expect(page).toHaveURL(/\/expenses$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Expenses');

  // No horizontal scroll at 375 px.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});
