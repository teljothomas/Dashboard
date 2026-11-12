import {
  MAX_PULL_LIMIT,
  MAX_PUSH_MUTATIONS,
  PullResponse,
  PushResponse,
  type PullChange,
  type PushRequest,
  type SyncScope,
} from '@tradex/contracts';
import { api, ApiError } from '../lib/api';
import { ensureDeviceId, getMeta, META, setMeta, type TradexOfflineDb } from './db';
import {
  applyPushResults,
  entriesOf,
  markSending,
  nextBatch,
  outboxCounts,
  readServerFields,
  refreshRecordStatus,
  releaseSending,
  resetOrphanedSending,
} from './outbox';
import { syncStatusStore } from './status';

/** Backoff after network or server errors (OFFLINE_DESIGN section 4): 5 s, 30 s, 2 min, 10 min (cap). */
export const BACKOFF_MS = [5_000, 30_000, 120_000, 600_000] as const;
export const SYNC_INTERVAL_MS = 60_000;
/** Warn when less than this much browser storage is free. */
export const LOW_STORAGE_BYTES = 50 * 1024 * 1024;
const LOCK_NAME = 'tradex-sync';
/** Safety valve: pages per scope per run. 200 x 500 changes is far beyond a normal catch-up. */
const MAX_PULL_PAGES = 200;

export type SyncTrigger = 'start' | 'online' | 'interval' | 'local-save' | 'manual' | 'retry';

export interface SyncTransport {
  /** Resolves with the `data` body of the `{ data }` envelope. */
  push(body: PushRequest): Promise<unknown>;
  pull(scope: SyncScope, cursor: number, limit: number): Promise<unknown>;
}

export const apiTransport: SyncTransport = {
  push: async (body) => (await api.post<unknown>('/sync/push', body)).data,
  pull: async (scope, cursor, limit) =>
    (await api.get<unknown>(`/sync/pull?scope=${scope}&cursor=${cursor}&limit=${limit}`)).data,
};

export type SyncRunStatus =
  'ok' | 'error' | 'paused' | 'no-session' | 'offline' | 'backoff' | 'locked' | 'session-changed';

export interface SyncRunResult {
  status: SyncRunStatus;
  applied: number;
  conflicts: number;
  rejected: number;
  /** Mutations that came back transient and wait for a later run. */
  deferred: number;
  pulled: number;
  error?: string;
}

export interface SyncEngineOptions {
  db: TradexOfflineDb;
  /** Current session user. Undefined = signed out: nothing is sent. */
  getUserId: () => string | undefined;
  /**
   * False while the session cannot authorize a write yet (an offline start has no CSRF token until
   * `/auth/me` answers). Nothing is sent or pulled then, no attempt is counted and no backoff set:
   * the run is simply skipped and the verify step triggers a new one (REV-04 finding 3).
   * Default: always true.
   */
  hasCredentials?: () => boolean;
  transport?: SyncTransport;
  now?: () => number;
  /** One-shot timer; returns its canceller. Injectable so tests never wait. */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** Web Locks manager, or null to force the in-process flag. Default: `navigator.locks`. */
  locks?: LockManager | null;
  batchSize?: number;
  intervalMs?: number;
}

export interface SyncEngine {
  /** Request a run. Concurrent requests coalesce into the run in flight (plus one follow-up run). */
  trigger(reason: SyncTrigger): Promise<SyncRunResult>;
  /** Manual "Sync now": bypasses backoff. */
  syncNow(): Promise<SyncRunResult>;
  /** Register online/visibility/interval triggers and run once. Returns a cleanup function. */
  start(): () => void;
  /**
   * After sign-in following a 401 pause. Only mutations of the signed-in user are ever sent
   * (`nextBatch` filters by user), so a different user signing in never uploads the paused user's data.
   */
  resume(): Promise<SyncRunResult>;
  isPaused(): boolean;
  /** User the engine paused for (401), if paused. */
  pausedFor(): string | undefined;
}

