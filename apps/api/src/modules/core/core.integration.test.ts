import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@tradex/domain';
import { MIGRATIONS_DIR, resetDatabase, testDbUrls, truncateAll } from '../../../test/db.js';
import { createDatabase, type Database } from '../../db/index.js';
import { runMigrations } from '../../db/migrate.js';
import { AppError } from '../../errors.js';
import { core, runWithContext } from './index.js';

const urls = testDbUrls();
let db: Database;
let owner: pg.Pool;

const USER = '01930000-0000-7000-8000-000000001001';
const OTHER = '01930000-0000-7000-8000-000000002002';
const DEVICE = '01930000-0000-7000-8000-00000000a001';

beforeAll(async () => {
  await resetDatabase(urls);
  await runMigrations(urls.owner, MIGRATIONS_DIR);
  db = createDatabase(urls.app);
  owner = new pg.Pool({ connectionString: urls.owner, max: 2 });
});

beforeEach(async () => {
  await truncateAll(urls);
  // truncateAll keeps app_setting; recreate the seeded rows so values and versions start fresh.
  await owner.query(`
    DELETE FROM app_setting;
    INSERT INTO app_setting (key, value) VALUES ('tally_stale_hours', '24'), ('fy_start_month', '4')`);
});

afterAll(async () => {
  await db.destroy();
  await owner.end();
});

async function auditRows(): Promise<Record<string, unknown>[]> {
  const { rows } = await owner.query('SELECT * FROM audit_log ORDER BY id');
  return rows as Record<string, unknown>[];
}

async function expectAppError(promise: Promise<unknown>, code: string): Promise<AppError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  return err as AppError;
}

describe('core.audit.record', () => {
  it('stores a shallow diff and the explicit actor context', async () => {
    await db.transaction().execute((tx) =>
      core.audit.record(tx, {
        action: 'thing.update',
        entityType: 'thing',
        entityId: 'abc',
        before: { name: 'old', qty: 1, same: true },
        after: { name: 'new', qty: 1, same: true },
        ctx: { userId: USER, deviceId: DEVICE, requestId: 'req-1', ip: '10.0.0.7' },
      }),
    );
    const [row] = await auditRows();
    expect(row).toMatchObject({
      action: 'thing.update',
      entity_type: 'thing',
      entity_id: 'abc',
      actor_user_id: USER,
      device_id: DEVICE,
      request_id: 'req-1',
      before: { name: 'old' },
      after: { name: 'new' },
    });
    expect(String(row?.ip)).toBe('10.0.0.7');
  });

  it('reads the ambient request context when none is passed', async () => {
    await runWithContext({ userId: USER, requestId: 'req-ambient' }, () =>
      db.transaction().execute((tx) =>
        core.audit.record(tx, {
          action: 'thing.create',
          entityType: 'thing',
          entityId: '1',
          after: { id: 1 },
        }),
      ),
    );
    const [row] = await auditRows();
    expect(row).toMatchObject({
      actor_user_id: USER,
      request_id: 'req-ambient',
      before: null,
      after: { id: 1 },
    });
  });

  it('records null actors for system work with no context', async () => {
    await db
      .transaction()
      .execute((tx) =>
        core.audit.record(tx, { action: 'system.tick', entityType: 'system', entityId: 'x' }),
      );
    const [row] = await auditRows();
    expect(row).toMatchObject({ actor_user_id: null, device_id: null, request_id: null });
  });

  it('rolls back with the transaction it was written in', async () => {
    await db
      .transaction()
      .execute(async (tx) => {
        await core.audit.record(tx, { action: 'a', entityType: 'thing', entityId: '1' });
        throw new Error('abort');
      })
      .catch(() => undefined);
    expect(await auditRows()).toHaveLength(0);
  });

  it('stores array values as jsonb arrays, not PG arrays', async () => {
    await db.transaction().execute((tx) =>
      core.audit.record(tx, {
        action: 'a',
        entityType: 'thing',
        entityId: '1',
        before: { tags: ['x'] },
        after: { tags: ['x', 'y'] },
      }),
    );
    const [row] = await auditRows();
    expect(row?.after).toEqual({ tags: ['x', 'y'] });
  });
});

