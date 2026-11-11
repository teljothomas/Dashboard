import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, resetDatabase, sqlState, testDbUrls, truncateAll } from '../../test/db.js';
import { runMigrations } from './migrate.js';
import { createDatabase, type Database } from './client.js';
import { buildApp } from '../app.js';
import { testConfig } from '../test-config.js';

const urls = testDbUrls();
let owner: pg.Pool;
let app: pg.Pool;

const UUID_A = '01930000-0000-7000-8000-00000000aaaa';

beforeAll(async () => {
  await resetDatabase(urls);
  await runMigrations(urls.owner, MIGRATIONS_DIR);
  owner = new pg.Pool({ connectionString: urls.owner, max: 4 });
  app = new pg.Pool({ connectionString: urls.app, max: 8 });
  // Probe table exercising the shared trigger functions (owner-created, so app has DML grants).
  await owner.query(`
    CREATE TABLE trigger_probe (
      id          integer     PRIMARY KEY,
      note        text,
      locked_at   timestamptz,
      is_locked   boolean     NOT NULL DEFAULT false,
      sync_seq    bigint,
      updated_at  timestamptz NOT NULL DEFAULT now(),
      version     integer     NOT NULL DEFAULT 1
    );
    CREATE TRIGGER probe_updated BEFORE UPDATE ON trigger_probe
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER probe_version BEFORE UPDATE ON trigger_probe
      FOR EACH ROW EXECUTE FUNCTION bump_version();
    CREATE TRIGGER probe_sync BEFORE INSERT OR UPDATE ON trigger_probe
      FOR EACH ROW EXECUTE FUNCTION assign_sync_seq();
    CREATE TRIGGER probe_lock_ts BEFORE UPDATE OR DELETE ON trigger_probe
      FOR EACH ROW EXECUTE FUNCTION forbid_update_when_locked('locked_at');

    CREATE TABLE lock_probe_bool (
      id         integer PRIMARY KEY,
      is_locked  boolean NOT NULL DEFAULT false,
      note       text
    );
    CREATE TRIGGER lock_bool BEFORE UPDATE OR DELETE ON lock_probe_bool
      FOR EACH ROW EXECUTE FUNCTION forbid_update_when_locked('is_locked');
  `);
});

beforeEach(async () => {
  await truncateAll(urls);
});

afterAll(async () => {
  await app.end();
  await owner.end();
});

async function expectState(promise: Promise<unknown>, state: string): Promise<void> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, `expected SQLSTATE ${state}`).toBeDefined();
  expect(sqlState(err)).toBe(state);
}

describe('audit_log is append-only', () => {
  it('app role can insert and select but not update, delete or truncate', async () => {
    await app.query(
      `INSERT INTO audit_log (action, entity_type, entity_id, after) VALUES ('CREATE', 'thing', 't1', '{"a":1}')`,
    );
    const { rows } = await app.query<{ id: string }>('SELECT id FROM audit_log');
    expect(rows).toHaveLength(1);

    await expectState(app.query(`UPDATE audit_log SET action = 'X'`), '42501');
    await expectState(app.query('DELETE FROM audit_log'), '42501');
    await expectState(app.query('TRUNCATE audit_log'), '42501');
  });

  it('the trigger blocks update and delete even for the owner role', async () => {
    await owner.query(
      `INSERT INTO audit_log (action, entity_type, entity_id) VALUES ('CREATE', 'thing', 't1')`,
    );
    await expectState(owner.query(`UPDATE audit_log SET action = 'X'`), 'TX403');
    await expectState(owner.query('DELETE FROM audit_log'), 'TX403');
  });

  it('rejects empty action, entity type and entity id', async () => {
    await expectState(
      app.query(`INSERT INTO audit_log (action, entity_type, entity_id) VALUES ('', 'a', 'b')`),
      '23514',
    );
  });
});

describe('owner_approval is append-only', () => {
  it('app role can insert but not update or delete; owner is blocked by trigger', async () => {
    await app.query(
      `INSERT INTO owner_approval (id, kind, approved_by, subject) VALUES ($1, 'DATA_IMPORT', $1, '{"batch":1}')`,
      [UUID_A],
    );
    await expectState(app.query(`UPDATE owner_approval SET note = 'x'`), '42501');
    await expectState(app.query('DELETE FROM owner_approval'), '42501');
    await expectState(owner.query(`UPDATE owner_approval SET note = 'x'`), 'TX403');
  });

  it('rejects a lowercase kind', async () => {
    await expectState(
      app.query(`INSERT INTO owner_approval (id, kind, approved_by) VALUES ($1, 'bad kind', $1)`, [
        UUID_A,
      ]),
      '23514',
    );
  });
});

