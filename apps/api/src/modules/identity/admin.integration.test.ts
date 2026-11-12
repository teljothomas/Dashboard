import { createHash } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  AuditEntryDto,
  DeviceDto,
  ResetCodeResponse,
  RoleDto,
  SessionDto,
  SessionInfo,
  UserDto,
} from '@tradex/contracts';
import { uuidv7 } from '@tradex/domain';
import { MIGRATIONS_DIR, resetDatabase, testDbUrls, truncateAll } from '../../../test/db.js';
import { buildApp } from '../../app.js';
import { createDatabase, type Database } from '../../db/index.js';
import { runMigrations } from '../../db/migrate.js';
import { testConfig } from '../../test-config.js';
import { createOwner, hashPassword } from './index.js';

/**
 * WP-04.4: user and role management, password reset, sessions, devices, audit view. Real sessions
 * over the real production wiring (login, cookie, CSRF), so authorization is judged end to end.
 */

const urls = testDbUrls();
const API = '/api/v1';
const PASSWORD = 'tractor-lantern-meadow-42';
const TEMP_PASSWORD = 'copper-window-garden-58';
const NEW_PASSWORD = 'harbour-violin-orchard-77';
const CODE_PATTERN = /^[A-HJ-KM-NP-Z2-9]{8}$/;

let db: Database;
let owner: pg.Pool;
let app: FastifyInstance | undefined;
let passwordHash: string;
let ownerId: string;

beforeAll(async () => {
  await resetDatabase(urls);
  await runMigrations(urls.owner, MIGRATIONS_DIR);
  db = createDatabase(urls.app);
  owner = new pg.Pool({ connectionString: urls.owner, max: 2 });
  passwordHash = await hashPassword(PASSWORD);
});