describe('core.numbers.next', () => {
  it('formats PREFIX-FY-##### and increments per name and financial year', async () => {
    const out = await db
      .transaction()
      .execute(async (tx) => [
        await core.numbers.next(tx, 'EXP', '2026-05-10'),
        await core.numbers.next(tx, 'EXP', '2026-06-01'),
        await core.numbers.next(tx, 'INV', '2026-06-01'),
        await core.numbers.next(tx, 'EXP', '2027-03-31'),
        await core.numbers.next(tx, 'EXP', '2027-04-01'),
      ]);
    expect(out).toEqual([
      'EXP-2026-00001',
      'EXP-2026-00002',
      'INV-2026-00001',
      'EXP-2026-00003',
      'EXP-2027-00001',
    ]);
  });

  it('continues past five digits without truncating', async () => {
    await owner.query(
      `INSERT INTO number_sequence (name, fiscal_year, next_value) VALUES ('BIG', 2026, 99999)`,
    );
    const out = await db
      .transaction()
      .execute(async (tx) => [
        await core.numbers.next(tx, 'BIG', '2026-05-01'),
        await core.numbers.next(tx, 'BIG', '2026-05-01'),
      ]);
    expect(out).toEqual(['BIG-2026-99999', 'BIG-2026-100000']);
  });

  it('honours the fy_start_month setting', async () => {
    const out = await db.transaction().execute(async (tx) => {
      await core.settings.set(tx, 'fy_start_month', 1);
      return [
        await core.numbers.next(tx, 'JAN', '2026-01-01'),
        await core.numbers.next(tx, 'JAN', '2025-12-31'),
      ];
    });
    expect(out).toEqual(['JAN-2026-00001', 'JAN-2025-00001']);
  });

  it('is gap-free: a rolled-back transaction gives its number back', async () => {
    await db
      .transaction()
      .execute(async (tx) => {
        expect(await core.numbers.next(tx, 'EXP', '2026-05-10')).toBe('EXP-2026-00001');
        throw new Error('abort');
      })
      .catch(() => undefined);
    const next = await db.transaction().execute((tx) => core.numbers.next(tx, 'EXP', '2026-05-10'));
    expect(next).toBe('EXP-2026-00001');
  });

  it('yields unique sequential numbers across parallel transactions', async () => {
    const count = 12;
    const results = await Promise.all(
      Array.from({ length: count }, () =>
        db.transaction().execute(async (tx) => {
          const number = await core.numbers.next(tx, 'EXP', '2026-05-10');
          // Hold the row lock so the transactions genuinely overlap.
          await new Promise((resolve) => setTimeout(resolve, 15));
          return number;
        }),
      ),
    );
    const expected = Array.from(
      { length: count },
      (_, i) => `EXP-2026-${String(i + 1).padStart(5, '0')}`,
    );
    expect(new Set(results).size).toBe(count);
    expect([...results].sort()).toEqual(expected);
  });

  it('rejects bad sequence names and dates without touching the table', async () => {
    await expectAppError(
      db.transaction().execute((tx) => core.numbers.next(tx, 'exp', '2026-05-10')),
      'VALIDATION_FAILED',
    );
    await expectAppError(
      db.transaction().execute((tx) => core.numbers.next(tx, 'EXP', '2026-02-30')),
      'VALIDATION_FAILED',
    );
    const { rows } = await owner.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM number_sequence',
    );
    expect(rows[0]?.n).toBe(0);
  });
});

