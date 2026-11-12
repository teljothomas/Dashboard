import { expect, test, type Page } from '@playwright/test';
import { installFakeApi, PASSWORD } from './fakeApi';

async function noHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
}

test('login, dashboard placeholder, logout', async ({ page }) => {
  const api = await installFakeApi(page);

  // Not signed in: any address leads to the login page.
  await page.goto('/trips');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByLabel('Username')).toBeVisible();

  // A wrong password gives the one generic message.
  await page.getByLabel('Username').fill('owner1');
  await page.getByLabel('Password').fill('not the password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Wrong username or password.');
  expect(api.signedIn()).toBe(false);

  // The right password opens the page that was asked for (Trips).
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/trips$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Trips');

  // Dashboard placeholder with the signed-in user in the top bar.
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Home' })
    .click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Home');
  await expect(page.getByRole('banner')).toContainText('Olivia Owner');

  // The session survives a reload (cookie in a real browser; /auth/me answers).
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Home');

  // Logout from More: nothing is waiting to upload, so no warning.
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'More' })
    .click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(api.signedIn()).toBe(false);
  expect(api.csrfFailures).toEqual([]);

  // Back/forward cannot reach a page without signing in again.
  await page.goto('/more');
  await expect(page).toHaveURL(/\/login$/);
});

test('screens fit a 360 px phone without horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await installFakeApi(page, { signedIn: true });

  for (const path of [
    '/more',
    '/admin/users',
    '/admin/users/new',
    '/admin/roles',
    '/admin/roles/01930000-0000-7000-8000-0000000000b1',
    '/change-password',
  ]) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await noHorizontalScroll(page), `horizontal scroll on ${path}`).toBe(true);
  }

  await page.goto('/admin/users');
  await expect(page.getByText('Dan Driver With A Fairly Long Display Name')).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);

  // Login page too, signed out.
  await page.context().clearCookies();
  const loggedOut = await page.context().newPage();
  await installFakeApi(loggedOut);
  await loggedOut.setViewportSize({ width: 360, height: 740 });
  await loggedOut.goto('/login');
  await expect(loggedOut.getByLabel('Username')).toBeVisible();
  expect(await noHorizontalScroll(loggedOut)).toBe(true);
  // Controls are at least 44 px tall.
  for (const locator of [
    loggedOut.getByLabel('Username'),
    loggedOut.getByLabel('Password'),
    loggedOut.getByRole('button', { name: 'Sign in' }),
  ]) {
    const box = await locator.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
});