beforeEach(async () => {
  await truncateAll(urls);
  ownerId = (
    await createOwner(db, { username: 'asha.owner', displayName: 'Asha', password: PASSWORD })
  ).id;
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

afterAll(async () => {
  await db.destroy();
  await owner.end();
});

function instance(): FastifyInstance {
  app ??= buildApp({ ...testConfig, DATABASE_URL: urls.app }, { db });
  return app;
}

interface Session {
  cookie: string;
  csrf: string;
  deviceId: string;
  info: SessionInfo;
}

async function rawLogin(
  username: string,
  password = PASSWORD,
  deviceId = uuidv7(),
): Promise<LightMyRequestResponse> {
  return instance().inject({
    method: 'POST',
    url: `${API}/auth/login`,
    payload: { username, password, deviceId },
  });
}

async function login(username: string, password = PASSWORD, deviceId = uuidv7()): Promise<Session> {
  const res = await rawLogin(username, password, deviceId);
  expect(res.statusCode, `login ${username}`).toBe(200);
  const raw = res.headers['set-cookie'];
  const header = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
  const info = res.json<{ data: SessionInfo }>().data;
  return { cookie: header.split(';')[0] ?? '', csrf: info.csrfToken, deviceId, info };
}

async function call(
  session: Session,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  return instance().inject({
    method,
    url: `${API}${url}`,
    headers: {
      cookie: session.cookie,
      'x-device-id': session.deviceId,
      ...(method === 'GET' ? {} : { 'x-csrf-token': session.csrf }),
    },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

const data = <T>(res: LightMyRequestResponse): T => res.json<{ data: T }>().data;
const errorOf = (res: LightMyRequestResponse) =>
  res.json<{ error: { code: string; message: string; details?: { reason?: string } } }>().error;

/** Insert an active user directly (no API), holding `roleCode`, optionally division-limited. */
async function mkUser(
  username: string,
  roleCode: string | null,
  options: { divisionId?: string | null; status?: string } = {},
): Promise<string> {
  const id = uuidv7();
  await owner.query(
    `INSERT INTO app_user (id, username, display_name, password_hash, status, must_change_password)
     VALUES ($1, $2, $3, $4, $5, false)`,
    [id, username, username, passwordHash, options.status ?? 'ACTIVE'],
  );
  if (roleCode !== null) {
    await owner.query(
      `INSERT INTO user_role (id, user_id, role_id, division_id)
       SELECT $1, $2, id, $3 FROM role WHERE code = $4`,
      [uuidv7(), id, options.divisionId ?? null, roleCode],
    );
  }
  return id;
}

async function roleId(code: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(`SELECT id FROM role WHERE code = $1`, [code]);
  return (rows[0] as { id: string }).id;
}

async function divisionId(): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM division ORDER BY code LIMIT 1`,
  );
  return (rows[0] as { id: string }).id;
}

async function rows<T extends pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await owner.query<T>(text, params)).rows;
}

async function auditRows(action: string, entityId?: string) {
  return rows<{
    action: string;
    entity_id: string;
    actor_user_id: string | null;
    before: unknown;
    after: Record<string, unknown> | null;
  }>(
    `SELECT action, entity_id, actor_user_id, before, after FROM audit_log
      WHERE action = $1 AND ($2::text IS NULL OR entity_id = $2) ORDER BY id`,
    [action, entityId ?? null],
  );
}

describe('authorization', () => {
  it('a user without the permissions gets 403 on every admin route and nothing is written', async () => {
    await mkUser('dan.driver', 'DRIVER');
    const driver = await login('dan.driver');
    const target = uuidv7();
    const before = (await rows(`SELECT 1 FROM audit_log`)).length;
    const probes: ['GET' | 'POST' | 'PATCH' | 'DELETE', string, unknown?][] = [
      ['GET', '/users'],
      ['POST', '/users', { username: 'x.y.z', displayName: 'X', password: TEMP_PASSWORD }],
      ['GET', `/users/${target}`],
      ['PATCH', `/users/${target}`, { displayName: 'Z' }],
      ['POST', `/users/${target}/unlock`],
      ['POST', `/users/${target}/reset-code`],
      ['GET', `/users/${target}/sessions`],
      ['DELETE', `/users/${target}/sessions`],
      ['GET', `/users/${target}/devices`],
      ['DELETE', `/sessions/${target}`],
      ['POST', `/devices/${target}/revoke`],
      ['GET', '/roles'],
      ['POST', '/roles', { code: 'X_ROLE', name: 'X', permissions: [] }],
      ['GET', `/roles/${target}`],
      ['PATCH', `/roles/${target}`, { name: 'Y' }],
      ['GET', '/audit'],
    ];
    for (const [method, url, payload] of probes) {
      const res = await call(driver, method, url, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(errorOf(res).code).toBe('FORBIDDEN');
    }
    expect((await rows(`SELECT 1 FROM audit_log`)).length).toBe(before);
  });

  it('a division-limited ADMIN is refused (404, fail closed); an unlimited ADMIN passes', async () => {
    await mkUser('lim.admin', 'ADMIN', { divisionId: await divisionId() });
    await mkUser('full.admin', 'ADMIN');
    const limited = await login('lim.admin');
    for (const url of ['/users', '/roles', '/audit']) {
      expect((await call(limited, 'GET', url)).statusCode, url).toBe(404);
    }
    const full = await login('full.admin');
    for (const url of ['/users', '/roles', '/audit']) {
      expect((await call(full, 'GET', url)).statusCode, url).toBe(200);
    }
  });

  it('a mutation without the CSRF token is refused', async () => {
    const session = await login('asha.owner');
    const res = await instance().inject({
      method: 'POST',
      url: `${API}/users`,
      headers: { cookie: session.cookie, 'x-device-id': session.deviceId },
      payload: { username: 'no.csrf', displayName: 'N', password: TEMP_PASSWORD },
    });
    expect(res.statusCode).toBe(403);
    expect(await rows(`SELECT 1 FROM app_user WHERE username = 'no.csrf'`)).toHaveLength(0);
  });
});

describe('users', () => {
  it('creates a user with roles, must_change_password and an audit row without the password', async () => {
    const session = await login('asha.owner');
    const supervisor = await roleId('SUPERVISOR');
    const division = await divisionId();
    const res = await call(session, 'POST', '/users', {
      username: '  New.Hand ',
      displayName: 'New Hand',
      phone: '9876543210',
      password: TEMP_PASSWORD,
      roles: [{ roleId: supervisor, divisionId: division }],
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const user = data<UserDto>(res);
    expect(user).toMatchObject({
      username: 'new.hand',
      displayName: 'New Hand',
      phone: '9876543210',
      status: 'ACTIVE',
      mustChangePassword: true,
    });
    expect(user.roles).toEqual([
      { roleId: supervisor, roleCode: 'SUPERVISOR', roleName: 'Supervisor', divisionId: division },
    ]);
    expect(JSON.stringify(user)).not.toContain('argon2');

    const [stored] = await rows<{ password_hash: string; created_by: string }>(
      `SELECT password_hash, created_by FROM app_user WHERE id = $1`,
      [user.id],
    );
    expect(stored?.password_hash.startsWith('$argon2id$')).toBe(true);
    expect(stored?.created_by).toBe(ownerId);

    const [log] = await auditRows('user.create', user.id);
    expect(log?.actor_user_id).toBe(ownerId);
    expect(log?.after).toMatchObject({
      username: 'new.hand',
      roles: [{ role: 'SUPERVISOR', division_id: division }],
    });
    const everything = JSON.stringify(await rows(`SELECT * FROM audit_log`));
    expect(everything).not.toContain(TEMP_PASSWORD);

    // The new user logs in and is forced to change the password.
    const fresh = await login('new.hand', TEMP_PASSWORD);
    expect(fresh.info.user.mustChangePassword).toBe(true);
  });

  it('rejects duplicate usernames, bad usernames, weak passwords and unknown roles or divisions', async () => {
    const session = await login('asha.owner');
    const base = { displayName: 'A', password: TEMP_PASSWORD };
    const dup = await call(session, 'POST', '/users', { ...base, username: 'ASHA.OWNER' });
    expect(dup.statusCode).toBe(400);
    expect(errorOf(dup).details?.reason).toBe('USERNAME_TAKEN');

    const bad = await call(session, 'POST', '/users', { ...base, username: 'a b' });
    expect(bad.statusCode).toBe(400);

    const weak = await call(session, 'POST', '/users', {
      ...base,
      username: 'weak.one',
      password: 'short',
    });
    expect(weak.statusCode).toBe(400);
    expect(errorOf(weak).details?.reason).toBeDefined();

    const noRole = await call(session, 'POST', '/users', {
      ...base,
      username: 'no.role',
      roles: [{ roleId: uuidv7() }],
    });
    expect(noRole.statusCode).toBe(400);
    expect(errorOf(noRole).details?.reason).toBe('UNKNOWN_ROLE');

    const noDivision = await call(session, 'POST', '/users', {
      ...base,
      username: 'no.division',
      roles: [{ roleId: await roleId('SUPERVISOR'), divisionId: uuidv7() }],
    });
    expect(noDivision.statusCode).toBe(400);
    expect(errorOf(noDivision).details?.reason).toBe('UNKNOWN_DIVISION');
    expect(
      await rows(`SELECT 1 FROM app_user WHERE username IN ('weak.one','no.role','no.division')`),
    ).toHaveLength(0);
  });

  it('only an OWNER can assign the OWNER role; an ADMIN can create other users', async () => {
    await mkUser('adm.in', 'ADMIN');
    const admin = await login('adm.in');
    const ownerRole = await roleId('OWNER');
    const refused = await call(admin, 'POST', '/users', {
      username: 'sneaky.owner',
      displayName: 'S',
      password: TEMP_PASSWORD,
      roles: [{ roleId: ownerRole }],
    });
    expect(refused.statusCode).toBe(403);
    expect(errorOf(refused).details?.reason).toBe('OWNER_ONLY');
    expect(await rows(`SELECT 1 FROM app_user WHERE username = 'sneaky.owner'`)).toHaveLength(0);

    const ok = await call(admin, 'POST', '/users', {
      username: 'plain.driver',
      displayName: 'D',
      password: TEMP_PASSWORD,
      roles: [{ roleId: await roleId('DRIVER') }],
    });
    expect(ok.statusCode).toBe(201);

    const asOwner = await call(await login('asha.owner'), 'POST', '/users', {
      username: 'second.owner',
      displayName: 'S',
      password: TEMP_PASSWORD,
      roles: [{ roleId: ownerRole }],
    });
    expect(asOwner.statusCode).toBe(201);
  });

  it('lists with filters and keyset paging, and reads one user', async () => {
    for (const name of ['aa.one', 'bb.two', 'cc.three']) await mkUser(name, 'DRIVER');
    await mkUser('dd.off', 'DRIVER', { status: 'DISABLED' });
    const session = await login('asha.owner');

    const all = data<UserDto[]>(await call(session, 'GET', '/users?limit=200'));
    expect(all.map((u) => u.username)).toEqual(
      expect.arrayContaining(['asha.owner', 'aa.one', 'bb.two', 'cc.three', 'dd.off']),
    );
    expect(
      data<UserDto[]>(await call(session, 'GET', '/users?status=DISABLED')).map((u) => u.username),
    ).toEqual(['dd.off']);
    expect(
      data<UserDto[]>(await call(session, 'GET', '/users?q=THREE')).map((u) => u.username),
    ).toEqual(['cc.three']);
    // LIKE wildcards in the search text are literal.
    expect(data<UserDto[]>(await call(session, 'GET', '/users?q=%25'))).toHaveLength(0);

    const seen: string[] = [];
    let url = '/users?limit=2';
    for (let guard = 0; guard < 5; guard += 1) {
      const res = await call(session, 'GET', url);
      seen.push(...data<UserDto[]>(res).map((u) => u.username));
      const next = res.json<{ meta?: { nextCursor?: string } }>().meta?.nextCursor;
      if (!next) break;
      url = `/users?limit=2&after=${next}`;
    }
    expect([...seen].sort()).toEqual(['aa.one', 'asha.owner', 'bb.two', 'cc.three', 'dd.off']);

    const one = all.find((u) => u.username === 'aa.one') as UserDto;
    expect(data<UserDto>(await call(session, 'GET', `/users/${one.id}`))).toMatchObject({
      username: 'aa.one',
      roles: [{ roleCode: 'DRIVER' }],
    });
    expect((await call(session, 'GET', `/users/${uuidv7()}`)).statusCode).toBe(404);
    expect((await call(session, 'GET', '/users/not-a-uuid')).statusCode).toBe(400);
  });

  it('updates profile fields with an audit diff, and rejects an empty update', async () => {
    const id = await mkUser('edit.me', 'DRIVER');
    const session = await login('asha.owner');
    const res = await call(session, 'PATCH', `/users/${id}`, {
      displayName: 'Edited Name',
      phone: '9000000001',
    });
    expect(res.statusCode).toBe(200);
    expect(data<UserDto>(res)).toMatchObject({ displayName: 'Edited Name', phone: '9000000001' });
    const [log] = await auditRows('user.update', id);
    expect(log?.after).toEqual({ display_name: 'Edited Name', phone: '9000000001' });
    expect(log?.before).toEqual({ display_name: 'edit.me', phone: null });

    const cleared = await call(session, 'PATCH', `/users/${id}`, { phone: null });
    expect(data<UserDto>(cleared).phone).toBeNull();
    expect((await call(session, 'PATCH', `/users/${id}`, {})).statusCode).toBe(400);
    expect(
      (await call(session, 'PATCH', `/users/${uuidv7()}`, { displayName: 'Q' })).statusCode,
    ).toBe(404);
  });

  it('disables a user: sessions end at once, login fails, audit; enabling restores login', async () => {
    const id = await mkUser('leaver', 'DRIVER');
    const leaver = await login('leaver');
    const session = await login('asha.owner');
    expect((await call(leaver, 'GET', '/auth/me')).statusCode).toBe(200);

    const res = await call(session, 'PATCH', `/users/${id}`, { status: 'DISABLED' });
    expect(res.statusCode).toBe(200);
    expect(data<UserDto>(res).status).toBe('DISABLED');
    expect((await call(leaver, 'GET', '/auth/me')).statusCode).toBe(401);
    expect((await rawLogin('leaver')).statusCode).toBe(401);
    const [log] = await auditRows('user.disable', id);
    expect(log?.after).toMatchObject({ status: 'DISABLED', sessions_revoked: 1 });

    expect((await call(session, 'PATCH', `/users/${id}`, { status: 'ACTIVE' })).statusCode).toBe(
      200,
    );
    expect((await rawLogin('leaver')).statusCode).toBe(200);
    expect(await auditRows('user.enable', id)).toHaveLength(1);
  });

  it('replaces the role set, audits it, and the change applies to the next request', async () => {
    const id = await mkUser('role.swap', 'DRIVER');
    const worker = await login('role.swap');
    expect(worker.info.roles).toEqual(['DRIVER']);
    const session = await login('asha.owner');
    const supervisor = await roleId('SUPERVISOR');
    const division = await divisionId();

    const res = await call(session, 'PATCH', `/users/${id}`, {
      roles: [{ roleId: supervisor, divisionId: division }],
    });
    expect(res.statusCode).toBe(200);
    expect(data<UserDto>(res).roles.map((r) => r.roleCode)).toEqual(['SUPERVISOR']);
    const me = data<SessionInfo>(await call(worker, 'GET', '/auth/me'));
    expect(me.roles).toEqual(['SUPERVISOR']);
    const [log] = await auditRows('user.roles.change', id);
    expect(log?.before).toEqual({ roles: [{ role: 'DRIVER', division_id: null }] });
    expect(log?.after).toEqual({ roles: [{ role: 'SUPERVISOR', division_id: division }] });

    // The same set again changes nothing and writes no second role-change row.
    await call(session, 'PATCH', `/users/${id}`, {
      roles: [{ roleId: supervisor, divisionId: division }],
    });
    expect(await auditRows('user.roles.change', id)).toHaveLength(1);
    // An empty list removes every role.
    const none = await call(session, 'PATCH', `/users/${id}`, { roles: [] });
    expect(data<UserDto>(none).roles).toEqual([]);
  });

  it('nobody changes their own status or roles, or issues themselves a reset code', async () => {
    const session = await login('asha.owner');
    for (const body of [{ status: 'DISABLED' }, { roles: [] }, { status: 'ACTIVE' }]) {
      const res = await call(session, 'PATCH', `/users/${ownerId}`, body);
      expect(res.statusCode).toBe(403);
      expect(errorOf(res).details?.reason).toBe('SELF_MODIFICATION');
    }
    const code = await call(session, 'POST', `/users/${ownerId}/reset-code`);
    expect(code.statusCode).toBe(403);
    // Profile edits on yourself are fine.
    expect(
      (await call(session, 'PATCH', `/users/${ownerId}`, { displayName: 'Asha K' })).statusCode,
    ).toBe(200);
  });

  it('an ADMIN cannot touch an owner account in any way', async () => {
    await mkUser('adm.in', 'ADMIN');
    const admin = await login('adm.in');
    const ownerSession = await login('asha.owner', PASSWORD);
    const sessions = data<SessionDto[]>(
      await call(await login('asha.owner'), 'GET', `/users/${ownerId}/sessions`),
    );
    const attempts: ['POST' | 'PATCH' | 'DELETE', string, unknown?][] = [
      ['PATCH', `/users/${ownerId}`, { displayName: 'Hacked' }],
      ['PATCH', `/users/${ownerId}`, { status: 'DISABLED' }],
      ['POST', `/users/${ownerId}/unlock`],
      ['POST', `/users/${ownerId}/reset-code`],
      ['DELETE', `/users/${ownerId}/sessions`],
      ['DELETE', `/sessions/${sessions[0]?.id ?? uuidv7()}`],
      ['POST', `/devices/${ownerSession.deviceId}/revoke`],
    ];
    for (const [method, url, payload] of attempts) {
      const res = await call(admin, method, url, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(errorOf(res).details?.reason).toBe('OWNER_ONLY');
    }
    const [row] = await rows<{ display_name: string; status: string }>(
      `SELECT display_name, status FROM app_user WHERE id = $1`,
      [ownerId],
    );
    expect(row).toEqual({ display_name: 'Asha', status: 'ACTIVE' });
    expect((await call(ownerSession, 'GET', '/auth/me')).statusCode).toBe(200);
  });

  it('two owners cannot disable each other at once: one active owner always remains', async () => {
    const secondId = (
      await createOwner(db, {
        username: 'ben.owner',
        displayName: 'Ben',
        password: PASSWORD,
        additional: true,
      })
    ).id;
    const asha = await login('asha.owner');
    const ben = await login('ben.owner');
    const results = await Promise.all([
      call(asha, 'PATCH', `/users/${secondId}`, { status: 'DISABLED' }),
      call(ben, 'PATCH', `/users/${ownerId}`, { status: 'DISABLED' }),
    ]);
    expect(results.filter((r) => r.statusCode === 200).length).toBe(1);
    const [count] = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM app_user u
         JOIN user_role ur ON ur.user_id = u.id JOIN role r ON r.id = ur.role_id
        WHERE r.code = 'OWNER' AND u.status = 'ACTIVE'`,
    );
    expect(count?.n).toBe(1);
  });

  it('removing the OWNER role from the other owner works while one owner remains', async () => {
    const secondId = (
      await createOwner(db, {
        username: 'ben.owner',
        displayName: 'Ben',
        password: PASSWORD,
        additional: true,
      })
    ).id;
    const asha = await login('asha.owner');
    const res = await call(asha, 'PATCH', `/users/${secondId}`, { roles: [] });
    expect(res.statusCode).toBe(200);
    expect(data<UserDto>(res).roles).toEqual([]);
  });
});