describe('division and app_setting', () => {
  it('division is read-only for the app role', async () => {
    const { rows } = await app.query('SELECT code FROM division');
    expect(rows).toHaveLength(2);
    await expectState(
      app.query(`INSERT INTO division (id, code, name) VALUES ($1, 'MEAT', 'x')`, [UUID_A]),
      '42501',
    );
    await expectState(app.query(`UPDATE division SET name = 'x'`), '42501');
    await expectState(app.query('DELETE FROM division'), '42501');
  });

  it('division codes are restricted to MEAT and LOGISTICS', async () => {
    await expectState(
      owner.query(`INSERT INTO division (id, code, name) VALUES ($1, 'OTHER', 'x')`, [UUID_A]),
      '23514',
    );
  });

  it('app_setting update bumps version and updated_at', async () => {
    const before = await app.query<{ version: number; updated_at: Date }>(
      `SELECT version, updated_at FROM app_setting WHERE key = 'tally_stale_hours'`,
    );
    await app.query(`UPDATE app_setting SET value = '48'::jsonb WHERE key = 'tally_stale_hours'`);
    const after = await app.query<{ version: number; updated_at: Date; value: unknown }>(
      `SELECT version, updated_at, value FROM app_setting WHERE key = 'tally_stale_hours'`,
    );
    expect(after.rows[0]?.version).toBe((before.rows[0]?.version ?? 0) + 1);
    expect(after.rows[0]?.value).toBe(48);
    expect(after.rows[0]?.updated_at.getTime()).toBeGreaterThan(
      before.rows[0]?.updated_at.getTime() ?? 0,
    );
    await app.query(`UPDATE app_setting SET value = '24'::jsonb WHERE key = 'tally_stale_hours'`);
  });
});

describe('number_sequence, job and notification constraints', () => {
  it('number_sequence rejects a bad name and a non-positive next_value', async () => {
    await expectState(
      app.query(`INSERT INTO number_sequence (name, fiscal_year) VALUES ('lower', 2026)`),
      '23514',
    );
    await expectState(
      app.query(
        `INSERT INTO number_sequence (name, fiscal_year, next_value) VALUES ('EXP', 2026, 0)`,
      ),
      '23514',
    );
    await app.query(`INSERT INTO number_sequence (name, fiscal_year) VALUES ('EXP', 2026)`);
    await expectState(
      app.query(`INSERT INTO number_sequence (name, fiscal_year) VALUES ('EXP', 2026)`),
      '23505',
    );
  });

  it('job defaults to QUEUED and rejects an unknown status', async () => {
    await app.query(`INSERT INTO job (id, kind) VALUES ($1, 'noop')`, [UUID_A]);
    const { rows } = await app.query<{ status: string; attempts: number; max_attempts: number }>(
      'SELECT status, attempts, max_attempts FROM job',
    );
    expect(rows[0]).toEqual({ status: 'QUEUED', attempts: 0, max_attempts: 5 });
    await expectState(app.query(`UPDATE job SET status = 'WEIRD'`), '23514');
  });

  it('notification needs a user or a target role', async () => {
    await expectState(
      app.query(`INSERT INTO notification (id, kind, title) VALUES ($1, 'EMI_DUE', 'Due')`, [
        UUID_A,
      ]),
      '23514',
    );
    await app.query(
      `INSERT INTO notification (id, kind, title, target_role) VALUES ($1, 'EMI_DUE', 'Due', 'OWNER')`,
      [UUID_A],
    );
  });
});

