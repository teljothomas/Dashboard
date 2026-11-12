import { SessionInfo } from '@tradex/contracts';
import { api, ApiError } from '../../lib/api';
import { getDeviceId, sessionStore } from '../../lib/session';
import { createStore, useStore } from '../../lib/store';
import { ensureDeviceId } from '../../offline/db';
import { getOfflineRuntime } from '../../offline/runtime';

/** What the UI knows about the signed-in user. The CSRF token is deliberately not part of it. */
export type Identity = Omit<SessionInfo, 'csrfToken'>;

export type AuthStatus = 'loading' | 'anonymous' | 'authenticated';

export interface AuthState {
  status: AuthStatus;
  identity: Identity | undefined;
  /**
   * False when the identity came from the local copy because the server could not be reached
   * (offline start). Local capture works; the CSRF token is missing until `/auth/me` answers.
   */
  verified: boolean;
  /** The session ended on its own (401 on a request); the login page says so. */
  expired: boolean;
}

export const authStore = createStore<AuthState>({
  status: 'loading',
  identity: undefined,
  verified: false,
  expired: false,
});

const IDENTITY_KEY = 'tradex.identity';

/**
 * Permission names, roles and the display name only. No password, no session token, no CSRF token
 * (SECURITY §4). It lets the PWA start offline on the existing cookie (SECURITY §2); the server
 * still authorizes every request.
 */
function readCachedIdentity(): Identity | undefined {
  try {
    const raw = window.localStorage.getItem(IDENTITY_KEY);
    if (raw === null) return undefined;
    const parsed = SessionInfo.omit({ csrfToken: true }).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function writeCachedIdentity(identity: Identity | undefined): void {
  try {
    if (identity === undefined) {
      window.localStorage.removeItem(IDENTITY_KEY);
    } else {
      window.localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
    }
  } catch {
    // Storage unavailable: the in-memory state still works for this page load.
  }
}

function toIdentity(info: SessionInfo): Identity {
  return { user: info.user, roles: info.roles, permissions: info.permissions };
}

function applySession(info: SessionInfo): void {
  const identity = toIdentity(info);
  writeCachedIdentity(identity);
  sessionStore.set({ csrfToken: info.csrfToken, userId: info.user.id });
  authStore.set({ status: 'authenticated', identity, verified: true, expired: false });
}

/** Local sign-out of the UI state. Offline records stay in IndexedDB, locked to their user. */
function clearSession(expired: boolean): void {
  writeCachedIdentity(undefined);
  sessionStore.set({ csrfToken: undefined, userId: undefined });
  authStore.set({ status: 'anonymous', identity: undefined, verified: false, expired });
}

/** The server said 401 on a request made while signed in. */
export function expireSession(): void {
  if (authStore.get().status === 'authenticated') {
    clearSession(true);
  }
}

let inflight: Promise<void> | undefined;

/**
 * Ask the server who we are (`GET /auth/me`). Used at start-up and to refresh an unverified
 * (offline) identity. Concurrent calls share one request.
 */
export function loadSession(): Promise<void> {
  inflight ??= (async () => {
    const wasAuthenticated = authStore.get().status === 'authenticated';
    try {
      const { data } = await api.get<unknown>('/auth/me');
      const parsed = SessionInfo.safeParse(data);
      if (!parsed.success) {
        throw new ApiError('INTERNAL', 'Malformed session response', 200);
      }
      applySession(parsed.data);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearSession(wasAuthenticated);
        return;
      }
      // Server unreachable or broken: keep working from the local copy when there is one.
      const cached = wasAuthenticated ? authStore.get().identity : readCachedIdentity();
      if (cached === undefined) {
        clearSession(false);
        return;
      }
      sessionStore.set({ userId: cached.user.id });
      authStore.set({ status: 'authenticated', identity: cached, verified: false, expired: false });
    }
  })().finally(() => {
    inflight = undefined;
  });
  return inflight;
}

/** `POST /auth/login`. Throws ApiError / ApiNetworkError for the page to describe. */
export async function signIn(username: string, password: string): Promise<void> {
  try {
    // Make the id we register equal to the id the offline layer will use for pushes.
    await ensureDeviceId(getOfflineRuntime().db);
  } catch {
    // IndexedDB unavailable: the localStorage id is used.
  }
  const { data } = await api.post<unknown>('/auth/login', {
    username,
    password,
    deviceId: getDeviceId(),
  });
  const parsed = SessionInfo.safeParse(data);
  if (!parsed.success) {
    throw new ApiError('INTERNAL', 'Malformed login response', 200);
  }
  applySession(parsed.data);
}

/**
 * `POST /auth/logout`. Needs the server: signing out only on this phone would leave a live session
 * on the server. ApiNetworkError propagates so the page can say so; the user stays signed in.
 */
export async function signOut(): Promise<void> {
  try {
    await api.post('/auth/logout');
  } catch (err) {
    // Already gone on the server (401) is the same outcome as a successful logout.
    if (!(err instanceof ApiError && err.status === 401)) {
      throw err;
    }
  }
  clearSession(false);
}

export function hasPermission(identity: Identity | undefined, permission: string): boolean {
  return identity?.permissions.some((grant) => grant.permission === permission) ?? false;
}

export function hasAnyPermission(identity: Identity | undefined, permissions: readonly string[]) {
  return permissions.some((permission) => hasPermission(identity, permission));
}

export function useAuth(): AuthState {
  const status = useStore(authStore, (s) => s.status);
  const identity = useStore(authStore, (s) => s.identity);
  const verified = useStore(authStore, (s) => s.verified);
  const expired = useStore(authStore, (s) => s.expired);
  return { status, identity, verified, expired };
}

/** UI hint only. The server enforces every permission and scope. */
export function useCan(...permissions: string[]): boolean {
  const identity = useStore(authStore, (s) => s.identity);
  return permissions.length === 0 || hasAnyPermission(identity, permissions);
}
