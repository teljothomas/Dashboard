import type { PullResponse, PushRequest, PushResultItem, SyncScope } from '@tradex/contracts';
import { uuidv7 } from '@tradex/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionStore } from '../lib/session';
import { getMeta, META, TradexOfflineDb } from './db';
import { discardEntry, enqueueMutation, retryEntry } from './outbox';
import { syncStatusStore } from './status';
import { BACKOFF_MS, createSyncEngine, type SyncEngine } from './syncEngine';

const fetchMock = vi.fn<typeof fetch>();

type PushHandler = (body: PushRequest) => Promise<PushResultItem[]> | PushResultItem[];
type PullHandler = (scope: SyncScope, cursor: number) => Promise<PullResponse> | PullResponse;

interface FakeServer {
  pushes: { body: PushRequest; headers: Headers }[];
  pulls: { scope: SyncScope; cursor: number }[];
  pushHandler: PushHandler;
  pullHandler: PullHandler;
  versions: Map<string, number>;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function applied(server: FakeServer, m: PushRequest['mutations'][number]): PushResultItem {
  const version = (server.versions.get(m.entityId) ?? 0) + 1;
  server.versions.set(m.entityId, version);
  return {
    mutationId: m.mutationId,
    result: 'APPLIED',
    entity: {
      id: m.entityId,
      version,
      status: null,
      number: m.op === 'CREATE' ? 'EXP-2026-00001' : null,
      syncStatus: 'SYNCED',
    },
  };
}

function installServer(): FakeServer {
  const server: FakeServer = {
    pushes: [],
    pulls: [],
    versions: new Map(),
    pushHandler: (body) => body.mutations.map((m) => applied(server, m)),
    pullHandler: (_scope, cursor) => ({ changes: [], nextCursor: cursor, hasMore: false }),
  };
  fetchMock.mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : '';
    if (url.endsWith('/sync/push')) {
      const body = JSON.parse(init?.body as string) as PushRequest;
      server.pushes.push({ body, headers: new Headers(init?.headers) });
      return json(200, { data: { results: await server.pushHandler(body) } });
    }
    const match = /\/sync\/pull\?scope=(\w+)&cursor=(\d+)&limit=(\d+)/.exec(url);
    if (match) {
      const scope = match[1] as SyncScope;
      const cursor = Number(match[2]);
      server.pulls.push({ scope, cursor });
      return json(200, { data: await server.pullHandler(scope, cursor) });
    }
    throw new Error(`unexpected request ${url}`);
  });
  return server;
}

let db: TradexOfflineDb;
let dbName: string;
let user: string | undefined;
let timers: { fn: () => void; ms: number }[];
let engine: SyncEngine;

function makeEngine(over: { db?: TradexOfflineDb; locks?: LockManager | null } = {}): SyncEngine {
  return createSyncEngine({
    db: over.db ?? db,
    getUserId: () => user,
    locks: over.locks === undefined ? null : over.locks,
    schedule: (fn, ms) => {
      timers.push({ fn, ms });
      return () => undefined;
    },
  });
}

let clock = 1_800_000_000_000;
function create(entityId = uuidv7(), payload: Record<string, unknown> = { amount: '10.00' }) {
  clock += 10;
  return enqueueMutation(db, {
    userId: 'u1',
    entityType: 'expense',
    entityId,
    op: 'CREATE',
    payload,
    now: clock,
  });
}
function update(entityId: string, payload: Record<string, unknown>) {
  clock += 10;
  return enqueueMutation(db, {
    userId: 'u1',
    entityType: 'expense',
    entityId,
    op: 'UPDATE',
    payload,
    now: clock,
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  dbName = `tradex-test-${uuidv7()}`;
  db = new TradexOfflineDb(dbName);
  user = 'u1';
  timers = [];
  engine = makeEngine();
  sessionStore.set({ csrfToken: undefined, userId: 'u1' });
  syncStatusStore.set({
    online: true,
    syncing: 0,
    needsAttention: 0,
    authPaused: false,
    lowStorage: false,
  });
  window.localStorage.clear();
});

afterEach(async () => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  db.close();
  await TradexOfflineDb.delete(dbName);
});

