import { uuidv7 } from '@tradex/domain';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, resetDatabase, testDbUrls, truncateAll } from '../../../test/db.js';
import { headerContextProvider } from '../../../test/requestContext.js';
import { createSyncTestTables, registerTestEntities } from '../../../test/syncEntities.js';
import { buildApp } from '../../app.js';
import { createDatabase, type Database } from '../../db/index.js';
import { runMigrations } from '../../db/migrate.js';
import { testConfig } from '../../test-config.js';
import { SYNC_WRITE_LOCK_KEY } from './locks.js';
import { clearEntities, registerEntity } from './registry.js';
import type { SyncEntityHandler } from './types.js';

const urls = testDbUrls();
const USER = '01930000-0000-7000-8000-000000001001';
const OTHER = '01930000-0000-7000-8000-000000002002';
const DEVICE = '01930000-0000-7000-8000-00000000a001';
const APPROVER_PERMS = 'expense.approve';

let db: Database;
let owner: pg.Pool;
let app: FastifyInstance;

beforeAll(async () => {
  await resetDatabase(urls);
  await runMigrations(urls.owner, MIGRATIONS_DIR);
  db = createDatabase(urls.app);
  owner = new pg.Pool({ connectionString: urls.owner, max: 4 });
  await createSyncTestTables(owner);
});

beforeEach(async () => {
  await truncateAll(urls);
  clearEntities();
  registerTestEntities();
  app = buildApp(testConfig, { db, requestContext: headerContextProvider });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await db.destroy();
  await owner.end();
});

function as(user: string, permissions?: string): Record<string, string> {
  return {
    'x-test-user': user,
    'x-test-device': DEVICE,
    ...(permissions ? { 'x-test-permissions': permissions } : {}),
  };
}

interface Mut {
  mutationId: string;
  entityType: string;
  entityId: string;
  op: string;
  baseVersion: number | null;
  clientCreatedAt: string;
  payload: Record<string, unknown>;
}

function mut(overrides: Partial<Mut> & Pick<Mut, 'entityId' | 'op'>): Mut {
  return {
    mutationId: uuidv7(),
    entityType: 'test_note',
    baseVersion: null,
    clientCreatedAt: new Date().toISOString(),
    payload: {},
    ...overrides,
  };
}

function create(entityId: string, payload: Record<string, unknown> = {}): Mut {
  return mut({
    entityId,
    op: 'CREATE',
    payload: { title: 'first', amount: '10.00', ...payload },
  });
}

function update(
  entityId: string,
  baseVersion: number | null,
  payload: Record<string, unknown>,
): Mut {
  return mut({ entityId, op: 'UPDATE', baseVersion, payload });
}

function push(
  mutations: Mut[],
  headers: Record<string, string> = as(USER),
  deviceId = DEVICE,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/api/v1/sync/push',
    payload: { deviceId, mutations },
    headers,
  });
}

interface ResultItem {
  mutationId: string;
  result: string;
  entity?: { id: string; version: number; status: string | null; syncStatus: string };
  conflictId?: string;
  error?: { code: string; message: string };
}

async function pushOk(mutations: Mut[], headers?: Record<string, string>): Promise<ResultItem[]> {
  const res = await push(mutations, headers);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ data: { results: ResultItem[] } }>().data.results;
}

async function pushOne(m: Mut, headers?: Record<string, string>): Promise<ResultItem> {
  const results = await pushOk([m], headers);
  return results[0] as ResultItem;
}

interface PullChange {
  entityType: string;
  entityId: string;
  syncSeq: number;
  deleted: boolean;
  data: Record<string, unknown>;
}
interface PullData {
  changes: PullChange[];
  nextCursor: number;
  hasMore: boolean;
}

async function pull(query: string, headers: Record<string, string> = as(USER)): Promise<PullData> {
  const res = await app.inject({ method: 'GET', url: `/api/v1/sync/pull?${query}`, headers });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ data: PullData }>().data;
}

