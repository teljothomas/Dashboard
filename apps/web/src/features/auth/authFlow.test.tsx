import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorBody, mockApi, renderApp, resetAuth, signInAs, USER_ID } from '../../test-utils/auth';
import { authStore } from './authStore';

const ME = {
  user: { id: USER_ID, username: 'owner1', displayName: 'Olivia Owner', mustChangePassword: false },
  roles: ['OWNER'],
  permissions: [{ permission: 'trip.view', scope: 'ALL', divisionId: null }],
  csrfToken: 'csrf-from-server',
};

const NOT_SIGNED_IN = () => ({
  status: 401,
  body: errorBody('UNAUTHENTICATED', 'Authentication required'),
});

beforeEach(() => {
  resetAuth();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('route guard', () => {
  it('sends an anonymous visitor to the login page', async () => {
    mockApi({ 'GET /auth/me': NOT_SIGNED_IN });
    const { router } = renderApp('/trips');
    expect(await screen.findByRole('heading', { name: 'TradeX ERP' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
  });

  it('shows a loading state, then the page, when the session is valid', async () => {
    mockApi({ 'GET /auth/me': () => ({ body: { data: ME } }) });
    renderApp('/');
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
  });

  it('forces the change-password page while the temporary password is in use', async () => {
    mockApi({
      'GET /auth/me': () => ({
        body: { data: { ...ME, user: { ...ME.user, mustChangePassword: true } } },
      }),
    });
    const { router } = renderApp('/trips');
    expect(await screen.findByRole('heading', { name: 'Change password' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/change-password');
    expect(screen.getByText('Choose a new password before you continue.')).toBeInTheDocument();
    // No navigation to anything else is on the page.
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('a signed-in user opening /login is sent on', async () => {
    signInAs(['trip.view']);
    const { router } = renderApp('/login');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/');
    });
  });
});

describe('login page', () => {
  it('signs in, shows the dashboard placeholder and returns to the page asked for', async () => {
    const user = userEvent.setup();
    const calls = mockApi({
      'GET /auth/me': NOT_SIGNED_IN,
      'POST /auth/login': () => ({ body: { data: ME } }),
    });
    const { router } = renderApp('/trips');
    await screen.findByLabelText('Username');
    await user.type(screen.getByLabelText('Username'), 'owner1');
    await user.type(screen.getByLabelText('Password'), 'a-long-secret');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Trips' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/trips');
    const login = calls.find((c) => c.path === '/auth/login');
    expect(login?.body).toMatchObject({ username: 'owner1', password: 'a-long-secret' });
  });

  it('shows one generic message for a failed sign-in and clears the password', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /auth/me': NOT_SIGNED_IN,
      'POST /auth/login': () => ({
        status: 401,
        body: errorBody('UNAUTHENTICATED', 'Invalid username or password'),
      }),
    });
    renderApp('/login');
    await screen.findByLabelText('Username');
    await user.type(screen.getByLabelText('Username'), 'owner1');
    await user.type(screen.getByLabelText('Password'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong username or password.');
    expect(screen.getByLabelText('Password')).toHaveValue('');
    expect(screen.getByLabelText('Username')).toHaveValue('owner1');
  });

  it('explains a lockout and a network failure', async () => {
    const user = userEvent.setup();
    let first = true;
    mockApi({
      'GET /auth/me': NOT_SIGNED_IN,
      'POST /auth/login': () => {
        if (first) {
          first = false;
          return { status: 429, body: errorBody('RATE_LIMITED', 'Too many failed attempts') };
        }
        throw new TypeError('offline');
      },
    });
    renderApp('/login');
    await screen.findByLabelText('Username');
    await user.type(screen.getByLabelText('Username'), 'owner1');
    await user.type(screen.getByLabelText('Password'), 'x');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts');
    await user.type(screen.getByLabelText('Password'), 'x');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Cannot reach the server');
    });
  });

  it('ignores an external return address', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /auth/me': NOT_SIGNED_IN,
      'POST /auth/login': () => ({ body: { data: ME } }),
    });
    const { router } = renderApp('/login');
    await router.navigate('/login', { state: { from: '//evil.example/steal' } });
    await screen.findByLabelText('Username');
    await user.type(screen.getByLabelText('Username'), 'owner1');
    await user.type(screen.getByLabelText('Password'), 'a-long-secret');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { name: 'Home' });
    expect(router.state.location.pathname).toBe('/');
  });

  it('tells the user when the session ended', async () => {
    authStore.set({ status: 'anonymous', expired: true });
    renderApp('/login');
    expect(await screen.findByText('Your session ended. Sign in again to continue.')).toBeVisible();
  });

  it('has touch-sized controls (min-h-11 = 44 px)', async () => {
    mockApi({ 'GET /auth/me': NOT_SIGNED_IN });
    renderApp('/login');
    await screen.findByLabelText('Username');
    for (const control of [
      screen.getByLabelText('Username'),
      screen.getByLabelText('Password'),
      screen.getByRole('button', { name: 'Sign in' }),
    ]) {
      expect(control.className).toContain('min-h-11');
    }
  });
});