describe('offline create', () => {
  it('saves the record and the outbox entry together as LOCAL_ONLY, without any network call', async () => {
    const id = uuidv7();
    const entry = await create(id, { amount: '10.00', note: 'diesel' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(entry).toMatchObject({
      op: 'CREATE',
      state: 'PENDING',
      baseVersion: null,
      userId: 'u1',
    });
    const record = await db.records.get(['u1', 'expense', id]);
    expect(record).toMatchObject({
      status: 'LOCAL_ONLY',
      version: null,
      number: null,
      data: { amount: '10.00', note: 'diesel' },
    });
    expect(await db.outbox.count()).toBe(1);
  });

  it('is atomic: a rejected enqueue leaves neither record nor entry behind', async () => {
    const id = uuidv7();
    await create(id);
    await expect(create(id)).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    expect(await db.outbox.count()).toBe(1);
    expect(await db.records.count()).toBe(1);
  });

  it('refuses an UPDATE of a record this device has never seen unless a base version is given', async () => {
    await expect(update(uuidv7(), { note: 'x' })).rejects.toMatchObject({ code: 'UNKNOWN_RECORD' });
  });

  it('keeps FIFO order even when saves share a millisecond', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const entry = await enqueueMutation(db, {
        userId: 'u1',
        entityType: 'expense',
        entityId: uuidv7(),
        op: 'CREATE',
        payload: {},
        now: 1000,
      });
      ids.push(entry.mutationId);
    }
    const stored = await db.outbox.orderBy('createdAt').primaryKeys();
    expect(stored).toEqual(ids);
  });

  it('bootstraps one device id: meta, localStorage mirror, header and push body agree', async () => {
    const server = installServer();
    await create();
    await engine.trigger('manual');

    const sent = server.pushes[0];
    expect(sent).toBeDefined();
    const deviceId = sent?.body.deviceId;
    expect(deviceId).toBe(await getMeta(db, META.deviceId));
    expect(deviceId).toBe(window.localStorage.getItem('tradex.deviceId'));
    expect(sent?.headers.get('X-Device-Id')).toBe(deviceId);
  });
});

describe('acknowledgement', () => {
  it('APPLIED deletes the outbox entry and moves the record to SYNCED with the server number', async () => {
    const server = installServer();
    const id = uuidv7();
    await create(id);

    const run = await engine.trigger('manual');

    expect(run).toMatchObject({ status: 'ok', applied: 1 });
    expect(server.pushes).toHaveLength(1);
    expect(await db.outbox.count()).toBe(0);
    expect(await db.records.get(['u1', 'expense', id])).toMatchObject({
      status: 'SYNCED',
      version: 1,
      number: 'EXP-2026-00001',
    });
    expect(syncStatusStore.get()).toMatchObject({ syncing: 0, needsAttention: 0 });
  });

  it('shows the server part once acknowledged (AWAITING_APPROVAL)', async () => {
    const server = installServer();
    server.pushHandler = (body) =>
      body.mutations.map((m) => {
        const item = applied(server, m);
        return item.entity
          ? {
              ...item,
              entity: {
                ...item.entity,
                status: 'SUBMITTED',
                syncStatus: 'AWAITING_APPROVAL' as const,
              },
            }
          : item;
      });
    const id = uuidv7();
    await create(id);
    await engine.trigger('manual');
    expect((await db.records.get(['u1', 'expense', id]))?.status).toBe('AWAITING_APPROVAL');
  });

  it('sends the body as the contract requires (deviceId, FIFO fields, null baseVersion for CREATE)', async () => {
    const server = installServer();
    const id = uuidv7();
    await create(id, { amount: '5.00' });
    await engine.trigger('manual');
    const m = server.pushes[0]?.body.mutations[0];
    expect(m).toMatchObject({
      entityType: 'expense',
      entityId: id,
      op: 'CREATE',
      baseVersion: null,
      payload: { amount: '5.00' },
    });
    expect(typeof m?.clientCreatedAt).toBe('string');
  });
});

