import { createHash } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionInfo } from '@tradex/contracts';
import { uuidv7 } from '@tradex/domain';
import { MIGRATIONS_DIR, resetDatabase, testDbUrls, truncateAll } from '../../../test/db.js';
import { buildApp } from '../../app.js';
import { createDatabase, type Database } from '../../db/index.js';
import { runMigrations } from '../../db/migrate.js';
import { authorize } from '../../plugins/authorize.js';
import { requireContext } from '../../plugins/requestContext.js';
import { scopeWhere } from '../../lib/scope.js';
import { testConfig } from '../../test-config.js';
import { createOwner, hashPassword } from './index.js';

/**
 * WP-04.6 security suite, over the real production wiring (login, cookie, CSRF, authorize):
 *
 * - TS-S01: a DRIVER asking for an owner report gets 403.
 * - TS-S02: another user's record (OWN) or another division's record (DIVISION) gets 404, the same
 *   answer as a record that does not exist, on single reads and on lists.
 * - TS-S04: an expired or revoked session gets 401 on every kind of route, not only /auth/me.
 *
 * A throwaway table `sec_test_record` plays the "test entity"; the routes below are registered on
 * the app instance only inside this file.
 */

const urls = testDbUrls();
const API = '/api/v1';
const PASSWORD = 'tractor-lantern-meadow-42';

let db: Database;
let owner: pg.Pool;
let app: FastifyInstance | undefined;
let passwordHash: string;
let meat: string;
let logistics: string;

beforeAll(async () => {
  await resetDatabase(urls);
  await runMigrations(urls.owner, MIGRATIONS_DIR);
  db = createDatabase(urls.app);
  owner = new pg.Pool({ connectionString: urls.owner, max: 2 });
  passwordHash = await hashPassword(PASSWORD);
  await owner.query(
    `CREATE TABLE sec_test_record (
       id          uuid PRIMARY KEY,
       owner_id    uuid NOT NULL,
       division_id uuid NOT NULL,
       label       text NOT NULL
     )`,
  );
  const { rows } = await owner.query<{ id: string; code: string }>(`SELECT id, code FROM division`);
  meat = (rows.find((r) => r.code === 'MEAT') as { id: string }).id;
  logistics = (rows.find((r) => r.code === 'LOGISTICS') as { id: string }).id;
});