describe('change password', () => {
  it('rejects a mismatch locally without calling the server', async () => {
    const user = userEvent.setup();
    signInAs(['trip.view']);
    const calls = mockApi({});
    renderApp('/change-password');
    await user.type(screen.getByLabelText('Current password'), 'old-password');
    await user.type(screen.getByLabelText('New password'), 'new-password-1');
    await user.type(screen.getByLabelText('Repeat new password'), 'new-password-2');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not the same');
    expect(calls).toHaveLength(0);
  });

  it('shows the server policy message and keeps the form', async () => {
    const user = userEvent.setup();
    signInAs(['trip.view']);
    mockApi({
      'POST /auth/change-password': () => ({
        status: 400,
        body: errorBody('VALIDATION_FAILED', 'Password must be at least 10 characters.', {
          reason: 'TOO_SHORT',
        }),
      }),
    });
    renderApp('/change-password');
    await user.type(screen.getByLabelText('Current password'), 'old-password');
    await user.type(screen.getByLabelText('New password'), 'short');
    await user.type(screen.getByLabelText('Repeat new password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('at least 10 characters');
  });

  it('after a forced change re-reads the identity and opens the app', async () => {
    const user = userEvent.setup();
    signInAs(['trip.view'], { mustChangePassword: true });
    const calls = mockApi({
      'POST /auth/change-password': () => ({ body: { data: { ok: true } } }),
      'GET /auth/me': () => ({ body: { data: ME } }),
    });
    const { router } = renderApp('/trips');
    await screen.findByRole('heading', { name: 'Change password' });
    await user.type(screen.getByLabelText('Current password'), 'temporary-pass');
    await user.type(screen.getByLabelText('New password'), 'a-brand-new-password');
    await user.type(screen.getByLabelText('Repeat new password'), 'a-brand-new-password');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/');
    });
    expect(calls.map((c) => c.path)).toEqual(['/auth/change-password', '/auth/me']);
    expect(calls[0]?.headers['X-CSRF-Token']).toBe('csrf-test');
    expect(authStore.get().identity?.user.mustChangePassword).toBe(false);
  });

  it('a 401 ends the session', async () => {
    const user = userEvent.setup();
    signInAs(['trip.view']);
    mockApi({
      'POST /auth/change-password': () => ({
        status: 401,
        body: errorBody('UNAUTHENTICATED', 'Authentication required'),
      }),
      'GET /auth/me': NOT_SIGNED_IN,
    });
    const { router } = renderApp('/change-password');
    await user.type(screen.getByLabelText('Current password'), 'old-password');
    await user.type(screen.getByLabelText('New password'), 'a-brand-new-password');
    await user.type(screen.getByLabelText('Repeat new password'), 'a-brand-new-password');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/login');
    });
  });
});

describe('reset password page', () => {
  it('completes a reset with the code and returns to sign-in', async () => {
    const user = userEvent.setup();
    const calls = mockApi({
      'POST /auth/reset/complete': () => ({ body: { data: { ok: true } } }),
    });
    const { router } = renderApp('/reset-password');
    await user.type(screen.getByLabelText('Username'), 'driver1');
    await user.type(screen.getByLabelText('Reset code'), 'ABCD2345');
    await user.type(screen.getByLabelText('New password'), 'a-brand-new-password');
    await user.type(screen.getByLabelText('Repeat new password'), 'a-brand-new-password');
    await user.click(screen.getByRole('button', { name: 'Set new password' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/login');
    });
    expect(calls[0]?.body).toEqual({
      username: 'driver1',
      code: 'ABCD2345',
      newPassword: 'a-brand-new-password',
    });
  });

  it('shows one message for every bad-code case', async () => {
    const user = userEvent.setup();
    mockApi({
      'POST /auth/reset/complete': () => ({
        status: 400,
        body: errorBody('VALIDATION_FAILED', 'Invalid or expired code', {
          reason: 'RESET_CODE_INVALID',
        }),
      }),
    });
    renderApp('/reset-password');
    await user.type(screen.getByLabelText('Username'), 'driver1');
    await user.type(screen.getByLabelText('Reset code'), 'WRONG');
    await user.type(screen.getByLabelText('New password'), 'a-brand-new-password');
    await user.type(screen.getByLabelText('Repeat new password'), 'a-brand-new-password');
    await user.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('wrong or has expired');
  });
});