describe('core.settings', () => {
  it('reads seeded settings', async () => {
    const stale = await core.settings.get(db, 'tally_stale_hours');
    expect(stale).toEqual({ key: 'tally_stale_hours', value: 24, version: 1 });
    const all = await core.settings.list(db);
    expect(all.map((s) => s.key)).toEqual(['fy_start_month', 'tally_stale_hours']);
  });

  it('updates a value, bumps the version and audits the change in the same transaction', async () => {
    const saved = await db
      .transaction()
      .execute((tx) => core.settings.set(tx, 'tally_stale_hours', 48, { ctx: { userId: USER } }));
    expect(saved).toEqual({ key: 'tally_stale_hours', value: 48, version: 2 });
    expect((await core.settings.get(db, 'tally_stale_hours')).value).toBe(48);
    const [row] = await auditRows();
    expect(row).toMatchObject({
      action: 'setting.update',
      entity_type: 'app_setting',
      entity_id: 'tally_stale_hours',
      actor_user_id: USER,
      before: { value: 24 },
      after: { value: 48 },
    });
    const { rows } = await owner.query<{ updated_by: string | null }>(
      `SELECT updated_by FROM app_setting WHERE key = 'tally_stale_hours'`,
    );
    expect(rows[0]?.updated_by).toBe(USER);
  });

  it('creates a missing row', async () => {
    await db.deleteFrom('app_setting').where('key', '=', 'fy_start_month').execute();
    const saved = await db
      .transaction()
      .execute((tx) => core.settings.set(tx, 'fy_start_month', 4));
    expect(saved.version).toBe(1);
    const [row] = await auditRows();
    expect(row).toMatchObject({ action: 'setting.create', before: null, after: { value: 4 } });
  });

  it('rejects a stale expectedVersion with CONFLICT_VERSION and the server snapshot', async () => {
    await db.transaction().execute((tx) => core.settings.set(tx, 'tally_stale_hours', 30));
    const err = await expectAppError(
      db
        .transaction()
        .execute((tx) => core.settings.set(tx, 'tally_stale_hours', 36, { expectedVersion: 1 })),
      'CONFLICT_VERSION',
    );
    expect(err.details).toMatchObject({ server: { value: 30, version: 2 } });
    expect((await core.settings.get(db, 'tally_stale_hours')).value).toBe(30);
    expect(await auditRows()).toHaveLength(1);
  });

  it('accepts a matching expectedVersion', async () => {
    const saved = await db
      .transaction()
      .execute((tx) => core.settings.set(tx, 'tally_stale_hours', 36, { expectedVersion: 1 }));
    expect(saved.version).toBe(2);
  });

  it('rejects invalid values and unknown keys, writing no audit row', async () => {
    await expectAppError(
      db.transaction().execute((tx) => core.settings.set(tx, 'fy_start_month', 13)),
      'VALIDATION_FAILED',
    );
    await expectAppError(
      db.transaction().execute((tx) =>
        // @ts-expect-error unknown key is rejected at runtime too
        core.settings.set(tx, 'not_a_setting', 1),
      ),
      'VALIDATION_FAILED',
    );
    await expectAppError(
      // @ts-expect-error unknown key is rejected at runtime too
      core.settings.get(db, 'not_a_setting'),
      'VALIDATION_FAILED',
    );
    expect(await auditRows()).toHaveLength(0);
  });

  it('get throws NOT_FOUND when the row is absent', async () => {
    await db.deleteFrom('app_setting').where('key', '=', 'tally_stale_hours').execute();
    await expectAppError(core.settings.get(db, 'tally_stale_hours'), 'NOT_FOUND');
  });

  it('rolls the audit row back with the setting when the transaction aborts', async () => {
    await db
      .transaction()
      .execute(async (tx) => {
        await core.settings.set(tx, 'tally_stale_hours', 99);
        throw new Error('abort');
      })
      .catch(() => undefined);
    expect((await core.settings.get(db, 'tally_stale_hours')).value).toBe(24);
    expect(await auditRows()).toHaveLength(0);
  });
});