describe('conflict, rejection, transient results', () => {
  it('CONFLICT keeps the entry, flags REQUIRES_RECONCILIATION and stops that record only', async () => {
    const server = installServer();
    const a = uuidv7();
    const b = uuidv7();
    await create(a);
    await update(a, { note: 'later edit' }); // queued behind A's create
    await create(b);
    server.pushHandler = (body) =>
      body.mutations.map((m) =>
        m.entityId === a
          ? { mutationId: m.mutationId, result: 'CONFLICT' as const, conflictId: uuidv7() }
          : applied(server, m),
      );

    const run = await engine.trigger('manual');

    expect(run).toMatchObject({ status: 'ok', applied: 1, conflicts: 1 });
    expect(server.pushes).toHaveLength(1); // A's queued update was never sent
    expect(server.pushes[0]?.body.mutations.map((m) => m.entityId)).toEqual([a, b]);
    const all = await db.outbox.orderBy('createdAt').toArray();
    expect(all.map((e) => [e.entityId, e.op, e.state])).toEqual([
      [a, 'CREATE', 'CONFLICT'],
      [a, 'UPDATE', 'PENDING'],
    ]);
    expect((await db.records.get(['u1', 'expense', a]))?.status).toBe('REQUIRES_RECONCILIATION');
    expect((await db.records.get(['u1', 'expense', b]))?.status).toBe('SYNCED');
    expect(syncStatusStore.get().needsAttention).toBe(1);

    // A later run still sends nothing for A.
    await engine.trigger('manual');
    expect(server.pushes).toHaveLength(1);
  });

  it('REJECTED validation -> FAILED; RECORD_LOCKED -> REQUIRES_RECONCILIATION; entries kept', async () => {
    const server = installServer();
    const failed = uuidv7();
    const locked = uuidv7();
    await create(failed);
    await create(locked);
    server.pushHandler = (body) =>
      body.mutations.map((m) => ({
        mutationId: m.mutationId,
        result: 'REJECTED' as const,
        error:
          m.entityId === failed
            ? { code: 'VALIDATION_FAILED', message: 'amount required' }
            : { code: 'RECORD_LOCKED', message: 'approved' },
      }));

    const run = await engine.trigger('manual');

    expect(run).toMatchObject({ rejected: 2 });
    expect((await db.records.get(['u1', 'expense', failed]))?.status).toBe('FAILED');
    expect((await db.records.get(['u1', 'expense', locked]))?.status).toBe(
      'REQUIRES_RECONCILIATION',
    );
    expect(await db.outbox.count()).toBe(2);
    expect((await db.outbox.toArray()).every((e) => e.state === 'REJECTED')).toBe(true);
  });

  it.each(['DUPLICATE_SUSPECTED', 'BLOCKED_BY_PREVIOUS'] as const)(
    '%s is transient: kept PENDING, not resent in the same run, resent by the next',
    async (kind) => {
      const server = installServer();
      const id = uuidv7();
      await create(id);
      server.pushHandler = (body) =>
        body.mutations.map((m) => ({
          mutationId: m.mutationId,
          result: kind,
          error: { code: kind, message: 'try later' },
        }));

      const first = await engine.trigger('manual');

      expect(first).toMatchObject({ status: 'ok', applied: 0, deferred: 1 });
      expect(server.pushes).toHaveLength(1);
      const [entry] = await db.outbox.toArray();
      expect(entry).toMatchObject({ state: 'PENDING', attempts: 1 });
      expect((await db.records.get(['u1', 'expense', id]))?.status).toBe('LOCAL_ONLY');

      server.pushHandler = (body) => body.mutations.map((m) => applied(server, m));
      const second = await engine.trigger('manual');
      expect(second).toMatchObject({ applied: 1 });
      expect(server.pushes).toHaveLength(2);
      expect(server.pushes[1]?.body.mutations[0]?.mutationId).toBe(entry?.mutationId);
      expect(await db.outbox.count()).toBe(0);
    },
  );

  it('retryEntry and discardEntry release a blocked record; discarding a CREATE drops its dependents', async () => {
    const server = installServer();
    const a = uuidv7();
    await create(a);
    await update(a, { note: 'x' });
    server.pushHandler = (body) =>
      body.mutations.map((m) => ({
        mutationId: m.mutationId,
        result: 'REJECTED' as const,
        error: { code: 'VALIDATION_FAILED', message: 'bad' },
      }));
    await engine.trigger('manual');
    const [createEntry] = await db.outbox.orderBy('createdAt').toArray();
    expect(createEntry?.state).toBe('REJECTED');

    await retryEntry(db, createEntry?.mutationId ?? '');
    expect((await db.outbox.get(createEntry?.mutationId ?? ''))?.state).toBe('PENDING');
    expect((await db.records.get(['u1', 'expense', a]))?.status).toBe('LOCAL_ONLY');

    await engine.trigger('manual'); // rejected again
    await discardEntry(db, createEntry?.mutationId ?? '');
    expect(await db.outbox.count()).toBe(0);
    expect(await db.records.get(['u1', 'expense', a])).toBeUndefined();
  });
});

