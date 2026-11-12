import type { Page, Route } from '@playwright/test';

/**
 * In-browser stand-in for the API (Playwright `page.route`). The e2e run serves the built web app
 * only; the real API needs a database. It enforces what the browser must do: cookie-less session
 * state here, but the CSRF header on every mutation and the generic 401 shape.
 */

export const OWNER_ID = '01930000-0000-7000-8000-0000000000a1';
export const CSRF = 'csrf-e2e-token';
export const PASSWORD = 'correct horse battery';

export const OWNER = {
  user: {
    id: OWNER_ID,
    username: 'owner1',
    displayName: 'Olivia Owner',
    mustChangePassword: false,
  },
  roles: ['OWNER'],
  permissions: ['users.manage', 'roles.manage', 'audit.view', 'trip.view', 'expense.view'].map(
    (permission) => ({ permission, scope: 'ALL', divisionId: null }),
  ),
  csrfToken: CSRF,
};

export interface FakeApi {
  readonly requests: string[];
  readonly csrfFailures: string[];
  signedIn: () => boolean;
  /** The next sign-in answers with this user instead of the owner. */
  setNextUser: (user: typeof OWNER) => void;
}

function json(route: Route, status: number, body: unknown): Promise<void> {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

function unauthenticated(route: Route): Promise<void> {
  return json(route, 401, {
    error: { code: 'UNAUTHENTICATED', message: 'Authentication required', requestId: 'e2e' },
  });
}

export async function installFakeApi(
  page: Page,
  options: { signedIn?: boolean } = {},
): Promise<FakeApi> {
  let signedIn = options.signedIn ?? false;
  let current = OWNER;
  const requests: string[] = [];
  const csrfFailures: string[] = [];

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1', '');
    const key = `${request.method()} ${path}`;
    requests.push(key);

    if (request.method() !== 'GET' && key !== 'POST /auth/login') {
      if (request.headers()['x-csrf-token'] !== CSRF) {
        csrfFailures.push(key);
        return json(route, 403, {
          error: { code: 'FORBIDDEN', message: 'CSRF token missing', requestId: 'e2e' },
        });
      }
    }

    switch (key) {
      case 'GET /auth/me':
        return signedIn ? json(route, 200, { data: current }) : unauthenticated(route);
      case 'POST /auth/login': {
        const body = request.postDataJSON() as { password?: string; deviceId?: string };
        if (body.password !== PASSWORD || typeof body.deviceId !== 'string') {
          return unauthenticated(route);
        }
        signedIn = true;
        return json(route, 200, { data: current });
      }
      case 'POST /auth/logout':
        signedIn = false;
        return json(route, 200, { data: { ok: true } });
      case 'GET /sync/pull':
        return json(route, 200, { changes: [], nextCursor: 0, hasMore: false });
      case 'GET /users':
        return json(route, 200, {
          data: [
            {
              id: '01930000-0000-7000-8000-0000000000a2',
              username: 'a-rather-long-username-for-a-narrow-screen',
              displayName: 'Dan Driver With A Fairly Long Display Name',
              phone: null,
              status: 'ACTIVE',
              mustChangePassword: false,
              lastLoginAt: null,
              createdAt: '2026-11-01T08:00:00.000Z',
              roles: [],
            },
          ],
        });
      case 'GET /roles':
        return json(route, 200, {
          data: [
            {
              id: '01930000-0000-7000-8000-0000000000b1',
              code: 'OWNER',
              name: 'Owner',
              isSystem: true,
              permissions: [
                { permission: 'users.manage', scope: 'ALL' },
                { permission: 'trip.view', scope: 'ALL' },
              ],
            },
          ],
        });
      default:
        return json(route, 404, {
          error: { code: 'NOT_FOUND', message: `No fake for ${key}`, requestId: 'e2e' },
        });
    }
  });

  return {
    requests,
    csrfFailures,
    signedIn: () => signedIn,
    setNextUser: (user) => {
      current = user;
    },
  };
}
