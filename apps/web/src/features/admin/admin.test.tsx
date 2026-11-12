import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  errorBody,
  mockApi,
  renderApp,
  resetAuth,
  signInAs,
  USER_ID,
  type MockHandler,
} from '../../test-utils/auth';

const ROLE_OWNER = '01930000-0000-7000-8000-0000000000b1';
const ROLE_DRIVER = '01930000-0000-7000-8000-0000000000b6';
const ROLE_CUSTOM = '01930000-0000-7000-8000-0000000000c1';
const OTHER_USER = '01930000-0000-7000-8000-0000000000a2';
const DIVISION = '01930000-0000-7000-8000-0000000000d1';

const roles = [
  {
    id: ROLE_OWNER,
    code: 'OWNER',
    name: 'Owner',
    isSystem: true,
    permissions: [
      { permission: 'users.manage', scope: 'ALL' },
      { permission: 'trip.view', scope: 'ALL' },
      { permission: 'trip.edit', scope: 'ALL' },
    ],
  },
  {
    id: ROLE_DRIVER,
    code: 'DRIVER',
    name: 'Driver',
    isSystem: true,
    permissions: [{ permission: 'trip.view', scope: 'OWN' }],
  },
  {
    id: ROLE_CUSTOM,
    code: 'CLERK',
    name: 'Clerk',
    isSystem: false,
    permissions: [{ permission: 'trip.view', scope: 'DIVISION' }],
  },
];

function user(overrides: Record<string, unknown> = {}) {
  return {
    id: OTHER_USER,
    username: 'driver1',
    displayName: 'Dan Driver',
    phone: null,
    status: 'ACTIVE',
    mustChangePassword: false,
    lastLoginAt: null,
    createdAt: '2026-11-01T08:00:00.000Z',
    roles: [{ roleId: ROLE_DRIVER, roleCode: 'DRIVER', roleName: 'Driver', divisionId: null }],
    ...overrides,
  };
}

const rolesHandler: MockHandler = () => ({ body: { data: roles } });

beforeEach(() => {
  resetAuth();
  signInAs(['users.manage', 'roles.manage', 'audit.view']);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('admin access control', () => {
  it('a user without the permission sees "No access" and nothing is requested', () => {
    resetAuth();
    signInAs(['trip.view']);
    const calls = mockApi({});
    renderApp('/admin/users');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('No access');
    expect(calls).toHaveLength(0);
  });

  it('More lists only the admin areas the user may open', () => {
    resetAuth();
    signInAs(['audit.view']);
    renderApp('/more');
    expect(screen.getByRole('link', { name: 'Audit log' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Users' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Roles' })).not.toBeInTheDocument();
  });

  it('a 401 from an admin request sends the user to the login page', async () => {
    mockApi({
      'GET /users': () => ({ status: 401, body: errorBody('UNAUTHENTICATED', 'Session expired') }),
    });
    const { router } = renderApp('/admin/users');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/login');
    });
    expect(await screen.findByText('Your session ended. Sign in again to continue.')).toBeVisible();
  });
});