describe('ordering and batching', () => {
  it('sends 120 mutations FIFO in batches of 50, 50, 20', async () => {
    const server = installServer();
    const created: string[] = [];
    for (let i = 0; i < 120; i += 1) {
      created.push((await create()).mutationId);
    }

    const run = await engine.trigger('manual');

    expect(run.applied).toBe(120);
    expect(server.pushes.map((p) => p.body.mutations.length)).toEqual([50, 50, 20]);
    expect(server.pushes.flatMap((p) => p.body.mutations.map((m) => m.mutationId))).toEqual(
      created,
    );
  });

  it('sends one mutation per record per batch, rebasing each follow-up on the acknowledged version', async () => {
    const server = installServer();
    const id = uuidv7();
    await create(id);
    await update(id, { note: 'one' });
    await update(id, { note: 'two' });

    const run = await engine.trigger('manual');

    expect(run.applied).toBe(3);
    expect(server.pushes.map((p) => p.body.mutations.map((m) => [m.op, m.baseVersion]))).toEqual([
      [['CREATE', null]],
      [['UPDATE', 1]],
      [['UPDATE', 2]],
    ]);
    expect(await db.records.get(['u1', 'expense', id])).toMatchObject({
      version: 3,
      data: { amount: '10.00', note: 'two' },
      status: 'SYNCED',
    });
  });
});

describe('persistence', () => {
  it('survives a restart: a new database handle and engine send what the old one queued', async () => {
    const id = uuidv7();
    await create(id);
    db.close();

    const reopened = new TradexOfflineDb(dbName);
    expect(await reopened.outbox.count()).toBe(1);
    const server = installServer();
    const restarted = makeEngine({ db: reopened });
    const run = await restarted.trigger('start');

    expect(run).toMatchObject({ status: 'ok', applied: 1 });
    expect(server.pushes[0]?.body.mutations[0]?.entityId).toBe(id);
    expect(await reopened.outbox.count()).toBe(0);
    reopened.close();
    db = new TradexOfflineDb(dbName); // for afterEach cleanup
  });

  it('an entry left SENDING by a crash is resent with the same mutationId', async () => {
    const entry = await create();
    await db.outbox.update(entry.mutationId, { state: 'SENDING' });
    const server = installServer();

    const run = await engine.trigger('start');

    expect(run.applied).toBe(1);
    expect(server.pushes[0]?.body.mutations[0]?.mutationId).toBe(entry.mutationId);
  });
});