describe('core.notifications', () => {
  const me = { userId: USER, roles: ['ACCOUNTANT'] };
  const other = { userId: OTHER, roles: ['DRIVER'] };

  it('requires a user or a role target', async () => {
    await expectAppError(
      core.notifications.create(db, { kind: 'DOC_EXPIRY', title: 'x' }),
      'VALIDATION_FAILED',
    );
  });

  it('lists notifications for the user and for their roles only', async () => {
    const direct = await core.notifications.create(db, {
      userId: USER,
      kind: 'EMI_DUE',
      title: 'EMI due',
      entityType: 'loan',
      entityId: 'L1',
      dueAt: new Date('2026-06-01T00:00:00Z'),
    });
    const byRole = await core.notifications.create(db, {
      targetRole: 'ACCOUNTANT',
      kind: 'APPROVAL_PENDING',
      title: 'Approve',
    });
    await core.notifications.create(db, { userId: OTHER, kind: 'EMI_DUE', title: 'not mine' });
    await core.notifications.create(db, {
      targetRole: 'DRIVER',
      kind: 'EMI_DUE',
      title: 'not mine',
    });

    const { items } = await core.notifications.listForUser(db, me);
    expect(items.map((n) => n.id)).toEqual([byRole, direct]);
    expect(items[1]).toMatchObject({
      kind: 'EMI_DUE',
      entityType: 'loan',
      entityId: 'L1',
      readAt: null,
    });
    expect(await core.notifications.countUnread(db, me)).toBe(2);
    expect(await core.notifications.countUnread(db, other)).toBe(2);
  });

  it('paginates newest first with a cursor', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        await core.notifications.create(db, { userId: USER, kind: 'DOC_EXPIRY', title: `n${i}` }),
      );
    }
    const first = await core.notifications.listForUser(db, me, { limit: 2 });
    expect(first.items.map((n) => n.id)).toEqual([ids[4], ids[3]]);
    expect(first.nextCursor).toBe(ids[3]);
    const second = await core.notifications.listForUser(db, me, {
      limit: 2,
      ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
    });
    expect(second.items.map((n) => n.id)).toEqual([ids[2], ids[1]]);
    const third = await core.notifications.listForUser(db, me, {
      limit: 2,
      ...(second.nextCursor ? { cursor: second.nextCursor } : {}),
    });
    expect(third.items.map((n) => n.id)).toEqual([ids[0]]);
    expect(third.nextCursor).toBeUndefined();
  });

  it('marks read idempotently and filters unread', async () => {
    const id = await core.notifications.create(db, {
      userId: USER,
      kind: 'SYNC_FAILED',
      title: 't',
    });
    await core.notifications.create(db, { userId: USER, kind: 'SYNC_FAILED', title: 'u' });
    const first = await core.notifications.markRead(db, me, id);
    expect(first.readAt).toBeInstanceOf(Date);
    const again = await core.notifications.markRead(db, me, id);
    expect(again.readAt?.getTime()).toBe(first.readAt?.getTime());
    const unread = await core.notifications.listForUser(db, me, { unreadOnly: true });
    expect(unread.items).toHaveLength(1);
    expect(await core.notifications.countUnread(db, me)).toBe(1);
  });

  it('hides notifications addressed to someone else (NOT_FOUND)', async () => {
    const id = await core.notifications.create(db, {
      userId: USER,
      kind: 'SYNC_FAILED',
      title: 't',
    });
    await expectAppError(core.notifications.markRead(db, other, id), 'NOT_FOUND');
    await expectAppError(core.notifications.markRead(db, me, uuidv7()), 'NOT_FOUND');
    const { rows } = await owner.query<{ read_at: Date | null }>(
      'SELECT read_at FROM notification WHERE id = $1',
      [id],
    );
    expect(rows[0]?.read_at).toBeNull();
  });

  it('lets a role member mark a role notification read', async () => {
    const id = await core.notifications.create(db, {
      targetRole: 'ACCOUNTANT',
      kind: 'APPROVAL_PENDING',
      title: 't',
    });
    const view = await core.notifications.markRead(db, me, id);
    expect(view.readAt).not.toBeNull();
  });
});
