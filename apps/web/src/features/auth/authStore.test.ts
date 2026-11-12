import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionStore } from '../../lib/session';
import {
  errorBody,
  identityOf,
  mockApi,
  resetAuth,
  signInAs,
  USER_ID,
} from '../../test-utils/auth';
import {
  authStore,
  expireSession,
  hasAnyPermission,
  hasPermission,
  loadSession,
  signIn,
  signOut,
} from './authStore';

const ME = {
  user: { id: USER_ID, username: 'owner1', displayName: 'Olivia Owner', mustChangePassword: false },
  roles: ['OWNER'],
  permissions: [{ permission: 'users.manage', scope: 'ALL', divisionId: null }],
  csrfToken: 'csrf-from-server',
};

describe('authStore', () => {
  beforeEach(() => {
    resetAuth();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loadSession: signed in sets identity, csrf token and user id', async () => {
    mockApi({ 'GET /auth/me': () => ({ body: { data: ME } }) });
    await loadSession();
    expect(authStore.get()).toMatchObject({ status: 'authenticated', verified: true });
    expect(sessionStore.get()).toEqual({ csrfToken: 'csrf-from-server', userId: USER_ID });
  });

  it('never persists the csrf token; the cached identity holds permissions only', async () => {
    mockApi({ 'GET /auth/me': () => ({ body: { data: ME } }) });
    await loadSession();
    const stored = window.localStorage.getItem('tradex.identity') ?? '';
    expect(stored).toContain('users.manage');
    expect(stored).not.toContain('csrf');
    expect(JSON.stringify(window.sessionStorage)).not.toContain('csrf');
  });

  it('loadSession: 401 means anonymous and drops the cached identity', async () => {
    window.localStorage.setItem('tradex.identity', JSON.stringify(identityOf(['users.manage'])));
    mockApi({
      'GET /auth/me': () => ({ status: 401, body: errorBody('UNAUTHENTICATED', 'No session') }),
    });
    await loadSession();
    expect(authStore.get().status).toBe('anonymous');
    expect(window.localStorage.getItem('tradex.identity')).toBeNull();
    expect(sessionStore.get().userId).toBeUndefined();
  });

  it('loadSession: server unreachable falls back to the local identity, unverified, no csrf', async () => {
    window.localStorage.setItem('tradex.identity', JSON.stringify(identityOf(['trip.view'])));
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    await loadSession();
    expect(authStore.get()).toMatchObject({ status: 'authenticated', verified: false });
    expect(sessionStore.get()).toEqual({ csrfToken: undefined, userId: USER_ID });
  });

  it('loadSession: server unreachable without a local identity is anonymous', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    await loadSession();
    expect(authStore.get().status).toBe('anonymous');
  });

  it('loadSession ignores a corrupt local identity', async () => {
    window.localStorage.setItem('tradex.identity', '{"user":42}');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    await loadSession();
    expect(authStore.get().status).toBe('anonymous');
  });

  it('signIn posts the device id and stores the session', async () => {
    const calls = mockApi({ 'POST /auth/login': () => ({ body: { data: ME } }) });
    await signIn('owner1', 'secret-password');
    const [call] = calls;
    expect(call?.body).toMatchObject({ username: 'owner1', password: 'secret-password' });
    expect((call?.body as { deviceId: string }).deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(call?.headers['X-Device-Id']).toBe((call?.body as { deviceId: string }).deviceId);
    expect(authStore.get().status).toBe('authenticated');
    // The password is not kept anywhere in the store.
    expect(JSON.stringify(authStore.get())).not.toContain('secret-password');
  });

  it('signIn failure leaves the user signed out and throws', async () => {
    mockApi({
      'POST /auth/login': () => ({ status: 401, body: errorBody('UNAUTHENTICATED', 'Invalid') }),
    });
    await expect(signIn('owner1', 'wrong')).rejects.toMatchObject({ status: 401 });
    expect(authStore.get().status).toBe('loading');
    expect(sessionStore.get().userId).toBeUndefined();
  });

  it('signOut clears the session and sends the csrf token', async () => {
    signInAs(['users.manage']);
    const calls = mockApi({ 'POST /auth/logout': () => ({ body: { data: { ok: true } } }) });
    await signOut();
    expect(calls[0]?.headers['X-CSRF-Token']).toBe('csrf-test');
    expect(authStore.get()).toMatchObject({ status: 'anonymous', expired: false });
    expect(sessionStore.get()).toEqual({ csrfToken: undefined, userId: undefined });
  });

  it('signOut offline keeps the user signed in (the server session would stay alive)', async () => {
    signInAs(['users.manage']);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    await expect(signOut()).rejects.toThrow('Network request failed');
    expect(authStore.get().status).toBe('authenticated');
  });

  it('signOut treats 401 as already signed out', async () => {
    signInAs(['users.manage']);
    mockApi({
      'POST /auth/logout': () => ({
        status: 401,
        body: errorBody('UNAUTHENTICATED', 'No session'),
      }),
    });
    await signOut();
    expect(authStore.get().status).toBe('anonymous');
  });

  it('expireSession flags the session as expired for the login page', () => {
    signInAs(['users.manage']);
    expireSession();
    expect(authStore.get()).toMatchObject({ status: 'anonymous', expired: true });
  });

  it('expireSession does nothing when nobody is signed in', () => {
    authStore.set({ status: 'anonymous' });
    expireSession();
    expect(authStore.get().expired).toBe(false);
  });

  it('permission helpers', () => {
    const identity = identityOf(['users.manage']);
    expect(hasPermission(identity, 'users.manage')).toBe(true);
    expect(hasPermission(identity, 'roles.manage')).toBe(false);
    expect(hasPermission(undefined, 'users.manage')).toBe(false);
    expect(hasAnyPermission(identity, ['roles.manage', 'users.manage'])).toBe(true);
    expect(hasAnyPermission(identity, [])).toBe(false);
  });
});