describe('single flight', () => {
  it('does not send twice when triggers arrive concurrently', async () => {
    const server = installServer();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inner = server.pushHandler;
    server.pushHandler = async (body) => {
      await gate;
      return inner(body);
    };
    await create();

    const runs = [
      engine.trigger('manual'),
      engine.trigger('local-save'),
      engine.trigger('online'),
      engine.syncNow(),
    ];
    // Let the first run reach the (blocked) push, then fire more triggers mid-flight.
    await vi.waitFor(() => {
      expect(server.pushes).toHaveLength(1);
    });
    runs.push(engine.trigger('interval'));
    release();
    const results = await Promise.all(runs);

    expect(server.pushes).toHaveLength(1);
    expect(results.every((r) => r.status === 'ok')).toBe(true);
    expect(await db.outbox.count()).toBe(0);
  });

  it('skips the run when another tab holds the Web Lock', async () => {
    const server = installServer();
    const locks = {
      request: vi.fn((_name: string, _opts: unknown, cb: (lock: unknown) => unknown) => cb(null)),
    } as unknown as LockManager;
    const locked = makeEngine({ locks });
    await create();

    const run = await locked.trigger('manual');

    expect(run.status).toBe('locked');
    expect(server.pushes).toHaveLength(0);
    expect(await db.outbox.count()).toBe(1);
  });

  it('runs inside the lock when it is granted', async () => {
    const server = installServer();
    const locks = {
      request: vi.fn((_name: string, _opts: unknown, cb: (lock: unknown) => unknown) =>
        cb({ name: 'tradex-sync', mode: 'exclusive' }),
      ),
    } as unknown as LockManager;
    const locked = makeEngine({ locks });
    await create();
    const run = await locked.trigger('manual');
    expect(run.status).toBe('ok');
    expect(server.pushes).toHaveLength(1);
  });
});

describe('failures and backoff', () => {
  it('backs off 5 s, 30 s, 2 min, 10 min, then stays at 10 min; entries survive with attempts counted', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const entry = await create();

    const statuses: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      statuses.push((await engine.trigger('retry')).status);
    }

    expect(statuses).toEqual(['error', 'error', 'error', 'error', 'error']);
    expect(timers.map((t) => t.ms)).toEqual([5_000, 30_000, 120_000, 600_000, 600_000]);
    expect(BACKOFF_MS).toEqual([5_000, 30_000, 120_000, 600_000]);
    const stored = await db.outbox.get(entry.mutationId);
    expect(stored).toMatchObject({ state: 'PENDING', attempts: 5 });
    expect((await db.records.get(['u1', 'expense', entry.entityId]))?.status).toBe('LOCAL_ONLY');
  });

  it('a successful run resets the backoff; the retry timer fires a run', async () => {
    const server = installServer();
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await create();

    expect((await engine.trigger('manual')).status).toBe('error');
    expect(timers.map((t) => t.ms)).toEqual([5_000]);

    timers[0]?.fn(); // the scheduled retry
    await vi.waitFor(async () => {
      expect(await db.outbox.count()).toBe(0);
    });
    expect(server.pushes).toHaveLength(1);

    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await create();
    expect((await engine.trigger('manual')).status).toBe('error');
    expect(timers.at(-1)?.ms).toBe(5_000);
  });

  it('interval and local-save triggers respect the backoff window; manual and online bypass it', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await create();
    await engine.trigger('manual');
    const server = installServer();

    expect((await engine.trigger('interval')).status).toBe('backoff');
    expect((await engine.trigger('local-save')).status).toBe('backoff');
    expect(server.pushes).toHaveLength(0);

    expect((await engine.trigger('online')).status).toBe('ok');
    expect(server.pushes).toHaveLength(1);
  });

  it('a 5xx response is a failure with backoff, not a rejection', async () => {
    fetchMock.mockResolvedValue(
      json(503, { error: { code: 'INTERNAL', message: 'down', requestId: 'r1' } }),
    );
    await create();
    const run = await engine.trigger('manual');
    expect(run.status).toBe('error');
    expect(timers).toHaveLength(1);
    expect((await db.outbox.toArray())[0]).toMatchObject({ state: 'PENDING', attempts: 1 });
  });

  it('a malformed push response keeps the entries and backs off', async () => {
    fetchMock.mockResolvedValue(json(200, { data: { nope: true } }));
    await create();
    const run = await engine.trigger('manual');
    expect(run.status).toBe('error');
    expect((await db.outbox.toArray())[0]).toMatchObject({ state: 'PENDING', attempts: 1 });
  });

  it('does nothing while the browser reports offline, except for a manual sync', async () => {
    const server = installServer();
    await create();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);

    expect((await engine.trigger('interval')).status).toBe('offline');
    expect((await engine.trigger('local-save')).status).toBe('offline');
    expect(server.pushes).toHaveLength(0);

    expect((await engine.trigger('manual')).status).toBe('ok');
    expect(server.pushes).toHaveLength(1);
  });

  it('does nothing without a session', async () => {
    const server = installServer();
    await create();
    user = undefined;
    expect((await engine.trigger('manual')).status).toBe('no-session');
    expect(server.pushes).toHaveLength(0);
  });

  it('sends and pulls nothing while the session has no credentials (offline start), then runs once it has (REV-04)', async () => {
    const server = installServer();
    const entry = await create();
    let credentials = false;
    const guarded = createSyncEngine({
      db,
      getUserId: () => user,
      hasCredentials: () => credentials,
      locks: null,
      schedule: (fn, ms) => {
        timers.push({ fn, ms });
        return () => undefined;
      },
    });

    for (const reason of ['start', 'online', 'manual', 'retry'] as const) {
      expect((await guarded.trigger(reason)).status).toBe('no-session');
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(server.pushes).toHaveLength(0);
    expect(server.pulls).toHaveLength(0);
    // Not a failed attempt: no counter, no error, no backoff, no pause.
    const row = await db.outbox.get(entry.mutationId);
    expect(row?.attempts).toBe(0);
    expect(row?.lastError).toBeNull();
    expect(row?.state).toBe('PENDING');
    expect(guarded.isPaused()).toBe(false);

    credentials = true;
    expect((await guarded.trigger('online')).status).toBe('ok');
    expect(server.pushes).toHaveLength(1);
  });
});