describe('users list', () => {
  it('lists users, filters by search and status, and loads more pages', async () => {
    const user_ = userEvent.setup();
    const calls = mockApi({
      'GET /users': (request) => {
        const params = new URLSearchParams(request.search);
        if (params.get('after') === 'cursor-1') {
          return {
            body: { data: [user({ id: 'u3', username: 'third', displayName: 'Third One' })] },
          };
        }
        return {
          body: {
            data: [
              user(),
              user({ id: 'u2', username: 'off', displayName: 'Off User', status: 'DISABLED' }),
            ],
            meta: { nextCursor: 'cursor-1' },
          },
        };
      },
    });
    renderApp('/admin/users');
    expect(await screen.findByText('Dan Driver')).toBeInTheDocument();
    expect(
      within(screen.getByRole('link', { name: /Off User/ })).getByText('Disabled'),
    ).toBeInTheDocument();

    await user_.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Third One')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();

    await user_.type(screen.getByLabelText('Search by name or username'), 'dan');
    await user_.selectOptions(screen.getByLabelText('Status'), 'ACTIVE');
    await user_.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => {
      const last = calls[calls.length - 1];
      expect(new URLSearchParams(last?.search).get('q')).toBe('dan');
      expect(new URLSearchParams(last?.search).get('status')).toBe('ACTIVE');
    });
  });

  it('says so when there are no users', async () => {
    mockApi({ 'GET /users': () => ({ body: { data: [] } }) });
    renderApp('/admin/users');
    expect(await screen.findByText('No users found.')).toBeInTheDocument();
  });

  it('explains a 404, which can mean a division-limited grant', async () => {
    mockApi({ 'GET /users': () => ({ status: 404, body: errorBody('NOT_FOUND', 'Not found') }) });
    renderApp('/admin/users');
    expect(await screen.findByRole('alert')).toHaveTextContent('outside the divisions');
  });
});