describe('unlock', () => {
  it('clears the derived lockout without deleting the failures, and audits it', async () => {
    const id = await mkUser('locked.out', 'DRIVER');
    for (let i = 0; i < 5; i += 1)
      expect((await rawLogin('locked.out', 'wrong-password-123')).statusCode).toBe(401);
    const blocked = await rawLogin('locked.out');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();

    const session = await login('asha.owner');
    const res = await call(session, 'POST', `/users/${id}/unlock`);
    expect(res.statusCode).toBe(200);
    expect((await rawLogin('locked.out')).statusCode).toBe(200);

    const failed = await rows(
      `SELECT 1 FROM login_attempt WHERE username = 'locked.out' AND NOT success`,
    );
    expect(failed.length).toBeGreaterThanOrEqual(5);
    const [log] = await auditRows('user.unlock', id);
    expect(log?.after).toMatchObject({ previous_failed_logins: 5 });
    expect((await call(session, 'POST', `/users/${uuidv7()}/unlock`)).statusCode).toBe(404);
  });
});

describe('password reset', () => {
  async function issue(session: Session, userId: string): Promise<ResetCodeResponse> {
    const res = await call(session, 'POST', `/users/${userId}/reset-code`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    return data<ResetCodeResponse>(res);
  }

  const complete = (username: string, code: string, newPassword = NEW_PASSWORD) =>
    instance().inject({
      method: 'POST',
      url: `${API}/auth/reset/complete`,
      payload: { username, code, newPassword },
    });

  it('issues a code once: hashed at rest, 30 minutes, never in the audit log', async () => {
    const id = await mkUser('forgetful', 'DRIVER');
    const session = await login('asha.owner');
    const issued = await issue(session, id);
    expect(issued.code).toMatch(CODE_PATTERN);
    // Judged on the database clock only: the Docker VM clock drifts from the host clock.
    const [ttl] = await rows<{ minutes: number; same: boolean }>(
      `SELECT extract(epoch FROM (expires_at - created_at)) / 60 AS minutes,
              date_trunc('milliseconds', expires_at) = $2::timestamptz AS same
         FROM password_reset WHERE user_id = $1`,
      [id, issued.expiresAt],
    );
    expect(Number(ttl?.minutes)).toBe(30);
    expect(ttl?.same).toBe(true);

    const stored = await rows<{ code_hash: string; issued_by: string }>(
      `SELECT code_hash, issued_by FROM password_reset WHERE user_id = $1`,
      [id],
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]?.issued_by).toBe(ownerId);
    expect(stored[0]?.code_hash).toBe(
      createHash('sha256').update(`reset-v1:${id}:${issued.code}`).digest('hex'),
    );
    expect(JSON.stringify(await rows(`SELECT * FROM audit_log`))).not.toContain(issued.code);
    const [log] = await auditRows('user.reset_code.issue', id);
    expect(log?.actor_user_id).toBe(ownerId);
    expect(Object.keys(log?.after ?? {}).sort()).toEqual(['expires_at', 'reset_id']);
  });

  it('completes: new password works, old one and old sessions do not, code is single use', async () => {
    const id = await mkUser('forgetful', 'DRIVER');
    const old = await login('forgetful');
    const session = await login('asha.owner');
    const { code } = await issue(session, id);

    const res = await complete('Forgetful', code.toLowerCase().replace(/^(.{4})/, '$1-'));
    expect(res.statusCode).toBe(200);
    expect((await call(old, 'GET', '/auth/me')).statusCode).toBe(401);
    expect((await rawLogin('forgetful', PASSWORD)).statusCode).toBe(401);
    const fresh = await login('forgetful', NEW_PASSWORD);
    expect(fresh.info.user.mustChangePassword).toBe(false);

    const reuse = await complete('forgetful', code, 'another-long-password-91');
    expect(reuse.statusCode).toBe(400);
    expect(errorOf(reuse).details?.reason).toBe('RESET_CODE_INVALID');
    expect((await rawLogin('forgetful', NEW_PASSWORD)).statusCode).toBe(200);

    const [row] = await rows<{ used_at: Date | null }>(
      `SELECT used_at FROM password_reset WHERE user_id = $1`,
      [id],
    );
    expect(row?.used_at).not.toBeNull();
    const [log] = await auditRows('auth.password_reset.complete', id);
    expect(log?.actor_user_id).toBe(id);
    expect(log?.after).toMatchObject({ sessions_revoked: 1 });
    expect(JSON.stringify(await rows(`SELECT * FROM audit_log`))).not.toContain(NEW_PASSWORD);
  });

  it('answers wrong code, unknown user, expired code and disabled user identically', async () => {
    const id = await mkUser('forgetful', 'DRIVER');
    await mkUser('gone', 'DRIVER');
    const session = await login('asha.owner');
    const { code } = await issue(session, id);

    const wrong = await complete('forgetful', code === 'AAAAAAAA' ? 'BBBBBBBB' : 'AAAAAAAA');
    const unknown = await complete('nobody.here', code);
    await owner.query(
      `UPDATE password_reset SET expires_at = now() - interval '1 minute' WHERE user_id = $1`,
      [id],
    );
    const expired = await complete('forgetful', code);
    const goneId = (
      await rows<{ id: string }>(`SELECT id FROM app_user WHERE username = 'gone'`)
    )[0]?.id as string;
    const goneCode = await issue(session, goneId);
    await call(session, 'PATCH', `/users/${goneId}`, { status: 'DISABLED' });
    const disabled = await complete('gone', goneCode.code);

    const shape = (res: LightMyRequestResponse) => {
      const { code: c, message, details } = errorOf(res);
      return { status: res.statusCode, c, message, reason: details?.reason };
    };
    const expected = { status: 400, c: 'VALIDATION_FAILED', reason: 'RESET_CODE_INVALID' };
    for (const res of [wrong, unknown, expired, disabled]) {
      expect(shape(res)).toMatchObject(expected);
    }
    expect(new Set([wrong, unknown, expired, disabled].map((r) => shape(r).message)).size).toBe(1);
    // Failures for known users are audited with a reason; unknown names are not written.
    const failures = await auditRows('auth.password_reset.failed');
    expect(failures.map((f) => f.after?.reason).sort()).toEqual([
      'BAD_CODE',
      'NO_LIVE_CODE',
      'USER_NOT_ACTIVE',
    ]);
    expect(JSON.stringify(failures)).not.toContain('nobody.here');
    expect((await rawLogin('forgetful', PASSWORD)).statusCode).toBe(200);
  });

  it('a code only works for its own user, and a new code supersedes the old one', async () => {
    const a = await mkUser('user.a', 'DRIVER');
    await mkUser('user.b', 'DRIVER');
    const session = await login('asha.owner');
    const first = await issue(session, a);
    expect((await complete('user.b', first.code)).statusCode).toBe(400);

    const second = await issue(session, a);
    expect((await complete('user.a', first.code)).statusCode).toBe(400);
    expect((await complete('user.a', second.code)).statusCode).toBe(200);
  });

  it('a weak new password is refused without burning the code or the attempt budget', async () => {
    const id = await mkUser('forgetful', 'DRIVER');
    const session = await login('asha.owner');
    const { code } = await issue(session, id);
    for (let i = 0; i < 8; i += 1) {
      const weak = await complete('forgetful', code, 'short');
      expect(weak.statusCode).toBe(400);
      expect(errorOf(weak).details?.reason).not.toBe('RESET_CODE_INVALID');
    }
    expect((await complete('forgetful', code)).statusCode).toBe(200);
  });

  it('clears an active lockout', async () => {
    const id = await mkUser('forgetful', 'DRIVER');
    for (let i = 0; i < 5; i += 1) await rawLogin('forgetful', 'wrong-password-123');
    expect((await rawLogin('forgetful')).statusCode).toBe(429);
    const session = await login('asha.owner');
    const { code } = await issue(session, id);
    expect((await complete('forgetful', code)).statusCode).toBe(200);
    expect((await rawLogin('forgetful', NEW_PASSWORD)).statusCode).toBe(200);
  });

  it('rate limits wrong codes per username: the sixth attempt is 429 even with the right code', async () => {
    const id = await mkUser('forgetful', 'DRIVER');
    const session = await login('asha.owner');
    const { code } = await issue(session, id);
    const wrong = code === 'AAAAAAAA' ? 'BBBBBBBB' : 'AAAAAAAA';
    for (let i = 0; i < 5; i += 1)
      expect((await complete('forgetful', wrong)).statusCode).toBe(400);
    const limited = await complete('forgetful', code);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect((await rawLogin('forgetful', NEW_PASSWORD)).statusCode).toBe(401);
  });

  it('two parallel completions with one code: exactly one wins', async () => {
    const id = await mkUser('forgetful', 'DRIVER');
    const session = await login('asha.owner');
    const { code } = await issue(session, id);
    const results = await Promise.all([
      complete('forgetful', code, NEW_PASSWORD),
      complete('forgetful', code, 'other-long-password-93'),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    expect(await auditRows('auth.password_reset.complete', id)).toHaveLength(1);
  });

  it('refuses a code for a disabled user', async () => {
    const id = await mkUser('forgetful', 'DRIVER', { status: 'DISABLED' });
    const session = await login('asha.owner');
    const res = await call(session, 'POST', `/users/${id}/reset-code`);
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).details?.reason).toBe('USER_NOT_ACTIVE');
    expect((await call(session, 'POST', `/users/${uuidv7()}/reset-code`)).statusCode).toBe(404);
  });
});