describe('401 pause', () => {
  it('pauses without counting an attempt, sends nothing more, and resumes after sign-in', async () => {
    const server = installServer();
    const entry = await create();
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        json(401, { error: { code: 'UNAUTHENTICATED', message: 'expired', requestId: 'r1' } }),
      ),
    );

    const run = await engine.trigger('manual');

    expect(run.status).toBe('paused');
    expect(engine.isPaused()).toBe(true);
    expect(engine.pausedFor()).toBe('u1');
    expect(syncStatusStore.get().authPaused).toBe(true);
    expect(timers).toHaveLength(0); // no blind retry
    expect(await db.outbox.get(entry.mutationId)).toMatchObject({ state: 'PENDING', attempts: 0 });

    const callsBefore = fetchMock.mock.calls.length;
    expect((await engine.trigger('manual')).status).toBe('paused');
    expect(fetchMock.mock.calls.length).toBe(callsBefore);

    const resumed = await engine.resume();
    expect(resumed).toMatchObject({ status: 'ok', applied: 1 });
    expect(engine.isPaused()).toBe(false);
    expect(syncStatusStore.get().authPaused).toBe(false);
    expect(server.pushes).toHaveLength(1);
  });

  it('pauses on a 401 from pull as well', async () => {
    installServer();
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        json(401, { error: { code: 'UNAUTHENTICATED', message: 'expired', requestId: 'r1' } }),
      ),
    );
    expect((await engine.trigger('manual')).status).toBe('paused');
  });

  it('never sends one user’s outbox under another user’s session', async () => {
    const server = installServer();
    await create(); // u1's entry
    user = 'u2';
    const run = await engine.trigger('manual');
    expect(run.status).toBe('ok');
    expect(server.pushes).toHaveLength(0);
    expect(await db.outbox.count()).toBe(1);

    user = 'u1';
    expect((await engine.trigger('manual')).applied).toBe(1);
  });
});