const EMPTY: SyncRunResult = {
  status: 'ok',
  applied: 0,
  conflicts: 0,
  rejected: 0,
  deferred: 0,
  pulled: 0,
};

function result(patch: Partial<SyncRunResult>): SyncRunResult {
  return { ...EMPTY, ...patch };
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const handle = setTimeout(fn, ms);
  return () => {
    clearTimeout(handle);
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The signed-in user changed while a run was in flight: stop, never send or store under the wrong user. */
class SessionChanged extends Error {
  constructor() {
    super('Session changed during sync');
    this.name = 'SessionChanged';
  }
}

class AuthExpired extends Error {
  constructor() {
    super('Session expired');
    this.name = 'AuthExpired';
  }
}

export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  const { db, getUserId } = options;
  const hasCredentials = options.hasCredentials ?? (() => true);
  const transport = options.transport ?? apiTransport;
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule ?? defaultSchedule;
  const batchSize = Math.min(options.batchSize ?? MAX_PUSH_MUTATIONS, MAX_PUSH_MUTATIONS);
  const intervalMs = options.intervalMs ?? SYNC_INTERVAL_MS;
  const locks =
    options.locks !== undefined
      ? options.locks
      : typeof navigator !== 'undefined' && 'locks' in navigator
        ? navigator.locks
        : null;

  let inflight: Promise<SyncRunResult> | null = null;
  let rerun = false;
  let rerunReason: SyncTrigger = 'local-save';
  let paused = false;
  let pausedUserId: string | undefined;
  let failures = 0;
  let nextAttemptAt = 0;
  let cancelRetry: (() => void) | undefined;

  async function refreshCounts(): Promise<void> {
    const userId = getUserId();
    if (userId === undefined) {
      syncStatusStore.set({ syncing: 0, needsAttention: 0 });
      return;
    }
    const counts = await outboxCounts(db, userId);
    syncStatusStore.set({ syncing: counts.syncing, needsAttention: counts.needsAttention });
  }

  function clearRetry(): void {
    cancelRetry?.();
    cancelRetry = undefined;
  }

  function scheduleRetry(): void {
    clearRetry();
    const delay = BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)] ?? BACKOFF_MS[0];
    nextAttemptAt = now() + delay;
    cancelRetry = schedule(() => {
      cancelRetry = undefined;
      void trigger('retry');
    }, delay);
  }

  function failure(err: unknown, totals: SyncRunResult): SyncRunResult {
    failures += 1;
    scheduleRetry();
    return { ...totals, status: 'error', error: errorMessage(err) };
  }

  /** 401 anywhere: pause until sign-in; never retry blindly with a dead session. */
  function pause(userId: string): SyncRunResult {
    paused = true;
    pausedUserId = userId;
    clearRetry();
    syncStatusStore.set({ authPaused: true });
    return result({ status: 'paused' });
  }

  async function push(userId: string, totals: SyncRunResult): Promise<void> {
    const deviceId = await ensureDeviceId(db);
    const deferred = new Set<string>();
    for (;;) {
      const ready = await nextBatch(db, userId, batchSize, deferred);
      if (ready.length === 0) {
        return;
      }
      const sent = ready.map((r) => r.entry);
      const ids = sent.map((e) => e.mutationId);
      await markSending(db, ids);
      await refreshCounts();
      if (getUserId() !== userId) {
        // The cookie now belongs to someone else: these entries must not be sent with it.
        await releaseSending(db, ids, { countAttempt: false });
        throw new SessionChanged();
      }

      let body: unknown;
      try {
        body = await transport.push({
          deviceId,
          mutations: ready.map(({ entry, baseVersion }) => ({
            mutationId: entry.mutationId,
            entityType: entry.entityType,
            entityId: entry.entityId,
            op: entry.op,
            baseVersion,
            clientCreatedAt: entry.clientCreatedAt,
            payload: entry.payload,
          })),
        });
      } catch (err) {
        const unauthorized = err instanceof ApiError && err.status === 401;
        await releaseSending(db, ids, {
          countAttempt: !unauthorized,
          ...(unauthorized ? {} : { error: { code: 'PUSH_FAILED', message: errorMessage(err) } }),
        });
        if (unauthorized) {
          throw new AuthExpired();
        }
        throw err;
      }

      const parsed = PushResponse.safeParse(body);
      if (!parsed.success) {
        await releaseSending(db, ids, {
          countAttempt: true,
          error: { code: 'BAD_RESPONSE', message: 'Malformed push response' },
        });
        throw new Error('Malformed push response');
      }

      const outcome = await applyPushResults(db, sent, parsed.data.results);
      totals.applied += outcome.applied;
      totals.conflicts += outcome.conflicts;
      totals.rejected += outcome.rejected;
      for (const id of outcome.transient) {
        deferred.add(id);
      }
      totals.deferred = deferred.size;
      await setMeta(db, META.lastPushAt, now());
      await refreshCounts();
    }
  }

  async function applyPullPage(
    userId: string,
    scope: SyncScope,
    changes: readonly PullChange[],
    cursorKey: string,
    nextCursor: number,
  ): Promise<void> {
    await db.transaction(
      'rw',
      db.records,
      db.serverShadow,
      db.reference,
      db.outbox,
      db.meta,
      async () => {
        for (const change of changes) {
          const key: [string, string, string] = [userId, change.entityType, change.entityId];
          if (scope === 'reference') {
            if (change.deleted) {
              await db.reference.delete(key);
            } else {
              await db.reference.put({
                userId,
                entityType: change.entityType,
                id: change.entityId,
                data: change.data,
                syncSeq: change.syncSeq,
              });
            }
            continue;
          }

          const pending = (await entriesOf(db, userId, change.entityType, change.entityId)).length;
          const fields = readServerFields(change.data);
          if (pending > 0) {
            // Local edits win until their mutations resolve: keep the server copy aside (SYNC_DESIGN 2.2).
            if (change.deleted) {
              await db.serverShadow.delete(key);
            } else {
              await db.serverShadow.put({
                userId,
                entityType: change.entityType,
                id: change.entityId,
                version: fields.version,
                data: change.data,
                syncSeq: change.syncSeq,
              });
            }
            continue;
          }
          // Archived/revoked rows leave the device.
          await db.serverShadow.delete(key);
          if (change.deleted) {
            await db.records.delete(key);
            continue;
          }
          await db.records.put({
            userId,
            entityType: change.entityType,
            id: change.entityId,
            version: fields.version,
            serverStatus: fields.serverStatus,
            serverSyncStatus: fields.serverSyncStatus,
            number: fields.number,
            data: change.data,
            status: 'SYNCED',
            updatedAt: now(),
          });
          await refreshRecordStatus(db, userId, change.entityType, change.entityId);
        }
        await setMeta(db, cursorKey, nextCursor);
      },
    );
  }

  async function pullScope(scope: SyncScope, userId: string, totals: SyncRunResult): Promise<void> {
    const cursorKey = META.cursor(scope, userId);
    let cursor = (await getMeta<number>(db, cursorKey)) ?? 0;
    for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
      let body: unknown;
      try {
        body = await transport.pull(scope, cursor, MAX_PULL_LIMIT);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          throw new AuthExpired();
        }
        throw err;
      }
      if (getUserId() !== userId) {
        throw new SessionChanged();
      }
      const parsed = PullResponse.safeParse(body);
      if (!parsed.success) {
        throw new Error('Malformed pull response');
      }
      const { changes, nextCursor, hasMore } = parsed.data;
      if (hasMore && nextCursor <= cursor) {
        throw new Error('Pull cursor did not advance');
      }
      await applyPullPage(userId, scope, changes, cursorKey, Math.max(nextCursor, cursor));
      totals.pulled += changes.length;
      cursor = Math.max(nextCursor, cursor);
      if (!hasMore) {
        await setMeta(db, META.lastPullAt, now());
        return;
      }
    }
    throw new Error('Pull did not finish within the page limit');
  }

  async function runOnce(): Promise<SyncRunResult> {
    const userId = getUserId();
    if (userId === undefined) {
      return result({ status: 'no-session' });
    }
    const totals = result({});
    try {
      await resetOrphanedSending(db);
      // Attachment upload is a placeholder until the attachment WPs: mutations that depend on a queued
      // attachment simply wait (see `nextBatch`).
      await push(userId, totals);
      await pullScope('mine', userId, totals);
      await pullScope('reference', userId, totals);
      failures = 0;
      nextAttemptAt = 0;
      clearRetry();
      await refreshCounts();
      return totals;
    } catch (err) {
      await refreshCounts().catch(() => undefined);
      if (err instanceof SessionChanged) {
        return { ...totals, status: 'session-changed' };
      }
      if (err instanceof AuthExpired) {
        return pause(userId);
      }
      return failure(err, totals);
    }
  }

  async function guardedRun(reason: SyncTrigger): Promise<SyncRunResult> {
    if (paused) {
      return result({ status: 'paused' });
    }
    if (getUserId() === undefined || !hasCredentials()) {
      return result({ status: 'no-session' });
    }
    const forced = reason === 'manual' || reason === 'online' || reason === 'retry';
    if (!forced && now() < nextAttemptAt) {
      return result({ status: 'backoff' });
    }
    if (reason !== 'manual' && typeof navigator !== 'undefined' && !navigator.onLine) {
      return result({ status: 'offline' });
    }
    if (locks === null) {
      return runOnce();
    }
    // Cross-tab single flight: a tab that cannot take the lock skips; the holder syncs for everyone.
    const outcome = await locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) =>
      lock === null ? result({ status: 'locked' }) : runOnce(),
    );
    return outcome;
  }

  function trigger(reason: SyncTrigger): Promise<SyncRunResult> {
    if (inflight !== null) {
      // A local save during a run may have been missed by the batch read: one follow-up run.
      rerun = true;
      rerunReason = reason;
      return inflight;
    }
    const loop = async (): Promise<SyncRunResult> => {
      let latest: SyncRunResult;
      let currentReason = reason;
      do {
        rerun = false;
        latest = await guardedRun(currentReason);
        currentReason = rerunReason;
      } while (rerun && latest.status === 'ok');
      return latest;
    };
    inflight = loop().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function checkStorage(): Promise<void> {
    if (typeof navigator === 'undefined' || navigator.storage === undefined) {
      return;
    }
    try {
      await navigator.storage.persist?.();
      const estimate = await navigator.storage.estimate?.();
      if (estimate?.quota !== undefined && estimate.usage !== undefined) {
        syncStatusStore.set({ lowStorage: estimate.quota - estimate.usage < LOW_STORAGE_BYTES });
      }
    } catch {
      // Storage APIs are best effort.
    }
  }

  return {
    trigger,
    syncNow: () => trigger('manual'),
    isPaused: () => paused,
    pausedFor: () => (paused ? pausedUserId : undefined),
    resume() {
      paused = false;
      pausedUserId = undefined;
      syncStatusStore.set({ authPaused: false });
      return trigger('manual');
    },
    start() {
      void checkStorage();
      void trigger('start');
      const onOnline = (): void => {
        void trigger('online');
      };
      const onVisible = (): void => {
        if (document.visibilityState === 'visible') {
          void trigger('interval');
        }
      };
      window.addEventListener('online', onOnline);
      document.addEventListener('visibilitychange', onVisible);

      let cancelTick: (() => void) | undefined;
      let stopped = false;
      const tick = (): void => {
        cancelTick = schedule(() => {
          if (stopped) {
            return;
          }
          if (document.visibilityState === 'visible' && navigator.onLine) {
            void trigger('interval');
          }
          tick();
        }, intervalMs);
      };
      tick();

      return () => {
        stopped = true;
        cancelTick?.();
        clearRetry();
        window.removeEventListener('online', onOnline);
        document.removeEventListener('visibilitychange', onVisible);
      };
    },
  };
}