describe('sessions and devices', () => {
  it('lists live sessions and devices, force-logs-out one session and then all', async () => {
    const id = await mkUser('field.hand', 'DRIVER');
    const one = await login('field.hand');
    const two = await login('field.hand');
    const session = await login('asha.owner');

    const listed = data<SessionDto[]>(await call(session, 'GET', `/users/${id}/sessions`));
    expect(listed).toHaveLength(2);
    expect(listed.map((s) => s.deviceId).sort()).toEqual([one.deviceId, two.deviceId].sort());
    expect(JSON.stringify(listed)).not.toMatch(/token/i);
    const devices = data<DeviceDto[]>(await call(session, 'GET', `/users/${id}/devices`));
    expect(devices.map((d) => d.id).sort()).toEqual([one.deviceId, two.deviceId].sort());
    expect(devices.every((d) => d.revokedAt === null)).toBe(true);

    const target = listed.find((s) => s.deviceId === one.deviceId) as SessionDto;
    const del = await call(session, 'DELETE', `/sessions/${target.id}`);
    expect(data<{ revoked: boolean }>(del).revoked).toBe(true);
    expect((await call(one, 'GET', '/auth/me')).statusCode).toBe(401);
    expect((await call(two, 'GET', '/auth/me')).statusCode).toBe(200);
    expect(
      data<{ revoked: boolean }>(await call(session, 'DELETE', `/sessions/${target.id}`)).revoked,
    ).toBe(false);
    expect(await auditRows('session.revoke', target.id)).toHaveLength(1);
    expect(data<SessionDto[]>(await call(session, 'GET', `/users/${id}/sessions`))).toHaveLength(1);

    const all = await call(session, 'DELETE', `/users/${id}/sessions`);
    expect(data<{ revoked: number }>(all).revoked).toBe(1);
    expect((await call(two, 'GET', '/auth/me')).statusCode).toBe(401);
    const [log] = await auditRows('user.sessions.revoke', id);
    expect(log?.after).toMatchObject({ sessions_revoked: 1 });

    expect((await call(session, 'DELETE', `/sessions/${uuidv7()}`)).statusCode).toBe(404);
    expect((await call(session, 'GET', `/users/${uuidv7()}/sessions`)).statusCode).toBe(404);
    expect((await call(session, 'GET', `/users/${uuidv7()}/devices`)).statusCode).toBe(404);
  });

  it('revokes a device: its sessions end, login on it fails, the audit row records it', async () => {
    const id = await mkUser('field.hand', 'DRIVER');
    const phone = await login('field.hand');
    const other = await login('field.hand');
    const session = await login('asha.owner');

    const res = await call(session, 'POST', `/devices/${phone.deviceId}/revoke`);
    expect(res.statusCode).toBe(200);
    expect(data<{ sessionsRevoked: number }>(res).sessionsRevoked).toBe(1);
    expect((await call(phone, 'GET', '/auth/me')).statusCode).toBe(401);
    expect((await call(other, 'GET', '/auth/me')).statusCode).toBe(200);
    expect((await rawLogin('field.hand', PASSWORD, phone.deviceId)).statusCode).toBe(401);
    expect((await rawLogin('field.hand', PASSWORD, uuidv7())).statusCode).toBe(200);

    const devices = data<DeviceDto[]>(await call(session, 'GET', `/users/${id}/devices`));
    expect(devices.find((d) => d.id === phone.deviceId)?.revokedAt).not.toBeNull();
    const [log] = await auditRows('device.revoke', phone.deviceId);
    expect(log?.after).toMatchObject({ revoked: true, user_id: id, sessions_revoked: 1 });

    // Idempotent: a second call revokes nothing and writes no second row.
    expect(
      data<{ sessionsRevoked: number }>(
        await call(session, 'POST', `/devices/${phone.deviceId}/revoke`),
      ).sessionsRevoked,
    ).toBe(0);
    expect(await auditRows('device.revoke', phone.deviceId)).toHaveLength(1);
    expect((await call(session, 'POST', `/devices/${uuidv7()}/revoke`)).statusCode).toBe(404);
  });
});