describe('create user', () => {
  it('creates a user with the chosen roles and opens the new user', async () => {
    const u = userEvent.setup();
    const calls = mockApi({
      'GET /roles': rolesHandler,
      'POST /users': () => ({ status: 201, body: { data: user() } }),
      [`GET /users/${OTHER_USER}`]: () => ({ body: { data: user() } }),
      [`GET /users/${OTHER_USER}/sessions`]: () => ({ body: { data: [] } }),
      [`GET /users/${OTHER_USER}/devices`]: () => ({ body: { data: [] } }),
    });
    const { router } = renderApp('/admin/users/new');
    await screen.findByLabelText(/Driver/);
    await u.type(screen.getByLabelText('Username'), 'driver1');
    await u.type(screen.getByLabelText('Name'), 'Dan Driver');
    await u.type(screen.getByLabelText('Phone'), '0700000000');
    await u.type(screen.getByLabelText('Temporary password'), 'temporary-pass-1');
    await u.click(screen.getByLabelText(/Driver/));
    await u.click(screen.getByRole('button', { name: 'Create user' }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/admin/users/${OTHER_USER}`);
    });
    const post = calls.find((c) => c.method === 'POST' && c.path === '/users');
    expect(post?.body).toEqual({
      username: 'driver1',
      displayName: 'Dan Driver',
      phone: '0700000000',
      password: 'temporary-pass-1',
      roles: [{ roleId: ROLE_DRIVER, divisionId: null }],
    });
    expect(post?.headers['X-CSRF-Token']).toBe('csrf-test');
  });

  it('shows a clear message when the username is taken', async () => {
    const u = userEvent.setup();
    mockApi({
      'GET /roles': rolesHandler,
      'POST /users': () => ({
        status: 409,
        body: errorBody('CONFLICT_VERSION', 'Username taken', { reason: 'USERNAME_TAKEN' }),
      }),
    });
    renderApp('/admin/users/new');
    await u.type(screen.getByLabelText('Username'), 'driver1');
    await u.type(screen.getByLabelText('Name'), 'Dan Driver');
    await u.type(screen.getByLabelText('Temporary password'), 'temporary-pass-1');
    await u.click(screen.getByRole('button', { name: 'Create user' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already in use');
  });

  it('still works when the user may not list roles', async () => {
    mockApi({
      'GET /roles': () => ({ status: 403, body: errorBody('FORBIDDEN', 'Forbidden') }),
    });
    renderApp('/admin/users/new');
    expect(await screen.findByText(/Roles are not available/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create user' })).toBeInTheDocument();
  });
});

describe('user detail', () => {
  function detailHandlers(extra: Record<string, MockHandler> = {}, u = user()) {
    return {
      'GET /roles': rolesHandler,
      [`GET /users/${u.id}`]: () => ({ body: { data: u } }),
      [`GET /users/${u.id}/sessions`]: () => ({
        body: {
          data: [
            {
              id: 's1',
              userId: u.id,
              deviceId: null,
              createdAt: '2026-11-10T08:00:00.000Z',
              lastSeenAt: '2026-11-11T08:00:00.000Z',
              expiresAt: '2026-12-10T08:00:00.000Z',
              userAgent: 'Chrome on Android',
              ip: '10.0.0.5',
            },
          ],
        },
      }),
      [`GET /users/${u.id}/devices`]: () => ({
        body: {
          data: [
            {
              id: 'dev1',
              userId: u.id,
              label: 'Dan phone',
              platform: 'android',
              firstSeenAt: '2026-11-01T08:00:00.000Z',
              lastSyncAt: null,
              revokedAt: null,
            },
          ],
        },
      }),
      ...extra,
    };
  }

  it('shows the reset code once, with a copy button, and never again', async () => {
    const u = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const calls = mockApi(
      detailHandlers({
        [`POST /users/${OTHER_USER}/reset-code`]: () => ({
          body: { data: { code: 'K7M2-QX9R', expiresAt: '2026-11-12T12:00:00.000Z' } },
        }),
      }),
    );
    const { client } = renderApp(`/admin/users/${OTHER_USER}`);
    await u.click(await screen.findByRole('button', { name: 'Issue reset code' }));

    const region = await screen.findByRole('region', { name: 'Reset code' });
    expect(within(region).getByTestId('reset-code')).toHaveTextContent('K7M2-QX9R');
    expect(region).toHaveTextContent('Shown once');

    await u.click(within(region).getByRole('button', { name: 'Copy code' }));
    expect(writeText).toHaveBeenCalledWith('K7M2-QX9R');

    // The code is not in the query cache, and not in any storage.
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain('K7M2-QX9R');
    expect(JSON.stringify(window.localStorage)).not.toContain('K7M2-QX9R');
    expect(JSON.stringify(window.sessionStorage)).not.toContain('K7M2-QX9R');
    expect(
      JSON.stringify(
        client
          .getMutationCache()
          .getAll()
          .map((m) => m.state.data),
      ),
    ).not.toContain('K7M2-QX9R');

    await u.click(within(region).getByRole('button', { name: 'Done, hide code' }));
    expect(screen.queryByText('K7M2-QX9R')).not.toBeInTheDocument();
    expect(calls.filter((c) => c.path.endsWith('/reset-code'))).toHaveLength(1);
  });

  it('tells the admin when the code cannot be copied', async () => {
    const u = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
      configurable: true,
    });
    mockApi(
      detailHandlers({
        [`POST /users/${OTHER_USER}/reset-code`]: () => ({
          body: { data: { code: 'K7M2-QX9R', expiresAt: '2026-11-12T12:00:00.000Z' } },
        }),
      }),
    );
    renderApp(`/admin/users/${OTHER_USER}`);
    await u.click(await screen.findByRole('button', { name: 'Issue reset code' }));
    await u.click(await screen.findByRole('button', { name: 'Copy code' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not copy');
  });

  it('refuses to issue a reset code for a disabled user or for yourself', async () => {
    mockApi(detailHandlers({}, user({ status: 'DISABLED' })));
    renderApp(`/admin/users/${OTHER_USER}`);
    expect(await screen.findByRole('button', { name: 'Issue reset code' })).toBeDisabled();
  });

  it('own account: roles, status and reset code are locked', async () => {
    const self = user({ id: USER_ID, username: 'owner1', displayName: 'Olivia Owner' });
    mockApi(detailHandlers({}, self));
    renderApp(`/admin/users/${USER_ID}`);
    expect(
      await screen.findByText('You cannot change your own roles or status.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save roles' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Disable user' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Issue reset code' })).toBeDisabled();
  });

  it('saves roles keeping the division limiter of assignments that stay', async () => {
    const u = userEvent.setup();
    const limited = user({
      roles: [
        { roleId: ROLE_DRIVER, roleCode: 'DRIVER', roleName: 'Driver', divisionId: DIVISION },
      ],
    });
    const calls = mockApi(
      detailHandlers(
        { [`PATCH /users/${OTHER_USER}`]: () => ({ body: { data: limited } }) },
        limited,
      ),
    );
    renderApp(`/admin/users/${OTHER_USER}`);
    expect(await screen.findByText(/limited to one division/)).toBeInTheDocument();
    await u.click(await screen.findByLabelText(/Clerk/));
    await u.click(screen.getByRole('button', { name: 'Save roles' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'PATCH')).toBe(true);
    });
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).toEqual({
      roles: [
        { roleId: ROLE_DRIVER, divisionId: DIVISION },
        { roleId: ROLE_CUSTOM, divisionId: null },
      ],
    });
  });

  it('disabling asks first, then sends the status', async () => {
    const u = userEvent.setup();
    const calls = mockApi(
      detailHandlers({
        [`PATCH /users/${OTHER_USER}`]: () => ({ body: { data: user({ status: 'DISABLED' }) } }),
      }),
    );
    renderApp(`/admin/users/${OTHER_USER}`);
    await u.click(await screen.findByRole('button', { name: 'Disable user' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('signed out everywhere');
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    await u.click(screen.getByRole('button', { name: 'Disable now' }));
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ status: 'DISABLED' });
    });
  });

  it('shows the server reason when an update is refused', async () => {
    const u = userEvent.setup();
    mockApi(
      detailHandlers({
        [`PATCH /users/${OTHER_USER}`]: () => ({
          status: 403,
          body: errorBody('FORBIDDEN', 'Only owners', { reason: 'OWNER_ONLY' }),
        }),
      }),
    );
    renderApp(`/admin/users/${OTHER_USER}`);
    await u.click(await screen.findByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only an owner can do this.');
  });

  it('unlocks sign-in, revokes a session, force-logs-out all, and revokes a device', async () => {
    const u = userEvent.setup();
    const calls = mockApi(
      detailHandlers({
        [`POST /users/${OTHER_USER}/unlock`]: () => ({ body: { data: { ok: true } } }),
        'DELETE /sessions/s1': () => ({ body: { data: { revoked: 1 } } }),
        [`DELETE /users/${OTHER_USER}/sessions`]: () => ({ body: { data: { revoked: 1 } } }),
        'POST /devices/dev1/revoke': () => ({ body: { data: { ok: true } } }),
      }),
    );
    renderApp(`/admin/users/${OTHER_USER}`);

    await u.click(await screen.findByRole('button', { name: 'Unlock sign-in' }));
    expect(await screen.findByText('Sign-in unlocked.')).toBeInTheDocument();

    expect(await screen.findByText('Chrome on Android')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Sign out this session' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'DELETE' && c.path === '/sessions/s1')).toBe(true);
    });

    await u.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
    await u.click(screen.getByRole('button', { name: 'Sign out all' }));
    await waitFor(() => {
      expect(
        calls.some((c) => c.method === 'DELETE' && c.path === `/users/${OTHER_USER}/sessions`),
      ).toBe(true);
    });

    await u.click(await screen.findByRole('button', { name: 'Revoke device' }));
    await u.click(screen.getByRole('button', { name: 'Revoke now' }));
    await waitFor(() => {
      expect(calls.some((c) => c.path === '/devices/dev1/revoke')).toBe(true);
    });
  });
});

describe('roles', () => {
  it('lists roles with the system badge and permission count', async () => {
    mockApi({ 'GET /roles': rolesHandler });
    renderApp('/admin/roles');
    expect(await screen.findByText('Clerk')).toBeInTheDocument();
    expect(screen.getAllByText('System')).toHaveLength(2);
    expect(screen.getByText('3 permissions')).toBeInTheDocument();
  });

  it('shows a system role read-only', async () => {
    mockApi({ 'GET /roles': rolesHandler });
    renderApp(`/admin/roles/${ROLE_OWNER}`);
    expect(await screen.findByText('System roles cannot be changed.')).toBeInTheDocument();
    expect(screen.getByLabelText('trip.view')).toBeDisabled();
    expect(screen.getByLabelText('trip.view')).toHaveValue('ALL');
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('creates a custom role from the catalogue with the chosen scopes only', async () => {
    const u = userEvent.setup();
    const calls = mockApi({
      'GET /roles': rolesHandler,
      'POST /roles': () => ({
        status: 201,
        body: {
          data: { ...roles[2], id: '01930000-0000-7000-8000-0000000000c2', code: 'AUDITOR' },
        },
      }),
    });
    renderApp('/admin/roles/new');
    await u.type(await screen.findByLabelText('Role code'), 'auditor');
    await u.type(screen.getByLabelText('Role name'), 'Auditor');
    await u.selectOptions(screen.getByLabelText('trip.view'), 'DIVISION');
    await u.click(screen.getByRole('button', { name: 'Create role' }));
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
        code: 'AUDITOR',
        name: 'Auditor',
        permissions: [{ permission: 'trip.view', scope: 'DIVISION' }],
      });
    });
  });

  it('edits a custom role and reports a refused change', async () => {
    const u = userEvent.setup();
    mockApi({
      'GET /roles': rolesHandler,
      [`PATCH /roles/${ROLE_CUSTOM}`]: () => ({
        status: 400,
        body: errorBody('VALIDATION_FAILED', 'Unknown permission', {
          reason: 'UNKNOWN_PERMISSION',
        }),
      }),
    });
    renderApp(`/admin/roles/${ROLE_CUSTOM}`);
    await u.selectOptions(await screen.findByLabelText('trip.view'), 'ALL');
    await u.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not known');
  });

  it('reports a role that does not exist', async () => {
    mockApi({ 'GET /roles': rolesHandler });
    renderApp('/admin/roles/01930000-0000-7000-8000-00000000ffff');
    expect(await screen.findByRole('alert')).toHaveTextContent('Role not found.');
  });
});

describe('audit log', () => {
  it('lists entries newest first, filters, pages and shows details', async () => {
    const u = userEvent.setup();
    const calls = mockApi({
      'GET /audit': (request) => {
        const before = new URLSearchParams(request.search).get('before');
        if (before === '90') {
          return {
            body: {
              data: [
                {
                  id: '80',
                  at: '2026-11-10T08:00:00.000Z',
                  actorUserId: null,
                  deviceId: null,
                  requestId: null,
                  action: 'auth.login',
                  entityType: 'app_user',
                  entityId: 'x',
                  before: null,
                  after: null,
                  ip: null,
                },
              ],
            },
          };
        }
        return {
          body: {
            data: [
              {
                id: '100',
                at: '2026-11-11T08:00:00.000Z',
                actorUserId: USER_ID,
                deviceId: null,
                requestId: null,
                action: 'user.update',
                entityType: 'app_user',
                entityId: 'abc',
                before: { status: 'ACTIVE' },
                after: { status: 'DISABLED' },
                ip: null,
              },
            ],
            meta: { nextCursor: '90' },
          },
        };
      },
    });
    renderApp('/admin/audit');
    expect(await screen.findByText('user.update')).toBeInTheDocument();
    await u.click(screen.getByText('Details'));
    expect(screen.getByText(/"DISABLED"/)).toBeInTheDocument();

    await u.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('auth.login')).toBeInTheDocument();

    await u.type(screen.getByLabelText('Action'), 'user.update');
    await u.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => {
      const last = calls[calls.length - 1];
      expect(new URLSearchParams(last?.search).get('action')).toBe('user.update');
    });
  });

  it('reports a failure to load', async () => {
    mockApi({
      'GET /audit': () => ({ status: 403, body: errorBody('FORBIDDEN', 'Forbidden') }),
    });
    renderApp('/admin/audit');
    expect(await screen.findByRole('alert')).toHaveTextContent('permission');
  });
});