describe('pull', () => {
  const change = (n: number, over: Record<string, unknown> = {}) => ({
    entityType: 'expense',
    entityId: uuidv7(),
    syncSeq: n,
    deleted: false,
    data: {
      id: 'x',
      version: 2,
      status: 'SUBMITTED',
      number: `EXP-${n}`,
      syncStatus: 'AWAITING_APPROVAL',
      ...over,
    },
  });

  it('stores mine changes as records, pages through hasMore, and persists the cursor per user', async () => {
    const server = installServer();
    const c1 = change(1);
    const c2 = change(2);
    const c3 = change(3);
    server.pullHandler = (scope, cursor) => {
      if (scope === 'reference') return { changes: [], nextCursor: cursor, hasMore: false };
      if (cursor === 0) return { changes: [c1, c2], nextCursor: 2, hasMore: true };
      return { changes: [c3], nextCursor: 3, hasMore: false };
    };

    const run = await engine.trigger('manual');

    expect(run).toMatchObject({ status: 'ok', pulled: 3 });
    expect(server.pulls.filter((p) => p.scope === 'mine').map((p) => p.cursor)).toEqual([0, 2]);
    expect(await db.records.count()).toBe(3);
    expect(await db.records.get(['u1', 'expense', c1.entityId])).toMatchObject({
      version: 2,
      number: 'EXP-1',
      serverStatus: 'SUBMITTED',
      status: 'AWAITING_APPROVAL',
    });
    expect(await getMeta(db, META.cursor('mine', 'u1'))).toBe(3);
    expect(await getMeta(db, META.cursor('mine', 'u2'))).toBeUndefined();

    server.pulls.length = 0;
    await engine.trigger('manual');
    expect(server.pulls.find((p) => p.scope === 'mine')?.cursor).toBe(3);
  });

  it('does not overwrite a record with pending mutations: the server copy goes to serverShadow', async () => {
    const server = installServer();
    const id = uuidv7();
    await create(id, { amount: '10.00' });
    server.pushHandler = (body) =>
      body.mutations.map((m) => ({
        mutationId: m.mutationId,
        result: 'CONFLICT' as const,
        conflictId: uuidv7(),
      }));
    server.pullHandler = (scope, cursor) =>
      scope === 'mine' && cursor === 0
        ? {
            changes: [
              {
                entityType: 'expense',
                entityId: id,
                syncSeq: 7,
                deleted: false,
                data: { id, version: 5, amount: '99.00' },
              },
            ],
            nextCursor: 7,
            hasMore: false,
          }
        : { changes: [], nextCursor: cursor, hasMore: false };

    await engine.trigger('manual');

    expect((await db.records.get(['u1', 'expense', id]))?.data).toMatchObject({ amount: '10.00' });
    expect(await db.serverShadow.get(['u1', 'expense', id])).toMatchObject({
      version: 5,
      data: { amount: '99.00' },
    });
    expect(await getMeta(db, META.cursor('mine', 'u1'))).toBe(7);
  });

  it('removes records the server reports as deleted, and drops the reference copy', async () => {
    const server = installServer();
    const keep = change(1);
    const gone = change(2);
    const ref = {
      entityType: 'vehicle',
      entityId: uuidv7(),
      syncSeq: 1,
      deleted: false,
      data: { id: 'v', name: 'MH-01' },
    };
    server.pullHandler = (scope, cursor) => {
      if (scope === 'reference') {
        return cursor === 0
          ? { changes: [ref], nextCursor: 1, hasMore: false }
          : { changes: [{ ...ref, syncSeq: 2, deleted: true }], nextCursor: 2, hasMore: false };
      }
      return cursor === 0
        ? { changes: [keep, gone], nextCursor: 2, hasMore: false }
        : { changes: [{ ...gone, syncSeq: 3, deleted: true }], nextCursor: 3, hasMore: false };
    };

    await engine.trigger('manual');
    expect(await db.records.count()).toBe(2);
    expect(await db.reference.get(['u1', 'vehicle', ref.entityId])).toMatchObject({
      data: { name: 'MH-01' },
    });

    await engine.trigger('manual');
    expect(await db.records.get(['u1', 'expense', gone.entityId])).toBeUndefined();
    expect(await db.records.get(['u1', 'expense', keep.entityId])).toBeDefined();
    expect(await db.reference.count()).toBe(0);
  });

  it('pushes before it pulls', async () => {
    const server = installServer();
    const order: string[] = [];
    const push = server.pushHandler;
    server.pushHandler = (body) => {
      order.push('push');
      return push(body);
    };
    server.pullHandler = (scope, cursor) => {
      order.push(`pull:${scope}`);
      return { changes: [], nextCursor: cursor, hasMore: false };
    };
    await create();
    await engine.trigger('manual');
    expect(order).toEqual(['push', 'pull:mine', 'pull:reference']);
  });
});