describe('roles', () => {
  it('lists the system roles with their permissions', async () => {
    const session = await login('asha.owner');
    const roles = data<RoleDto[]>(await call(session, 'GET', '/roles'));
    expect(
      roles
        .filter((r) => r.isSystem)
        .map((r) => r.code)
        .sort(),
    ).toEqual(['ACCOUNTANT', 'ADMIN', 'DRIVER', 'FACTORY_MANAGER', 'OWNER', 'SUPERVISOR']);
    const admin = roles.find((r) => r.code === 'ADMIN') as RoleDto;
    expect(admin.permissions).toContainEqual({ permission: 'users.manage', scope: 'ALL' });
    const one = data<RoleDto>(await call(session, 'GET', `/roles/${admin.id}`));
    expect(one).toEqual(admin);
    expect((await call(session, 'GET', `/roles/${uuidv7()}`)).statusCode).toBe(404);
  });

  it('creates and updates a custom role with audit rows; permission changes apply at once', async () => {
    const session = await login('asha.owner');
    const created = await call(session, 'POST', '/roles', {
      code: 'AUDITOR',
      name: 'Auditor',
      permissions: [
        { permission: 'audit.view', scope: 'ALL' },
        { permission: 'dashboard.view', scope: 'ALL' },
      ],
    });
    expect(created.statusCode).toBe(201);
    const role = data<RoleDto>(created);
    expect(role).toMatchObject({ code: 'AUDITOR', isSystem: false });
    expect(role.permissions.map((p) => p.permission)).toEqual(['audit.view', 'dashboard.view']);
    const [createLog] = await auditRows('role.create', role.id);
    expect(createLog?.after).toMatchObject({ code: 'AUDITOR' });

    const userId = await mkUser('the.auditor', null);
    await call(session, 'PATCH', `/users/${userId}`, { roles: [{ roleId: role.id }] });
    const auditor = await login('the.auditor');
    expect((await call(auditor, 'GET', '/audit')).statusCode).toBe(200);

    const updated = await call(session, 'PATCH', `/roles/${role.id}`, {
      name: 'Auditor (read only)',
      permissions: [{ permission: 'dashboard.view', scope: 'ALL' }],
    });
    expect(updated.statusCode).toBe(200);
    expect(data<RoleDto>(updated).permissions).toEqual([
      { permission: 'dashboard.view', scope: 'ALL' },
    ]);
    expect((await call(auditor, 'GET', '/audit')).statusCode).toBe(403);
    const [updateLog] = await auditRows('role.update', role.id);
    expect(updateLog?.before).toMatchObject({ name: 'Auditor' });
    expect(updateLog?.after).toMatchObject({ name: 'Auditor (read only)' });

    const renamed = await call(session, 'PATCH', `/roles/${role.id}`, { name: 'Viewer' });
    expect(data<RoleDto>(renamed).permissions).toEqual([
      { permission: 'dashboard.view', scope: 'ALL' },
    ]);
  });

  it('rejects duplicate codes, unknown and duplicate permissions, bad codes', async () => {
    const session = await login('asha.owner');
    const ok = { code: 'CUSTOM_ONE', name: 'Custom', permissions: [] };
    expect((await call(session, 'POST', '/roles', ok)).statusCode).toBe(201);
    const dup = await call(session, 'POST', '/roles', ok);
    expect(dup.statusCode).toBe(400);
    expect(errorOf(dup).details?.reason).toBe('ROLE_CODE_TAKEN');
    const systemDup = await call(session, 'POST', '/roles', { ...ok, code: 'OWNER' });
    expect(errorOf(systemDup).details?.reason).toBe('ROLE_CODE_TAKEN');
    const unknown = await call(session, 'POST', '/roles', {
      ...ok,
      code: 'CUSTOM_TWO',
      permissions: [{ permission: 'made.up', scope: 'ALL' }],
    });
    expect(errorOf(unknown).details?.reason).toBe('UNKNOWN_PERMISSION');
    const twice = await call(session, 'POST', '/roles', {
      ...ok,
      code: 'CUSTOM_THREE',
      permissions: [
        { permission: 'audit.view', scope: 'ALL' },
        { permission: 'audit.view', scope: 'OWN' },
      ],
    });
    expect(errorOf(twice).details?.reason).toBe('DUPLICATE_PERMISSION');
    expect((await call(session, 'POST', '/roles', { ...ok, code: 'lower_case' })).statusCode).toBe(
      400,
    );
    expect(
      (
        await call(session, 'POST', '/roles', {
          ...ok,
          code: 'BAD_SCOPE',
          permissions: [{ permission: 'audit.view', scope: 'EVERYTHING' }],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      await rows(`SELECT 1 FROM role WHERE code IN ('CUSTOM_TWO','CUSTOM_THREE','BAD_SCOPE')`),
    ).toHaveLength(0);
  });

  it('system roles are immutable through the API', async () => {
    const session = await login('asha.owner');
    const admin = data<RoleDto[]>(await call(session, 'GET', '/roles')).find(
      (r) => r.code === 'ADMIN',
    ) as RoleDto;
    for (const body of [
      { name: 'Renamed' },
      { permissions: [] },
      { name: 'Renamed', permissions: [{ permission: 'audit.view', scope: 'ALL' }] },
    ]) {
      const res = await call(session, 'PATCH', `/roles/${admin.id}`, body);
      expect(res.statusCode).toBe(403);
      expect(errorOf(res).details?.reason).toBe('SYSTEM_ROLE_IMMUTABLE');
    }
    const after = data<RoleDto>(await call(session, 'GET', `/roles/${admin.id}`));
    expect(after).toEqual(admin);
    expect(await auditRows('role.update', admin.id)).toHaveLength(0);
    expect((await call(session, 'PATCH', `/roles/${uuidv7()}`, { name: 'X' })).statusCode).toBe(
      404,
    );
    expect((await call(session, 'PATCH', `/roles/${admin.id}`, {})).statusCode).toBe(400);
  });
});

describe('audit view', () => {
  it('filters by entity, action and actor, pages newest first, and validates the query', async () => {
    const session = await login('asha.owner');
    const id = await mkUser('trail.user', 'DRIVER');
    await call(session, 'PATCH', `/users/${id}`, { displayName: 'One' });
    await call(session, 'PATCH', `/users/${id}`, { displayName: 'Two' });
    await call(session, 'PATCH', `/users/${id}`, { displayName: 'Three' });

    const forUser = data<AuditEntryDto[]>(
      await call(session, 'GET', `/audit?entityType=app_user&entityId=${id}`),
    );
    expect(forUser.map((e) => e.action)).toEqual(['user.update', 'user.update', 'user.update']);
    expect(forUser.map((e) => (e.after as { display_name: string }).display_name)).toEqual([
      'Three',
      'Two',
      'One',
    ]);
    expect(forUser[0]).toMatchObject({
      entityType: 'app_user',
      entityId: id,
      actorUserId: ownerId,
    });
    expect(Number(forUser[0]?.id)).toBeGreaterThan(Number(forUser[1]?.id));
    expect(Date.parse(forUser[0]?.at ?? '')).not.toBeNaN();

    const logins = data<AuditEntryDto[]>(await call(session, 'GET', '/audit?action=auth.login'));
    expect(logins.length).toBeGreaterThanOrEqual(1);
    expect(logins.every((e) => e.action === 'auth.login')).toBe(true);
    const byActor = data<AuditEntryDto[]>(
      await call(session, 'GET', `/audit?actorUserId=${ownerId}&action=user.update`),
    );
    expect(byActor).toHaveLength(3);

    const page1 = await call(session, 'GET', `/audit?entityId=${id}&limit=2`);
    const first = data<AuditEntryDto[]>(page1);
    expect(first).toHaveLength(2);
    const cursor = page1.json<{ meta?: { nextCursor?: string } }>().meta?.nextCursor;
    expect(cursor).toBe(first[1]?.id);
    const page2 = data<AuditEntryDto[]>(
      await call(session, 'GET', `/audit?entityId=${id}&limit=2&before=${cursor}`),
    );
    expect(page2).toHaveLength(1);
    expect(page2[0]?.after).toMatchObject({ display_name: 'One' });

    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect(
      data<AuditEntryDto[]>(
        await call(session, 'GET', `/audit?from=${encodeURIComponent(future)}`),
      ),
    ).toHaveLength(0);
    const past = new Date(Date.now() - 3_600_000).toISOString();
    expect(
      data<AuditEntryDto[]>(
        await call(
          session,
          'GET',
          `/audit?entityId=${id}&from=${encodeURIComponent(past)}&to=${encodeURIComponent(future)}`,
        ),
      ),
    ).toHaveLength(3);

    for (const bad of [
      'limit=0',
      'limit=500',
      'actorUserId=nope',
      'before=abc',
      'from=yesterday',
    ]) {
      expect((await call(session, 'GET', `/audit?${bad}`)).statusCode, bad).toBe(400);
    }
  });

  it('records the reset and role events an admin needs to review', async () => {
    const session = await login('asha.owner');
    const id = await mkUser('trail.user', 'DRIVER');
    await call(session, 'POST', `/users/${id}/reset-code`);
    const entries = data<AuditEntryDto[]>(await call(session, 'GET', `/audit?entityId=${id}`));
    expect(entries.map((e) => e.action)).toContain('user.reset_code.issue');
    expect(JSON.stringify(entries)).not.toMatch(/code_hash|password_hash/);
  });
});
