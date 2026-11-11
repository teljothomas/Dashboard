import { uuidv7 } from '@tradex/domain';
import { createStore } from './store';

/**
 * In-memory session data. The CSRF token is never persisted (SECURITY §4): it is returned by
 * /auth/me after every page load and lives only in this store.
 */
export const sessionStore = createStore<{
  csrfToken: string | undefined;
  /** Signed-in user id. Set by the auth flow (Phase 04); the offline outbox tags every mutation with it. */
  userId: string | undefined;
}>({
  csrfToken: undefined,
  userId: undefined,
});

const DEVICE_ID_KEY = 'tradex.deviceId';
let memoryDeviceId: string | undefined;

/** Stable per-browser id sent as `X-Device-Id`. Falls back to memory when storage is unavailable. */
export function getDeviceId(): string {
  try {
    const existing = window.localStorage.getItem(DEVICE_ID_KEY);
    if (existing) {
      return existing;
    }
    const created = uuidv7();
    window.localStorage.setItem(DEVICE_ID_KEY, created);
    return created;
  } catch {
    memoryDeviceId ??= uuidv7();
    return memoryDeviceId;
  }
}

/** Adopt an id read from the offline `meta` store so the header and the push body never disagree. */
export function setDeviceId(id: string): void {
  memoryDeviceId = id;
  try {
    window.localStorage.setItem(DEVICE_ID_KEY, id);
  } catch {
    // Storage unavailable: the in-memory copy is used by getDeviceId only when storage also fails to read.
  }
}