describe('start', () => {
  it('runs once at start, on the online event and on the interval; the cleanup stops them', async () => {
    const server = installServer();
    await create();
    const stop = engine.start();
    await vi.waitFor(() => {
      expect(server.pushes).toHaveLength(1);
    });

    await create();
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => {
      expect(server.pushes).toHaveLength(2);
    });

    await create();
    const tick = timers.at(-1);
    expect(tick?.ms).toBe(60_000);
    tick?.fn();
    await vi.waitFor(() => {
      expect(server.pushes).toHaveLength(3);
    });

    stop();
    await create();
    window.dispatchEvent(new Event('online'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.pushes).toHaveLength(3);
  });
});

describe('session change during a run', () => {
  it('discards a pull response fetched after the user changed, and stores nothing', async () => {
    const server = installServer();
    server.pullHandler = (scope, cursor) => {
      user = 'u2'; // sign-in as someone else while the request is in flight
      return {
        changes: [
          {
            entityType: 'expense',
            entityId: uuidv7(),
            syncSeq: 1,
            deleted: false,
            data: { id: 'x', version: 1 },
          },
        ],
        nextCursor: scope === 'mine' ? 1 : cursor,
        hasMore: false,
      };
    };

    const run = await engine.trigger('manual');

    expect(run.status).toBe('session-changed');
    expect(await db.records.count()).toBe(0);
    expect(await getMeta(db, META.cursor('mine', 'u1'))).toBeUndefined();
    expect(timers).toHaveLength(0); // not a failure: no backoff
  });
});

describe('shared device', () => {
  it('keeps each user records, shadows, reference rows and cursors apart', async () => {
    const server = installServer();
    const shared = uuidv7();
    const row = (data: Record<string, unknown>) => ({
      entityType: 'expense',
      entityId: shared,
      syncSeq: 1,
      deleted: false,
      data,
    });
    server.pullHandler = (scope, cursor) => {
      if (scope === 'reference') {
        return {
          changes: [
            {
              entityType: 'vehicle',
              entityId: shared,
              syncSeq: 1,
              deleted: false,
              data: { id: 'v', owner: user },
            },
          ],
          nextCursor: 1,
          hasMore: false,
        };
      }
      return cursor === 0
        ? { changes: [row({ id: 'x', version: 1, owner: user })], nextCursor: 1, hasMore: false }
        : { changes: [], nextCursor: cursor, hasMore: false };
    };

    await engine.trigger('manual'); // u1
    user = 'u2';
    await engine.trigger('manual'); // u2 starts from its own cursor 0 and gets its own rows

    expect(await db.records.get(['u1', 'expense', shared])).toMatchObject({
      data: { owner: 'u1' },
    });
    expect(await db.records.get(['u2', 'expense', shared])).toMatchObject({
      data: { owner: 'u2' },
    });
    expect(await db.reference.get(['u1', 'vehicle', shared])).toMatchObject({
      data: { owner: 'u1' },
    });
    expect(await db.reference.get(['u2', 'vehicle', shared])).toMatchObject({
      data: { owner: 'u2' },
    });
    expect(await getMeta(db, META.cursor('mine', 'u1'))).toBe(1);
    expect(await getMeta(db, META.cursor('mine', 'u2'))).toBe(1);
    expect(await getMeta(db, META.cursor('reference', 'u2'))).toBe(1);
  });

  it('counts and status are per user: pending items of another user is not shown or touched', async () => {
    installServer();
    const id = uuidv7();
    await create(id); // u1, never synced
    user = 'u2';
    await engine.trigger('manual');
    expect(syncStatusStore.get().syncing).toBe(0);
    expect(await db.records.get(['u2', 'expense', id])).toBeUndefined();
    expect((await db.records.get(['u1', 'expense', id]))?.status).toBe('LOCAL_ONLY');
  });
});