beforeEach(async () => {
  await truncateAll(urls);
  await createOwner(db, { username: 'asha.owner', displayName: 'Asha', password: PASSWORD });
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

afterAll(async () => {
  await db.destroy();
  await owner.end();
});

interface RecordRow extends Record<string, unknown> {
  id: string;
  label: string;
}

/** The app with the test entity routes: two scoped reads (OWN and DIVISION) and one list each. */
function instance(): FastifyInstance {
  if (app) return app;
  const built = buildApp({ ...testConfig, DATABASE_URL: urls.app }, { db });
  const target = async (id: string) => {
    const { rows } = await sql<{ owner_id: string; division_id: string }>`
      SELECT owner_id, division_id FROM sec_test_record WHERE id::text = ${id}`.execute(db);
    // A record that does not exist resolves to an empty target, which no limited grant covers.
    return { ownerId: rows[0]?.owner_id ?? null, divisionId: rows[0]?.division_id ?? null };
  };
  for (const [path, permission] of [
    ['own', 'expense.view'],
    ['division', 'inventory.view'],
  ] as const) {
    built.get<{ Params: { id: string } }>(
      `${API}/_sec/${path}/:id`,
      {
        config: {
          auth: authorize(permission, {
            scope: (request) => target((request.params as { id: string }).id),
          }),
        },
      },
      async (request) => {
        const { rows } = await sql<RecordRow>`
          SELECT id, label FROM sec_test_record WHERE id::text = ${request.params.id}`.execute(db);
        return { data: rows[0] ?? null };
      },
    );
    built.get(
      `${API}/_sec/${path}`,
      { config: { auth: authorize(permission) } },
      async (request) => {
        const ctx = requireContext(request);
        const where = scopeWhere(ctx, permission, {
          ownerColumn: 'owner_id',
          divisionColumn: 'division_id',
        });
        const { rows } = await sql<RecordRow>`
          SELECT id, label FROM sec_test_record WHERE ${where} ORDER BY label`.execute(db);
        return { data: rows.map((r) => r.label) };
      },
    );
  }
  built.get(
    `${API}/_sec/financial-report`,
    { config: { auth: authorize('report.financial.view') } },
    () => ({ data: 'owner-eyes-only' }),
  );
  built.post(
    `${API}/_sec/financial-report`,
    { config: { auth: authorize('report.financial.view') } },
    () => ({ data: 'created' }),
  );
  app = built;
  return built;
}

interface Session {
  cookie: string;
  csrf: string;
  deviceId: string;
  userId: string;
}

async function rawLogin(username: string, deviceId = uuidv7()): Promise<LightMyRequestResponse> {
  return instance().inject({
    method: 'POST',
    url: `${API}/auth/login`,
    payload: { username, password: PASSWORD, deviceId },
  });
}

async function login(username: string, deviceId = uuidv7()): Promise<Session> {
  const res = await rawLogin(username, deviceId);
  expect(res.statusCode, `login ${username}`).toBe(200);
  const raw = res.headers['set-cookie'];
  const header = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
  const info = res.json<{ data: SessionInfo }>().data;
  return {
    cookie: header.split(';')[0] ?? '',
    csrf: info.csrfToken,
    deviceId,
    userId: info.user.id,
  };
}

function get(session: Session, url: string): Promise<LightMyRequestResponse> {
  return instance().inject({
    method: 'GET',
    url: `${API}${url}`,
    headers: { cookie: session.cookie, 'x-device-id': session.deviceId },
  });
}

const errorCode = (res: LightMyRequestResponse) =>
  res.json<{ error: { code: string } }>().error.code;

async function mkUser(
  username: string,
  roleCode: string,
  divisionId: string | null = null,
): Promise<string> {
  const id = uuidv7();
  await owner.query(
    `INSERT INTO app_user (id, username, display_name, password_hash, status, must_change_password)
     VALUES ($1, $2, $2, $3, 'ACTIVE', false)`,
    [id, username, passwordHash],
  );
  await owner.query(
    `INSERT INTO user_role (id, user_id, role_id, division_id)
     SELECT $1, $2, id, $3 FROM role WHERE code = $4`,
    [uuidv7(), id, divisionId, roleCode],
  );
  return id;
}

async function mkRecord(ownerId: string, divisionId: string, label: string): Promise<string> {
  const id = uuidv7();
  await owner.query(
    `INSERT INTO sec_test_record (id, owner_id, division_id, label) VALUES ($1, $2, $3, $4)`,
    [id, ownerId, divisionId, label],
  );
  return id;
}

describe('TS-S01 driver cannot reach owner reports', () => {
  it('DRIVER gets 403 FORBIDDEN, ACCOUNTANT and OWNER get 200', async () => {
    await mkUser('dev.driver', 'DRIVER');
    await mkUser('amy.accountant', 'ACCOUNTANT');
    const driver = await login('dev.driver');
    const denied = await get(driver, '/_sec/financial-report');
    expect(denied.statusCode).toBe(403);
    expect(errorCode(denied)).toBe('FORBIDDEN');
    expect(denied.body).not.toContain('owner-eyes-only');

    for (const username of ['amy.accountant', 'asha.owner']) {
      const ok = await get(await login(username), '/_sec/financial-report');
      expect(ok.statusCode, username).toBe(200);
    }
  });

  it('the permission is judged before CSRF-protected writes run (DRIVER POST is 403)', async () => {
    await mkUser('dev.driver', 'DRIVER');
    const driver = await login('dev.driver');
    const res = await instance().inject({
      method: 'POST',
      url: `${API}/_sec/financial-report`,
      headers: {
        cookie: driver.cookie,
        'x-device-id': driver.deviceId,
        'x-csrf-token': driver.csrf,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('the grants served by /auth/me for a DRIVER carry no financial or admin permission', async () => {
    await mkUser('dev.driver', 'DRIVER');
    const driver = await login('dev.driver');
    const me = (await get(driver, '/auth/me')).json<{ data: SessionInfo }>().data;
    // `permissions` holds grant objects ({ permission, scope, divisionId }), not strings.
    const codes = me.permissions.map((grant) => grant.permission);
    expect(codes.length).toBeGreaterThan(0);
    expect(codes).toContain('trip.view');
    expect(codes).not.toContain('report.financial.view');
    expect(codes).not.toContain('users.manage');
    expect(new Set(me.permissions.map((grant) => grant.scope))).toEqual(new Set(['OWN']));
    expect(me.roles).toEqual(['DRIVER']);
  });
});

describe('TS-S02 out-of-scope records are 404', () => {
  it("OWN: a driver cannot read another driver's record; it looks like a missing one", async () => {
    const a = await mkUser('driver.a', 'DRIVER');
    const b = await mkUser('driver.b', 'DRIVER');
    const mine = await mkRecord(a, meat, 'a-record');
    const theirs = await mkRecord(b, meat, 'b-record');
    const session = await login('driver.a');

    const own = await get(session, `/_sec/own/${mine}`);
    expect(own.statusCode).toBe(200);

    const other = await get(session, `/_sec/own/${theirs}`);
    const missing = await get(session, `/_sec/own/${uuidv7()}`);
    expect(other.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(errorCode(other)).toBe('NOT_FOUND');
    // Same body shape: nothing tells an existing foreign record from a missing one.
    const strip = (res: LightMyRequestResponse) =>
      JSON.stringify(res.json<{ error: Record<string, unknown> }>().error, (k, v) =>
        k === 'requestId' ? undefined : (v as unknown),
      );
    expect(strip(other)).toBe(strip(missing));
    expect(other.body).not.toContain('b-record');
  });

  it('OWN: a list holds only the caller records', async () => {
    const a = await mkUser('driver.a', 'DRIVER');
    const b = await mkUser('driver.b', 'DRIVER');
    await mkRecord(a, meat, 'a1');
    await mkRecord(a, logistics, 'a2');
    await mkRecord(b, meat, 'b1');
    const list = await get(await login('driver.a'), '/_sec/own');
    expect(list.json<{ data: string[] }>().data).toEqual(['a1', 'a2']);
  });

  it('ALL scope reads every record', async () => {
    const b = await mkUser('driver.b', 'DRIVER');
    await mkUser('amy.accountant', 'ACCOUNTANT');
    const theirs = await mkRecord(b, meat, 'b-record');
    const session = await login('amy.accountant');
    expect((await get(session, `/_sec/own/${theirs}`)).statusCode).toBe(200);
    expect((await get(session, '/_sec/own')).json<{ data: string[] }>().data).toEqual(['b-record']);
  });

  it('DIVISION: a manager limited to MEAT sees MEAT records and gets 404 for LOGISTICS', async () => {
    const someone = await mkUser('driver.x', 'DRIVER');
    const meatRow = await mkRecord(someone, meat, 'meat-row');
    const logRow = await mkRecord(someone, logistics, 'logistics-row');
    await mkUser('mia.manager', 'FACTORY_MANAGER', meat);
    const session = await login('mia.manager');

    expect((await get(session, `/_sec/division/${meatRow}`)).statusCode).toBe(200);
    const denied = await get(session, `/_sec/division/${logRow}`);
    expect(denied.statusCode).toBe(404);
    expect(denied.body).not.toContain('logistics-row');
    expect((await get(session, '/_sec/division')).json<{ data: string[] }>().data).toEqual([
      'meat-row',
    ]);
  });

  it('DIVISION fails closed: a manager with no division on the assignment sees nothing', async () => {
    const someone = await mkUser('driver.x', 'DRIVER');
    const row = await mkRecord(someone, meat, 'meat-row');
    await mkUser('nora.nolimit', 'FACTORY_MANAGER', null);
    const session = await login('nora.nolimit');
    expect((await get(session, `/_sec/division/${row}`)).statusCode).toBe(404);
    expect((await get(session, '/_sec/division')).json<{ data: string[] }>().data).toEqual([]);
  });

  it('a permission the role never had is 403, not 404 (the route exists for you to be told)', async () => {
    await mkUser('dev.driver', 'DRIVER');
    const session = await login('dev.driver');
    expect((await get(session, `/_sec/division/${uuidv7()}`)).statusCode).toBe(403);
    expect((await get(session, '/_sec/division')).statusCode).toBe(403);
  });
});

describe('TS-S04 expired or revoked sessions are 401 everywhere', () => {
  const ROUTES = ['/auth/me', '/_sec/financial-report', `/_sec/own/${uuidv7()}`, '/_sec/own'];

  async function expectAll401(session: Session, label: string): Promise<void> {
    for (const url of ROUTES) {
      const res = await get(session, url);
      expect(res.statusCode, `${label} ${url}`).toBe(401);
      expect(errorCode(res), `${label} ${url}`).toBe('UNAUTHENTICATED');
    }
  }

  it('a live session works on the same routes (control)', async () => {
    const session = await login('asha.owner');
    for (const url of ROUTES.slice(0, 2)) {
      expect((await get(session, url)).statusCode, url).toBe(200);
    }
  });

  it('idle expiry', async () => {
    const session = await login('asha.owner');
    await owner.query(
      `UPDATE session SET expires_at = now() - interval '1 minute', last_seen_at = now()`,
    );
    await expectAll401(session, 'idle');
  });

  it('absolute expiry, even when the idle window is still open', async () => {
    const session = await login('asha.owner');
    await owner.query(
      `UPDATE session SET expires_at = now() - interval '2 minutes',
                          absolute_expires_at = now() - interval '1 minute'`,
    );
    await expectAll401(session, 'absolute');
  });

  it('logout revokes the session server side; the old cookie is dead', async () => {
    const session = await login('asha.owner');
    const out = await instance().inject({
      method: 'POST',
      url: `${API}/auth/logout`,
      headers: {
        cookie: session.cookie,
        'x-device-id': session.deviceId,
        'x-csrf-token': session.csrf,
      },
    });
    expect(out.statusCode).toBe(200);
    await expectAll401(session, 'logged out');
  });

  it('admin force logout and device revoke end the session at once', async () => {
    await mkUser('dev.driver', 'DRIVER');
    const target = await login('dev.driver');
    const admin = await login('asha.owner');
    const adminCall = (method: 'DELETE' | 'POST', url: string) =>
      instance().inject({
        method,
        url: `${API}${url}`,
        headers: {
          cookie: admin.cookie,
          'x-device-id': admin.deviceId,
          'x-csrf-token': admin.csrf,
        },
      });
    const forced = await adminCall('DELETE', `/users/${target.userId}/sessions`);
    expect(forced.statusCode).toBe(200);
    await expectAll401(target, 'force logout');

    const second = await login('dev.driver');
    const revoked = await adminCall('POST', `/devices/${second.deviceId}/revoke`);
    expect(revoked.statusCode).toBe(200);
    await expectAll401(second, 'device revoke');
    // The administrator keeps working.
    expect((await get(admin, '/auth/me')).statusCode).toBe(200);
  });

  it('a disabled user is cut off on the next request', async () => {
    await mkUser('dev.driver', 'DRIVER');
    const session = await login('dev.driver');
    await owner.query(`UPDATE app_user SET status = 'DISABLED' WHERE username = 'dev.driver'`);
    expect((await get(session, '/auth/me')).statusCode).toBe(401);
  });

  it('a forged, truncated or foreign token never authenticates', async () => {
    const real = await login('asha.owner');
    const token = real.cookie.split('=').slice(1).join('=');
    const name = real.cookie.split('=')[0] ?? '';
    const variants = [
      `${name}=${token.slice(0, -2)}`,
      `${name}=${token}x`,
      `${name}=${'a'.repeat(token.length)}`,
      `${name}=`,
      `${name}=${createHash('sha256').update(token).digest('hex')}`,
    ];
    for (const cookie of variants) {
      const res = await instance().inject({
        method: 'GET',
        url: `${API}/_sec/financial-report`,
        headers: { cookie, 'x-device-id': real.deviceId },
      });
      expect(res.statusCode, cookie.slice(0, 40)).toBe(401);
    }
    expect((await get(real, '/_sec/financial-report')).statusCode).toBe(200);
  });

  it('a revoked session stays dead even though its row still exists (no resurrection by login)', async () => {
    const session = await login('asha.owner');
    await owner.query(`UPDATE session SET revoked_at = now()`);
    await expectAll401(session, 'revoked');
    const fresh = await login('asha.owner');
    expect(fresh.cookie).not.toBe(session.cookie);
    expect((await get(session, '/auth/me')).statusCode).toBe(401);
    expect((await get(fresh, '/auth/me')).statusCode).toBe(200);
  });
});