describe('shared trigger functions', () => {
  it('set_updated_at and bump_version fire on update', async () => {
    await app.query(
      `INSERT INTO trigger_probe (id, note, updated_at) VALUES (1, 'a', '2000-01-01T00:00:00Z')`,
    );
    const first = await app.query<{ version: number; updated_at: Date }>(
      'SELECT version, updated_at FROM trigger_probe WHERE id = 1',
    );
    expect(first.rows[0]?.version).toBe(1);

    await app.query(`UPDATE trigger_probe SET note = 'b' WHERE id = 1`);
    await app.query(`UPDATE trigger_probe SET note = 'c' WHERE id = 1`);
    const after = await app.query<{ version: number; updated_at: Date }>(
      'SELECT version, updated_at FROM trigger_probe WHERE id = 1',
    );
    expect(after.rows[0]?.version).toBe(3);
    expect(after.rows[0]?.updated_at.getFullYear()).toBeGreaterThan(2000);
  });

  it('sync_seq increases monotonically on insert and update', async () => {
    const seen: number[] = [];
    for (let id = 1; id <= 5; id += 1) {
      const { rows } = await app.query<{ sync_seq: string }>(
        `INSERT INTO trigger_probe (id) VALUES ($1) RETURNING sync_seq`,
        [id],
      );
      seen.push(Number(rows[0]?.sync_seq));
    }
    const updated = await app.query<{ sync_seq: string }>(
      `UPDATE trigger_probe SET note = 'changed' WHERE id = 1 RETURNING sync_seq`,
    );
    seen.push(Number(updated.rows[0]?.sync_seq));

    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]).toBeGreaterThan(seen[i - 1] ?? Infinity);
    }
  });

  it('sync_seq values are unique across concurrent connections', async () => {
    const inserts = Array.from({ length: 20 }, (_, i) =>
      app.query<{ sync_seq: string }>(
        `INSERT INTO trigger_probe (id) VALUES ($1) RETURNING sync_seq`,
        [100 + i],
      ),
    );
    const seqs = (await Promise.all(inserts)).map((r) => r.rows[0]?.sync_seq);
    expect(new Set(seqs).size).toBe(20);
  });

  it('forbid_update_when_locked blocks update and delete on a locked timestamp column', async () => {
    await app.query(`INSERT INTO trigger_probe (id, note) VALUES (1, 'open')`);
    await app.query(`UPDATE trigger_probe SET note = 'still open' WHERE id = 1`);
    await app.query(`UPDATE trigger_probe SET locked_at = now() WHERE id = 1`);

    await expectState(app.query(`UPDATE trigger_probe SET note = 'x' WHERE id = 1`), 'TX423');
    await expectState(app.query('DELETE FROM trigger_probe WHERE id = 1'), 'TX423');
  });

  it('forbid_update_when_locked works with a boolean lock column', async () => {
    await app.query(`INSERT INTO lock_probe_bool (id, note) VALUES (1, 'a')`);
    await app.query(`UPDATE lock_probe_bool SET note = 'b' WHERE id = 1`);
    await app.query(`UPDATE lock_probe_bool SET is_locked = true WHERE id = 1`);
    await expectState(app.query(`UPDATE lock_probe_bool SET note = 'c' WHERE id = 1`), 'TX423');
    await expectState(app.query('DELETE FROM lock_probe_bool WHERE id = 1'), 'TX423');
  });

  it('forbid_update_when_locked fails loudly for a missing lock column', async () => {
    await owner.query(`
      CREATE TABLE IF NOT EXISTS bad_lock_probe (id integer PRIMARY KEY);
      DROP TRIGGER IF EXISTS bad_lock ON bad_lock_probe;
      CREATE TRIGGER bad_lock BEFORE UPDATE ON bad_lock_probe
        FOR EACH ROW EXECUTE FUNCTION forbid_update_when_locked('nope');
    `);
    await owner.query('INSERT INTO bad_lock_probe (id) VALUES (1)');
    await expectState(owner.query('UPDATE bad_lock_probe SET id = 2 WHERE id = 1'), 'P0001');
  });
});

describe('GET /health against the real database', () => {
  let db: Database | undefined;

  afterAll(async () => {
    await db?.destroy();
  });

  it('returns ok when the database answers SELECT 1', async () => {
    const instance = buildApp({ ...testConfig, DATABASE_URL: urls.app });
    try {
      const res = await instance.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok' });
    } finally {
      await instance.close();
    }
  });

  it('returns 503 without details when the database is unreachable', async () => {
    const dead = createDatabase('postgresql://nobody:nothing@127.0.0.1:1/none');
    db = dead;
    const instance = buildApp(testConfig, { db: dead });
    try {
      const res = await instance.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ status: 'error' });
      expect(res.body).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|nobody/);
    } finally {
      await instance.close();
    }
  });

  it('app role keeps the date type as a plain string', async () => {
    const live = createDatabase(urls.app);
    try {
      const { rows } = await app.query<{ d: unknown }>(`SELECT DATE '2026-04-01' AS d`);
      expect(rows[0]?.d).toBeInstanceOf(Date); // raw pg pool default, for contrast
      const { sql } = await import('kysely');
      const result = await sql<{ d: unknown }>`SELECT DATE '2026-04-01' AS d`.execute(live);
      expect(result.rows[0]?.d).toBe('2026-04-01');
    } finally {
      await live.destroy();
    }
  });
});