async function count(table: string, where = 'true'): Promise<number> {
  const r = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${table} WHERE ${where}`,
  );
  return Number(r.rows[0]?.n);
}

async function dbRows(text: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const r = await owner.query<Record<string, unknown>>(text, params);
  return r.rows;
}

async function dbRow(text: string, params: unknown[] = []): Promise<Record<string, unknown>> {
  return (await dbRows(text, params))[0] ?? {};
}

function noteRow(id: string): Promise<Record<string, unknown>> {
  return dbRow(`SELECT * FROM test_note WHERE id = $1`, [id]);
}

describe('push: authentication and framing', () => {
  it('answers 401 without a request context on every sync route', async () => {
    const calls = [
      { method: 'POST', url: '/api/v1/sync/push', payload: { deviceId: DEVICE, mutations: [] } },
      { method: 'GET', url: '/api/v1/sync/pull?scope=mine' },
      { method: 'GET', url: '/api/v1/sync/conflicts' },
      { method: 'POST', url: `/api/v1/sync/conflicts/${uuidv7()}/resolve`, payload: {} },
    ] as const;
    for (const call of calls) {
      const res = await app.inject(call);
      expect(res.statusCode, call.url).toBe(401);
      expect(res.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    }
  });

  it('refuses a body deviceId that differs from the session device', async () => {
    const res = await push([create(uuidv7())], as(USER), uuidv7());
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('refuses a push from a session that is not bound to a device', async () => {
    const res = await push([create(uuidv7())], { 'x-test-user': USER });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(await count('client_mutation')).toBe(0);
    expect(await count('test_note')).toBe(0);
  });

  it('accepts 50 mutations and rejects 51 with VALIDATION_FAILED', async () => {
    const fifty = Array.from({ length: 50 }, () => create(uuidv7()));
    const results = await pushOk(fifty);
    expect(results).toHaveLength(50);
    expect(results.every((r) => r.result === 'APPLIED')).toBe(true);
    expect(await count('test_note')).toBe(50);

    const res = await push([
      ...fifty.slice(0, 1),
      ...Array.from({ length: 50 }, () => create(uuidv7())),
    ]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    expect(await count('test_note')).toBe(50);
  });

  it('rejects an empty batch and a malformed mutation with VALIDATION_FAILED', async () => {
    expect((await push([])).statusCode).toBe(400);
    const bad = { ...create(uuidv7()), mutationId: 'not-a-uuid' };
    expect((await push([bad])).statusCode).toBe(400);
  });
});

describe('push: apply and idempotent replay (TS-O03)', () => {
  it('applies a CREATE, stores the result and audits in the same transaction', async () => {
    const id = uuidv7();
    const m = create(id, { title: 'diesel' });
    const [r] = await pushOk([m]);
    expect(r).toMatchObject({
      mutationId: m.mutationId,
      result: 'APPLIED',
      entity: { id, version: 1, status: 'DRAFT', syncStatus: 'SYNCED' },
    });
    expect(await noteRow(id)).toMatchObject({ title: 'diesel', owner_id: USER });
    expect(await count('client_mutation', `result = 'APPLIED'`)).toBe(1);
    const stored = await dbRow(
      `SELECT device_id, user_id, entity_type, op, base_version FROM client_mutation`,
    );
    expect(stored).toMatchObject({
      device_id: DEVICE,
      user_id: USER,
      entity_type: 'test_note',
      op: 'CREATE',
      base_version: null,
    });
    expect(await count('audit_log', `action = 'sync.applied' AND entity_id = '${id}'`)).toBe(1);
    expect(await count('audit_log', `action = 'test_note.create' AND entity_id = '${id}'`)).toBe(1);
  });

  it('replays a known mutation id with the stored result and applies nothing twice', async () => {
    const id = uuidv7();
    const create1 = create(id);
    const first = await pushOne(create1);
    const upd = update(id, 1, { note: 'once' });
    expect((await pushOne(upd)).entity?.version).toBe(2);

    // Resend both: stored results come back, version stays 2, no extra rows.
    const replay = await pushOk([create1, upd]);
    expect(replay[0]).toEqual(first);
    expect(replay[1]).toMatchObject({ result: 'APPLIED', entity: { version: 2 } });
    expect((await noteRow(id)).version).toBe(2);
    expect(await count('client_mutation')).toBe(2);
    expect(await count('audit_log', `action = 'sync.applied'`)).toBe(2);
  });

  it('replays CONFLICT and REJECTED results too, without a second conflict row', async () => {
    const id = uuidv7();
    await pushOne(create(id));
    await pushOne(update(id, 1, { title: 'server edit' }));
    const stale = update(id, 1, { amount: '1.00' });
    const first = await pushOne(stale);
    expect(first.result).toBe('CONFLICT');
    const again = await pushOne(stale);
    expect(again).toEqual(first);
    expect(await count('sync_conflict')).toBe(1);

    const bad = create(uuidv7(), { amount: 'x' });
    const rejected = await pushOne(bad);
    expect(rejected).toMatchObject({ result: 'REJECTED', error: { code: 'VALIDATION_FAILED' } });
    expect(await pushOne(bad)).toEqual(rejected);
    expect(await count('client_mutation', `result = 'REJECTED'`)).toBe(1);
  });

  it('rejects a reused mutation id with different content as IDEMPOTENCY_MISMATCH', async () => {
    const id = uuidv7();
    const original = create(id, { title: 'a' });
    await pushOne(original);
    const reused = { ...create(id, { title: 'b' }), mutationId: original.mutationId };
    const r = await pushOne(reused);
    expect(r).toMatchObject({ result: 'REJECTED', error: { code: 'IDEMPOTENCY_MISMATCH' } });
    expect((await noteRow(id)).title).toBe('a');
    expect(await count('client_mutation')).toBe(1);
  });

  it("does not leak or replay another user's mutation id", async () => {
    const id = uuidv7();
    const m = create(id);
    await pushOne(m);
    const r = await pushOne(m, as(OTHER));
    expect(r).toMatchObject({ result: 'REJECTED', error: { code: 'IDEMPOTENCY_MISMATCH' } });
    expect(r.entity).toBeUndefined();
  });

  it('treats concurrent pushes of the same mutation as one application', async () => {
    const id = uuidv7();
    const m = create(id);
    const responses = await Promise.all(Array.from({ length: 6 }, () => push([m])));
    for (const res of responses) {
      expect(res.statusCode, res.body).toBe(200);
    }
    const results = responses.map(
      (res) => res.json<{ data: { results: ResultItem[] } }>().data.results[0],
    );
    // jsonb reorders keys, so compare structurally.
    for (const r of results) {
      expect(r).toEqual(results[0]);
    }
    expect(results[0]?.result).toBe('APPLIED');
    expect(await count('test_note')).toBe(1);
    expect(await count('client_mutation')).toBe(1);
    expect(await count('audit_log', `action = 'sync.applied'`)).toBe(1);
  });

  it('serialises concurrent updates of one entity (no lost update, no double version)', async () => {
    const id = uuidv7();
    await pushOne(create(id));
    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, i) => push([update(id, 1, { note: `n${i}` })])),
    );
    const results = responses.map(
      (res) => res.json<{ data: { results: ResultItem[] } }>().data.results[0] as ResultItem,
    );
    // Same base version 1 and a non-financial field: the first applies; the rest overlap on `note`.
    expect(results.filter((r) => r.result === 'APPLIED')).toHaveLength(1);
    expect(results.filter((r) => r.result === 'CONFLICT')).toHaveLength(4);
    expect((await noteRow(id)).version).toBe(2);
  });
});

describe('push: conflict rules (SYNC_DESIGN 2.3, TS-O05)', () => {
  it('CONFLICT on a stale base version for a financial field; both values preserved', async () => {
    const id = uuidv7();
    await pushOne(create(id, { amount: '10.00' }));
    await pushOne(update(id, 1, { note: 'from device A' }));

    const r = await pushOne(update(id, 1, { amount: '99.00' }));
    expect(r.result).toBe('CONFLICT');
    expect(r.conflictId).toBeTruthy();
    expect(r.entity).toBeUndefined();
    expect((await noteRow(id)).amount).toBe('10.00');

    const row = await dbRow(`SELECT * FROM sync_conflict WHERE id = $1`, [r.conflictId]);
    expect(row).toMatchObject({
      entity_type: 'test_note',
      entity_id: id,
      op: 'UPDATE',
      device_id: DEVICE,
      user_id: USER,
      base_version: 1,
      server_version: 2,
      reason: 'STALE_FINANCIAL_FIELD',
      status: 'OPEN',
      client_payload: { amount: '99.00' },
    });
    expect(row.server_snapshot).toMatchObject({ amount: '10.00', note: 'from device A' });
    expect(await count('audit_log', `action = 'sync.conflict' AND entity_id = '${id}'`)).toBe(1);
  });

  it('auto-merges a stale non-financial update disjoint from the server changes, audited as merged', async () => {
    const id = uuidv7();
    await pushOne(create(id, { title: 'orig' }));
    await pushOne(update(id, 1, { title: 'server title' }));

    const r = await pushOne(update(id, 1, { note: 'device note' }));
    expect(r).toMatchObject({ result: 'APPLIED', entity: { version: 3 } });
    expect(await noteRow(id)).toMatchObject({
      title: 'server title',
      note: 'device note',
      version: 3,
    });
    expect(await count('audit_log', `action = 'sync.merged' AND entity_id = '${id}'`)).toBe(1);
    expect(await count('sync_conflict')).toBe(0);
  });

  it('CONFLICT when a stale non-financial update overlaps what the server changed', async () => {
    const id = uuidv7();
    await pushOne(create(id, { title: 'orig' }));
    await pushOne(update(id, 1, { title: 'server title' }));
    const r = await pushOne(update(id, 1, { title: 'device title' }));
    expect(r.result).toBe('CONFLICT');
    const row = await dbRow(`SELECT reason FROM sync_conflict`);
    expect(row.reason).toBe('OVERLAPPING_FIELDS');
    expect((await noteRow(id)).title).toBe('server title');
  });

  it('a CREATE with a new id is never a conflict, and the same id again is idempotent', async () => {
    const id = uuidv7();
    expect((await pushOne(create(id))).result).toBe('APPLIED');
    const again = await pushOne(create(id)); // new mutation id, same entity id
    expect(again).toMatchObject({ result: 'APPLIED', entity: { id, version: 1 } });
    expect(await count('test_note')).toBe(1);
  });

  it('CONFLICT for a CREATE that violates a business uniqueness (two devices, same slot)', async () => {
    const a = uuidv7();
    const b = uuidv7();
    expect((await pushOne(create(a, { slot: '2026-11-11' }))).result).toBe('APPLIED');
    const r = await pushOne(create(b, { slot: '2026-11-11' }));
    expect(r.result).toBe('CONFLICT');
    expect(await count('test_note', `id = '${b}'`)).toBe(0);
    const row = await dbRow(`SELECT * FROM sync_conflict WHERE id = $1`, [r.conflictId]);
    expect(row).toMatchObject({ reason: 'UNIQUE_VIOLATION', op: 'CREATE', base_version: null });
    // Both values preserved: the client's create payload and the server's existing record.
    expect(row.client_payload).toMatchObject({ slot: '2026-11-11', title: 'first' });
    expect(row.server_snapshot).toMatchObject({ id: a });
  });

  it('REJECTED RECORD_LOCKED when the lock trigger fires, stored and replayed', async () => {
    const id = uuidv7();
    await pushOne(create(id));
    await owner.query(`UPDATE test_note SET locked_at = now() WHERE id = $1`, [id]);

    const locked = update(id, 1, { title: 'too late' });
    const r = await pushOne(locked);
    expect(r).toMatchObject({ result: 'REJECTED', error: { code: 'RECORD_LOCKED' } });
    expect(await noteRow(id)).toMatchObject({ title: 'first' });
    expect(await count('client_mutation', `result = 'REJECTED'`)).toBe(1);
    expect(await pushOne(locked)).toEqual(r);
    expect(await count('audit_log', `action = 'sync.rejected'`)).toBe(1);
  });

  it('REJECTED RECORD_LOCKED when the handler throws it (approved record)', async () => {
    const id = uuidv7();
    await pushOne(create(id));
    await owner.query(`UPDATE test_note SET status = 'APPROVED' WHERE id = $1`, [id]);
    const r = await pushOne(mut({ entityId: id, op: 'CANCEL' }));
    expect(r).toMatchObject({ result: 'REJECTED', error: { code: 'RECORD_LOCKED' } });
    expect((await noteRow(id)).status).toBe('APPROVED');
  });

  it('REJECTED INVALID_TRANSITION for SUBMIT after the record was cancelled', async () => {
    const id = uuidv7();
    await pushOne(create(id));
    expect((await pushOne(mut({ entityId: id, op: 'CANCEL' }))).result).toBe('APPLIED');
    const r = await pushOne(mut({ entityId: id, op: 'SUBMIT' }));
    expect(r).toMatchObject({ result: 'REJECTED', error: { code: 'INVALID_TRANSITION' } });
  });

  it('SUBMIT moves the record to awaiting approval', async () => {
    const id = uuidv7();
    await pushOne(create(id));
    const r = await pushOne(mut({ entityId: id, op: 'SUBMIT' }));
    expect(r).toMatchObject({
      result: 'APPLIED',
      entity: { status: 'SUBMITTED', syncStatus: 'AWAITING_APPROVAL', version: 2 },
    });
  });

  it('an out-of-scope record is NOT_FOUND, not a conflict or a permission hint', async () => {
    const id = uuidv7();
    await pushOne(create(id));
    const r = await pushOne(update(id, 1, { title: 'steal' }), as(OTHER));
    expect(r).toMatchObject({ result: 'REJECTED', error: { code: 'NOT_FOUND' } });
  });

  it('rejects unknown entity types, reference types and unsupported operations', async () => {
    const unknown = await pushOne(mut({ entityType: 'nope', entityId: uuidv7(), op: 'CREATE' }));
    expect(unknown).toMatchObject({ result: 'REJECTED', error: { code: 'VALIDATION_FAILED' } });
    const ref = await pushOne(
      mut({ entityType: 'test_ref', entityId: uuidv7(), op: 'CREATE', payload: { name: 'x' } }),
    );
    expect(ref).toMatchObject({ result: 'REJECTED', error: { code: 'VALIDATION_FAILED' } });
  });
});

describe('push: BLOCKED_BY_PREVIOUS (TS-O08)', () => {
  it('blocks later mutations of the same entity after a conflict; unrelated entities continue', async () => {
    const n1 = uuidv7();
    const n2 = uuidv7();
    await pushOk([create(n1), create(n2)]);
    await pushOne(update(n1, 1, { title: 'server edit' })); // n1 is now v2

    const stale = update(n1, 1, { amount: '5.00' });
    const next = update(n1, 2, { title: 'would apply' });
    const other = update(n2, 1, { title: 'other entity' });
    const results = await pushOk([stale, next, other]);

    expect(results.map((r) => r.result)).toEqual(['CONFLICT', 'BLOCKED_BY_PREVIOUS', 'APPLIED']);
    expect(results[1]).toEqual({ mutationId: next.mutationId, result: 'BLOCKED_BY_PREVIOUS' });
    expect((await noteRow(n1)).title).toBe('server edit');
    expect((await noteRow(n2)).title).toBe('other entity');
    // Blocked mutations are not stored: the client can send them again.
    expect(await count('client_mutation', `mutation_id = '${next.mutationId}'`)).toBe(0);
  });

  it('blocks after a REJECTED mutation, including a replayed one', async () => {
    const id = uuidv7();
    const bad = create(id, { amount: 'oops' });
    const follow = update(id, 1, { title: 'x' });
    for (let round = 0; round < 2; round++) {
      const results = await pushOk([bad, follow]);
      expect(results.map((r) => r.result)).toEqual(['REJECTED', 'BLOCKED_BY_PREVIOUS']);
    }
    expect(await count('test_note')).toBe(0);
  });

  it('DUPLICATE_SUSPECTED is returned, not stored, and blocks the same entity', async () => {
    registerEntity('test_dup', {
      scopes: [],
      create: () =>
        Promise.resolve({
          result: 'DUPLICATE_SUSPECTED' as const,
          error: { code: 'DUPLICATE_SUSPECTED', message: 'Looks like an existing record' },
        }),
      update: () => Promise.reject(new Error('must be blocked')),
      scopeFilter: () => Promise.resolve([]),
      serialize: () => ({}),
    } satisfies SyncEntityHandler);
    const id = uuidv7();
    const first = mut({ entityType: 'test_dup', entityId: id, op: 'CREATE' });
    const second = mut({ entityType: 'test_dup', entityId: id, op: 'UPDATE', baseVersion: 1 });
    const results = await pushOk([first, second]);
    expect(results.map((r) => r.result)).toEqual(['DUPLICATE_SUSPECTED', 'BLOCKED_BY_PREVIOUS']);
    expect(results[0]?.error?.code).toBe('DUPLICATE_SUSPECTED');
    expect(await count('client_mutation')).toBe(0);
  });
});

describe('pull', () => {
  async function insertRef(name: string, archived = false): Promise<string> {
    const id = uuidv7();
    await owner.query(
      `INSERT INTO test_ref (id, name, archived_at) VALUES ($1, $2, ${archived ? 'now()' : 'NULL'})`,
      [id, name],
    );
    return id;
  }

  it('returns changes in sync_seq order across entity types, re-stamping updated rows', async () => {
    const ref1 = await insertRef('ref-1');
    const n1 = uuidv7();
    const n2 = uuidv7();
    await pushOk([create(n1), create(n2)]);
    await pushOne(update(n1, 1, { title: 'edited' })); // n1 now stamped after n2
    const ref2 = await insertRef('ref-2');

    const all = await pull('scope=mine&cursor=0');
    expect(all.changes.map((c) => [c.entityType, c.entityId])).toEqual([
      ['test_ref', ref1],
      ['test_note', n2],
      ['test_note', n1],
      ['test_ref', ref2],
    ]);
    const seqs = all.changes.map((c) => c.syncSeq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(4);
    expect(all.hasMore).toBe(false);
    expect(all.nextCursor).toBe(seqs[3]);
    expect(all.changes[2]?.data).toMatchObject({ id: n1, title: 'edited', version: 2 });
  });

  it('pages with hasMore and resumes from the cursor without gaps or repeats', async () => {
    const ids = [uuidv7(), uuidv7(), uuidv7(), uuidv7(), uuidv7()];
    await pushOk(ids.map((id) => create(id)));

    const seen: string[] = [];
    let cursor = 0;
    const pages: PullData[] = [];
    for (let i = 0; i < 10; i++) {
      const page = await pull(`scope=mine&cursor=${cursor}&limit=2`);
      pages.push(page);
      seen.push(...page.changes.map((c) => c.entityId));
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }
    expect(pages.map((p) => p.changes.length)).toEqual([2, 2, 1]);
    expect(pages.map((p) => p.hasMore)).toEqual([true, true, false]);
    expect(seen).toEqual(ids);

    // Nothing new: empty page, cursor unchanged.
    const empty = await pull(`scope=mine&cursor=${cursor}`);
    expect(empty).toEqual({ changes: [], nextCursor: cursor, hasMore: false });

    // A new change after the cursor shows up alone.
    const later = uuidv7();
    await pushOne(create(later));
    const delta = await pull(`scope=mine&cursor=${cursor}`);
    expect(delta.changes.map((c) => c.entityId)).toEqual([later]);
  });

  it("applies the scope filter: reference vs mine, and only the caller's own records", async () => {
    const ref = await insertRef('only-ref');
    const mine = uuidv7();
    await pushOne(create(mine));

    const reference = await pull('scope=reference');
    expect(reference.changes.map((c) => c.entityId)).toEqual([ref]);

    const other = await pull('scope=mine', as(OTHER));
    expect(other.changes.map((c) => c.entityId)).toEqual([ref]); // not USER's note
  });

  it('flags archived and cancelled rows as deleted', async () => {
    const ref = await insertRef('gone', true);
    const note = uuidv7();
    await pushOne(create(note));
    await pushOne(mut({ entityId: note, op: 'CANCEL' }));
    const page = await pull('scope=mine');
    const byId = new Map(page.changes.map((c) => [c.entityId, c]));
    expect(byId.get(ref)?.deleted).toBe(true);
    expect(byId.get(note)?.deleted).toBe(true);
  });

  it('validates the query', async () => {
    for (const q of [
      '',
      'scope=nope',
      'scope=mine&limit=0',
      'scope=mine&limit=501',
      'scope=mine&cursor=-1',
    ]) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/sync/pull?${q}`,
        headers: as(USER),
      });
      expect(res.statusCode, q).toBe(400);
    }
  });

  it('waits for an in-flight sync write so the cursor never skips a later commit', async () => {
    const early = await insertRef('already-there');
    const client = await owner.connect();
    const lateId = uuidv7();
    let pulled = false;
    let pending: Promise<LightMyRequestResponse> | undefined;
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock_shared(${SYNC_WRITE_LOCK_KEY}::bigint)`);
      // Stamped now (seq assigned), visible only at COMMIT.
      await client.query(`INSERT INTO test_note (id, owner_id, title) VALUES ($1, $2, 'late')`, [
        lateId,
        USER,
      ]);
      pending = app.inject({
        method: 'GET',
        url: '/api/v1/sync/pull?scope=mine',
        headers: as(USER),
      });
      void pending.then(() => {
        pulled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(pulled).toBe(false);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    const res = await pending;
    const ids = res.json<{ data: PullData }>().data.changes.map((c) => c.entityId);
    expect(ids).toEqual([early, lateId]);
  });
});

describe('conflicts: list and resolve', () => {
  async function makeConflict(
    user = USER,
    payload: Record<string, unknown> = { amount: '99.00' },
  ): Promise<{ entityId: string; conflictId: string }> {
    const entityId = uuidv7();
    await pushOne(create(entityId, { amount: '10.00' }), as(user));
    await pushOne(update(entityId, 1, { note: 'server side' }), as(user));
    const r = await pushOne(update(entityId, 1, payload), as(user));
    expect(r.result).toBe('CONFLICT');
    return { entityId, conflictId: r.conflictId as string };
  }

  async function resolve(
    id: string,
    body: Record<string, unknown>,
    headers = as(USER),
  ): Promise<LightMyRequestResponse> {
    return app.inject({
      method: 'POST',
      url: `/api/v1/sync/conflicts/${id}/resolve`,
      payload: body,
      headers,
    });
  }

  it('lists own open conflicts; others see none; an approver sees all; pagination via cursor', async () => {
    const a = await makeConflict(USER);
    const b = await makeConflict(USER);
    const c = await makeConflict(OTHER);

    const list = async (q: string, headers: Record<string, string>) => {
      const res = await app.inject({ method: 'GET', url: `/api/v1/sync/conflicts${q}`, headers });
      expect(res.statusCode, res.body).toBe(200);
      return res.json<{
        data: { id: string; status: string }[];
        meta?: { nextCursor?: string };
      }>();
    };

    expect((await list('', as(USER))).data.map((x) => x.id)).toEqual([a.conflictId, b.conflictId]);
    expect((await list('', as(OTHER))).data.map((x) => x.id)).toEqual([c.conflictId]);
    expect((await list('', as(uuidv7()))).data).toEqual([]);

    const approver = as(uuidv7(), APPROVER_PERMS);
    expect((await list('', approver)).data).toHaveLength(3);

    const page1 = await list('?limit=2', approver);
    expect(page1.data).toHaveLength(2);
    expect(page1.meta?.nextCursor).toBe(b.conflictId);
    const page2 = await list(`?limit=2&cursor=${page1.meta?.nextCursor}`, approver);
    expect(page2.data.map((x) => x.id)).toEqual([c.conflictId]);
    expect(page2.meta?.nextCursor).toBeUndefined();

    const dto = (await list('', as(USER))).data[0] as Record<string, unknown>;
    expect(dto).toMatchObject({
      reason: 'STALE_FINANCIAL_FIELD',
      baseVersion: 1,
      serverVersion: 2,
      clientPayload: { amount: '99.00' },
      status: 'OPEN',
    });
  });

  it('KEEP_SERVER closes the conflict and leaves the record alone', async () => {
    const { entityId, conflictId } = await makeConflict();
    const res = await resolve(conflictId, { resolution: 'KEEP_SERVER', note: 'server was right' });
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json<{ data: { conflict: Record<string, unknown>; entity: unknown } }>().data;
    expect(data.entity).toBeNull();
    expect(data.conflict).toMatchObject({
      status: 'RESOLVED_KEEP_SERVER',
      resolvedBy: USER,
      note: 'server was right',
    });
    expect(await noteRow(entityId)).toMatchObject({ amount: '10.00', version: 2 });
    const audited = await dbRows(
      `SELECT actor_user_id, after FROM audit_log WHERE action = 'sync.conflict.resolved'`,
    );
    expect(audited).toHaveLength(1);
    expect(audited[0]?.actor_user_id).toBe(USER);
    expect(audited[0]?.after).toMatchObject({ status: 'RESOLVED_KEEP_SERVER', conflictId });
  });

  it('APPLY_CLIENT writes the stored client payload over the server row', async () => {
    const { entityId, conflictId } = await makeConflict();
    const res = await resolve(conflictId, { resolution: 'APPLY_CLIENT' });
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json<{
      data: { conflict: { status: string }; entity: { version: number } };
    }>().data;
    expect(data.conflict.status).toBe('RESOLVED_APPLY_CLIENT');
    expect(data.entity.version).toBe(3);
    expect(await noteRow(entityId)).toMatchObject({
      amount: '99.00',
      note: 'server side',
      version: 3,
    });
    expect(await count('audit_log', `action = 'test_note.resolve'`)).toBe(1);
    expect(await count('audit_log', `action = 'sync.conflict.resolved'`)).toBe(1);
  });

  it('MERGED writes the explicit values and requires them', async () => {
    const { entityId, conflictId } = await makeConflict();
    const missing = await resolve(conflictId, { resolution: 'MERGED' });
    expect(missing.statusCode).toBe(400);
    const extra = await resolve(conflictId, {
      resolution: 'KEEP_SERVER',
      values: { amount: '1.00' },
    });
    expect(extra.statusCode).toBe(400);

    const res = await resolve(conflictId, {
      resolution: 'MERGED',
      values: { amount: '55.50', title: 'merged by hand' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await noteRow(entityId)).toMatchObject({ amount: '55.50', title: 'merged by hand' });
    const row = await dbRow(`SELECT status, resolved_values FROM sync_conflict`);
    expect(row.status).toBe('RESOLVED_MERGED');
    expect(row.resolved_values).toEqual({ amount: '55.50', title: 'merged by hand' });
  });

  it('refuses to resolve twice (INVALID_TRANSITION) and applies nothing the second time', async () => {
    const { entityId, conflictId } = await makeConflict();
    expect((await resolve(conflictId, { resolution: 'APPLY_CLIENT' })).statusCode).toBe(200);
    const again = await resolve(conflictId, { resolution: 'APPLY_CLIENT' });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: 'INVALID_TRANSITION' } });
    expect((await noteRow(entityId)).version).toBe(3);
  });

  it('answers NOT_FOUND to a user who neither owns the conflict nor approves', async () => {
    const { conflictId } = await makeConflict(USER);
    const stranger = await resolve(conflictId, { resolution: 'KEEP_SERVER' }, as(OTHER));
    expect(stranger.statusCode).toBe(404);
    expect(await count('sync_conflict', `status = 'OPEN'`)).toBe(1);
    const unknown = await resolve(uuidv7(), { resolution: 'KEEP_SERVER' });
    expect(unknown.statusCode).toBe(404);
    const malformed = await resolve('not-a-uuid', { resolution: 'KEEP_SERVER' });
    expect(malformed.statusCode).toBe(404);
  });

  it("lets an approver resolve someone else's conflict; the audit names the approver", async () => {
    const { conflictId } = await makeConflict(USER);
    const approver = uuidv7();
    // The approver acts on USER's note, but the test handler scopes notes to their owner, so only
    // KEEP_SERVER (no entity write) is possible here; the actor is what matters.
    const res = await resolve(
      conflictId,
      { resolution: 'KEEP_SERVER' },
      as(approver, APPROVER_PERMS),
    );
    expect(res.statusCode, res.body).toBe(200);
    const row = await dbRow(`SELECT resolved_by FROM sync_conflict`);
    expect(row.resolved_by).toBe(approver);
  });

  it("scopes approvers per entity type: another type's approver sees and resolves nothing", async () => {
    const { conflictId } = await makeConflict(USER);
    // Holds approval rights for other entity types, not for test_note.
    const wrong = as(uuidv7(), 'advance.approve,wages.approve,inventory.writeoff.approve');
    const list = await app.inject({ method: 'GET', url: '/api/v1/sync/conflicts', headers: wrong });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ data: unknown[] }>().data).toEqual([]);
    const res = await resolve(conflictId, { resolution: 'KEEP_SERVER' }, wrong);
    expect(res.statusCode).toBe(404);
    expect(await count('sync_conflict', `status = 'OPEN'`)).toBe(1);
  });

  it('a type without approverPermission is owner-only, even for an approver', async () => {
    registerEntity('test_owner_only', {
      scopes: [],
      create: () => Promise.reject(new Error('unused')),
      scopeFilter: () => Promise.resolve([]),
      serialize: () => ({}),
    } satisfies SyncEntityHandler);
    const { conflictId } = await makeConflict(USER);
    await owner.query(`UPDATE sync_conflict SET entity_type = 'test_owner_only'`);
    const approver = as(uuidv7(), APPROVER_PERMS);
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/sync/conflicts',
      headers: approver,
    });
    expect(list.json<{ data: unknown[] }>().data).toEqual([]);
    expect((await resolve(conflictId, { resolution: 'KEEP_SERVER' }, approver)).statusCode).toBe(
      404,
    );
    // The owner still sees it.
    const own = await app.inject({
      method: 'GET',
      url: '/api/v1/sync/conflicts',
      headers: as(USER),
    });
    expect(own.json<{ data: unknown[] }>().data).toHaveLength(1);
  });

  it('RECORD_LOCKED on resolve rolls back and leaves the conflict open', async () => {
    const { entityId, conflictId } = await makeConflict();
    await owner.query(`UPDATE test_note SET locked_at = now() WHERE id = $1`, [entityId]);
    const res = await resolve(conflictId, { resolution: 'APPLY_CLIENT' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'RECORD_LOCKED' } });
    expect(await count('sync_conflict', `status = 'OPEN'`)).toBe(1);
    expect((await noteRow(entityId)).amount).toBe('10.00');
  });

  it('after resolution the client can push again for that entity', async () => {
    const { entityId, conflictId } = await makeConflict();
    await resolve(conflictId, { resolution: 'KEEP_SERVER' });
    const r = await pushOne(update(entityId, 2, { amount: '12.00' }));
    expect(r).toMatchObject({ result: 'APPLIED', entity: { version: 3 } });
  });
});
