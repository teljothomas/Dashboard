import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { hash as argonHash, type Algorithm } from '@node-rs/argon2';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionInfo } from '@tradex/contracts';
import { uuidv7 } from '@tradex/domain';
import { MIGRATIONS_DIR, resetDatabase, testDbUrls, truncateAll } from '../../../test/db.js';
import { buildApp } from '../../app.js';
import { createDatabase, type Database } from '../../db/index.js';
import { runMigrations } from '../../db/migrate.js';
import { testConfig } from '../../test-config.js';
import { createOwner } from './index.js';

const urls = testDbUrls();
const PASSWORD = 'tractor-lantern-meadow-42';
const NEW_PASSWORD = 'harbour-violin-orchard-77';
const USERNAME = 'asha.owner';
const API = '/api/v1';

let db: Database;
let owner: pg.Pool;
let app: FastifyInstance | undefined;
let logs: string[] = [];
let userId: string;

beforeAll(async () => {
  await resetDatabase(urls);
  await runMigrations(urls.owner, MIGRATIONS_DIR);
  db = createDatabase(urls.app);
  owner = new pg.Pool({ connectionString: urls.owner, max: 2 });
});

beforeEach(async () => {
  await truncateAll(urls);
  logs = [];
  userId = (await createOwner(db, { username: USERNAME, displayName: 'Asha', password: PASSWORD }))
    .id;
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

afterAll(async () => {
  await db.destroy();
  await owner.end();
});

function makeApp(nodeEnv: 'test' | 'production' = 'test'): FastifyInstance {
  const logStream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      logs.push(chunk.toString());
      cb();
    },
  });
  app = buildApp(
    { ...testConfig, NODE_ENV: nodeEnv, LOG_LEVEL: 'debug', DATABASE_URL: urls.app },
    { db, logStream },
  );
  return app;
}

interface Body {
  data: SessionInfo;
  error: { code: string; message: string; details: { reason?: string } };
}

interface Session {
  cookie: string;
  token: string;
  csrf: string;
  deviceId: string;
  body: SessionInfo;
}

function cookieOf(res: LightMyRequestResponse): { header: string; token: string } {
  const raw = res.headers['set-cookie'];
  const header = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
  const token = /^[^=]+=([^;]*)/.exec(header)?.[1] ?? '';
  return { header, token };
}

async function rawLogin(
  instance: FastifyInstance,
  password = PASSWORD,
  username = USERNAME,
  deviceId = uuidv7(),
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return instance.inject({
    method: 'POST',
    url: `${API}/auth/login`,
    headers,
    payload: { username, password, deviceId },
  });
}

async function loginOk(
  instance: FastifyInstance,
  password = PASSWORD,
  deviceId = uuidv7(),
): Promise<Session> {
  const res = await rawLogin(instance, password, USERNAME, deviceId);
  expect(res.statusCode).toBe(200);
  const { header, token } = cookieOf(res);
  expect(header).not.toBe('');
  const body = res.json<Body>().data;
  return {
    cookie: `${header.split(';')[0] ?? ''}`,
    token,
    csrf: body.csrfToken,
    deviceId,
    body,
  };
}

function authed(session: Session, csrf = true): Record<string, string> {
  return {
    cookie: session.cookie,
    'x-device-id': session.deviceId,
    ...(csrf ? { 'x-csrf-token': session.csrf } : {}),
  };
}

async function one<T extends pg.QueryResultRow>(
  sqlText: string,
  params: unknown[] = [],
): Promise<T> {
  const { rows } = await owner.query<T>(sqlText, params);
  return rows[0] as T;
}

async function failures(n: number, instance: FastifyInstance, username = USERNAME): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    const res = await rawLogin(instance, 'wrong-password-123', username);
    expect(res.statusCode).toBe(401);
  }
}

describe('POST /auth/login', () => {
  it('logs in: cookie, body, hashed token, device, attempt and audit rows', async () => {
    const instance = makeApp();
    const session = await loginOk(instance);

    const res = await rawLogin(instance, PASSWORD, USERNAME, session.deviceId);
    const { header } = cookieOf(res);
    for (const attr of ['HttpOnly', 'SameSite=Lax', 'Path=/']) expect(header).toContain(attr);
    expect(header).toMatch(/^tradex_sid=/);
    expect(res.headers['cache-control']).toBe('no-store');

    expect(session.body.user).toMatchObject({
      id: userId,
      username: USERNAME,
      displayName: 'Asha',
      mustChangePassword: false,
    });
    expect(session.body.roles).toEqual(['OWNER']);
    expect(session.body.permissions.length).toBeGreaterThan(10);
    expect(session.body.permissions[0]).toHaveProperty('scope');
    expect(typeof session.csrf).toBe('string');
    // The token is never in the body.
    expect(JSON.stringify(session.body)).not.toContain(session.token);

    const stored = await one<{ token_hash: string; user_id: string; device_id: string }>(
      `SELECT token_hash, user_id, device_id FROM session WHERE token_hash = $1`,
      [createHash('sha256').update(session.token).digest('hex')],
    );
    expect(stored.user_id).toBe(userId);
    expect(stored.device_id).toBe(session.deviceId);
    const rawRows = await owner.query(`SELECT 1 FROM session WHERE token_hash = $1`, [
      session.token,
    ]);
    expect(rawRows.rowCount).toBe(0);

    const device = await one<{ user_id: string }>(`SELECT user_id FROM device WHERE id = $1`, [
      session.deviceId,
    ]);
    expect(device.user_id).toBe(userId);
    const attempt = await one<{ success: boolean }>(
      `SELECT success FROM login_attempt ORDER BY id LIMIT 1`,
    );
    expect(attempt.success).toBe(true);
    const audit = await one<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE action = 'auth.login' AND entity_id = $1`,
      [userId],
    );
    expect(Number(audit.n)).toBeGreaterThan(0);
    const user = await one<{ last_login_at: Date | null }>(
      `SELECT last_login_at FROM app_user WHERE id = $1`,
      [userId],
    );
    expect(user.last_login_at).not.toBeNull();
  });

  it('answers the same generic 401 for wrong password, unknown user and disabled user', async () => {
    const instance = makeApp();
    const wrong = await rawLogin(instance, 'wrong-password-123');
    const unknown = await rawLogin(instance, PASSWORD, 'nobody.here');
    await owner.query(`UPDATE app_user SET status = 'DISABLED' WHERE id = $1`, [userId]);
    const disabled = await rawLogin(instance, PASSWORD);
    for (const res of [wrong, unknown, disabled]) {
      expect(res.statusCode).toBe(401);
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    const messages = [wrong, unknown, disabled].map((r) => r.json<Body>().error.message);
    expect(new Set(messages).size).toBe(1);
    expect(new Set([wrong, unknown, disabled].map((r) => r.json<Body>().error.code)).size).toBe(1);

    const attempts = await one<{ n: string }>(
      `SELECT count(*)::text AS n FROM login_attempt WHERE success = false`,
    );
    expect(Number(attempts.n)).toBe(3);
    const audit = await one<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE action = 'auth.login.failed'`,
    );
    expect(Number(audit.n)).toBe(3);
    // Unknown usernames are not written to the audit log.
    const leaked = await one<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE entity_id = 'nobody.here' OR after::text LIKE '%nobody%'`,
    );
    expect(Number(leaked.n)).toBe(0);
  });

  it('rejects an invalid body with 400', async () => {
    const res = await makeApp().inject({
      method: 'POST',
      url: `${API}/auth/login`,
      payload: { username: USERNAME },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<Body>().error.code).toBe('VALIDATION_FAILED');
  });

  it('locks the username after 5 failures (429 + Retry-After), also for unknown names', async () => {
    const instance = makeApp();
    await failures(5, instance);
    const locked = await rawLogin(instance, PASSWORD);
    expect(locked.statusCode).toBe(429);
    expect(locked.json<Body>().error.code).toBe('RATE_LIMITED');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(locked.headers['retry-after'])).toBeLessThanOrEqual(900);
    // The refused attempt is not recorded as a further failure.
    const n = await one<{ n: string }>(
      `SELECT count(*)::text AS n FROM login_attempt WHERE username = $1`,
      [USERNAME],
    );
    expect(Number(n.n)).toBe(5);
    const mirror = await one<{ failed_logins: number }>(
      `SELECT failed_logins FROM app_user WHERE id = $1`,
      [userId],
    );
    expect(mirror.failed_logins).toBe(5);

    // An unknown username locks in exactly the same way (no account enumeration).
    await failures(5, instance, 'ghost.user');
    const ghost = await rawLogin(instance, PASSWORD, 'ghost.user');
    expect(ghost.statusCode).toBe(429);
    expect(ghost.headers['retry-after']).toBeDefined();
  });

  it('lets the user in again once the failures leave the 15 minute window', async () => {
    const instance = makeApp();
    await failures(5, instance);
    expect((await rawLogin(instance)).statusCode).toBe(429);
    await owner.query(`UPDATE login_attempt SET at = now() - interval '16 minutes'`);
    expect((await rawLogin(instance)).statusCode).toBe(200);
  });

  it('does not let parallel guesses slip past the limit', async () => {
    const instance = makeApp();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => rawLogin(instance, 'wrong-password-123')),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 401)).toHaveLength(5);
    expect(codes.filter((c) => c === 429)).toHaveLength(3);
  });

  it('a successful login resets the failure count', async () => {
    const instance = makeApp();
    await failures(4, instance);
    expect((await rawLogin(instance)).statusCode).toBe(200);
    await failures(4, instance);
    expect((await rawLogin(instance)).statusCode).toBe(200);
  });

  it('limits an IP to 20 failures per 15 minutes across usernames', async () => {
    const instance = makeApp();
    for (let i = 0; i < 20; i += 1) {
      const res = await rawLogin(instance, 'wrong-password-123', `user.number${String(i)}`);
      expect(res.statusCode).toBe(401);
    }
    const blocked = await rawLogin(instance, PASSWORD, 'someone.new');
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    // A different IP is not affected.
    const other = await instance.inject({
      method: 'POST',
      url: `${API}/auth/login`,
      remoteAddress: '10.9.8.7',
      payload: { username: USERNAME, password: PASSWORD, deviceId: uuidv7() },
    });
    expect(other.statusCode).toBe(200);
  });

  it('caps login requests per IP per minute before touching the database', async () => {
    const instance = makeApp();
    let limited = 0;
    for (let i = 0; i < 32; i += 1) {
      const res = await instance.inject({
        method: 'POST',
        url: `${API}/auth/login`,
        payload: { bad: true },
      });
      if (res.statusCode === 429) limited += 1;
    }
    expect(limited).toBe(2);
  });

  it('rehashes a password stored with weaker Argon2 parameters', async () => {
    const weak = await argonHash(PASSWORD, {
      algorithm: 2 as Algorithm,
      memoryCost: 8192,
      timeCost: 1,
      parallelism: 1,
    });
    await owner.query(`UPDATE app_user SET password_hash = $1 WHERE id = $2`, [weak, userId]);
    await loginOk(makeApp());
    const row = await one<{ password_hash: string }>(
      `SELECT password_hash FROM app_user WHERE id = $1`,
      [userId],
    );
    expect(row.password_hash).toContain('m=19456,t=2,p=1');
  });

  it('retires the session the request already carried', async () => {
    const instance = makeApp();
    const first = await loginOk(instance);
    const res = await rawLogin(instance, PASSWORD, USERNAME, first.deviceId, {
      cookie: first.cookie,
    });
    expect(res.statusCode).toBe(200);
    const me = await instance.inject({
      method: 'GET',
      url: `${API}/auth/me`,
      headers: authed(first, false),
    });
    expect(me.statusCode).toBe(401);
  });

  it('uses the __Host- cookie name with Secure in production', async () => {
    const instance = makeApp('production');
    const res = await rawLogin(instance);
    expect(res.statusCode).toBe(200);
    const { header } = cookieOf(res);
    expect(header).toMatch(/^__Host-tradex_sid=/);
    expect(header).toContain('Secure');
    expect(header).not.toContain('Domain');
  });
});

describe('sessions', () => {
  it('GET /auth/me returns the user, grants and csrf token; no cookie is 401', async () => {
    const instance = makeApp();
    const session = await loginOk(instance);
    const me = await instance.inject({
      method: 'GET',
      url: `${API}/auth/me`,
      headers: authed(session, false),
    });
    expect(me.statusCode).toBe(200);
    expect(me.json<Body>().data.csrfToken).toBe(session.csrf);
    expect(me.json<Body>().data.user.id).toBe(userId);
    expect(me.json<Body>().data.roles).toEqual(['OWNER']);
    const anon = await instance.inject({ method: 'GET', url: `${API}/auth/me` });
    expect(anon.statusCode).toBe(401);
    expect(anon.json<Body>().error.code).toBe('UNAUTHENTICATED');
    const junk = await instance.inject({
      method: 'GET',
      url: `${API}/auth/me`,
      headers: { cookie: `tradex_sid=${'A'.repeat(43)}` },
    });
    expect(junk.statusCode).toBe(401);
  });

  it('logout revokes the session and clears the cookie', async () => {
    const instance = makeApp();
    const session = await loginOk(instance);
    const out = await instance.inject({
      method: 'POST',
      url: `${API}/auth/logout`,
      headers: authed(session),
    });
    expect(out.statusCode).toBe(200);
    expect(cookieOf(out).header).toContain('Max-Age=0');
    const row = await one<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM session WHERE user_id = $1`,
      [userId],
    );
    expect(row.revoked_at).not.toBeNull();
    const me = await instance.inject({
      method: 'GET',
      url: `${API}/auth/me`,
      headers: authed(session, false),
    });
    expect(me.statusCode).toBe(401);
    const audit = await one<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE action = 'auth.logout'`,
    );
    expect(Number(audit.n)).toBe(1);
  });

  it('enforces the absolute 30 day expiry and the 14 day idle expiry', async () => {
    const instance = makeApp();
    const session = await loginOk(instance);
    const row = await one<{ days_idle: number; days_abs: number }>(
      `SELECT round(extract(epoch from (expires_at - created_at)) / 86400)::int AS days_idle,
              round(extract(epoch from (absolute_expires_at - created_at)) / 86400)::int AS days_abs
         FROM session`,
    );
    expect(row.days_idle).toBe(14);
    expect(row.days_abs).toBe(30);

    await owner.query(
      `UPDATE session SET expires_at = now() - interval '1 minute', last_seen_at = now()`,
    );
    const idle = await instance.inject({
      method: 'GET',
      url: `${API}/auth/me`,
      headers: authed(session, false),
    });
    expect(idle.statusCode).toBe(401);

    // CHECK (expires_at <= absolute_expires_at): set both back in time together.
    await owner.query(
      `UPDATE session SET expires_at = now() - interval '2 minutes',
                          absolute_expires_at = now() - interval '1 minute'`,
    );
    const absolute = await instance.inject({
      method: 'GET',
      url: `${API}/auth/me`,
      headers: authed(session, false),
    });
    expect(absolute.statusCode).toBe(401);
  });

  it('slides the idle expiry on use but never past the absolute expiry', async () => {
    const instance = makeApp();
    const session = await loginOk(instance);
    await owner.query(
      `UPDATE session SET last_seen_at = now() - interval '10 minutes',
                          expires_at = now() + interval '1 day'`,
    );
    const ok = await instance.inject({
      method: 'GET',
      url: `${API}/auth/me`,
      headers: authed(session, false),
    });
    expect(ok.statusCode).toBe(200);
    const slid = await one<{ days: number }>(
      `SELECT round(extract(epoch from (expires_at - now())) / 86400)::int AS days FROM session`,
    );
    expect(slid.days).toBe(14);

    await owner.query(
      `UPDATE session SET last_seen_at = now() - interval '10 minutes',
                          expires_at = now() + interval '1 day',
                          absolute_expires_at = now() + interval '2 days'`,
    );
    await instance.inject({
      method: 'GET',
      url: `${API}/auth/me`,
      headers: authed(session, false),
    });
    const capped = await one<{ capped: boolean }>(
      `SELECT expires_at = absolute_expires_at AS capped FROM session`,
    );
    expect(capped.capped).toBe(true);
  });

  it('rejects a disabled user and a revoked device', async () => {
    const instance = makeApp();
    const session = await loginOk(instance);
    await owner.query(`UPDATE device SET revoked_at = now() WHERE id = $1`, [session.deviceId]);
    const revoked = await instance.inject({
      method: 'GET',
      url: `${API}/auth/me`,
      headers: authed(session, false),
    });
    expect(revoked.statusCode).toBe(401);
    await owner.query(`UPDATE device SET revoked_at = NULL`);
    await owner.query(`UPDATE app_user SET status = 'DISABLED'`);
    const disabled = await instance.inject({
      method: 'GET',
      url: `${API}/auth/me`,
      headers: authed(session, false),
    });
    expect(disabled.statusCode).toBe(401);
  });

  it('registers a new device on its first authenticated request', async () => {
    const instance = makeApp();
    const session = await loginOk(instance);
    const second = uuidv7();
    const res = await instance.inject({
      method: 'GET',
      url: `${API}/auth/me`,
      headers: { cookie: session.cookie, 'x-device-id': second },
    });
    expect(res.statusCode).toBe(200);
    const row = await one<{ user_id: string }>(`SELECT user_id FROM device WHERE id = $1`, [
      second,
    ]);
    expect(row.user_id).toBe(userId);
  });

  it('ignores a malformed X-Device-Id and falls back to the session device', async () => {
    const instance = makeApp();
    const session = await loginOk(instance);
    const res = await instance.inject({
      method: 'GET',
      url: `${API}/auth/me`,
      headers: { cookie: session.cookie, 'x-device-id': 'not-a-uuid' },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('CSRF', () => {
  it('rejects a non-GET with a session but no or a wrong X-CSRF-Token (403)', async () => {
    const instance = makeApp();
    const session = await loginOk(instance);
    const missing = await instance.inject({
      method: 'POST',
      url: `${API}/auth/logout`,
      headers: authed(session, false),
    });
    expect(missing.statusCode).toBe(403);
    expect(missing.json<Body>().error.code).toBe('FORBIDDEN');
    expect(missing.json<Body>().error.details.reason).toBe('CSRF');
    const wrong = await instance.inject({
      method: 'POST',
      url: `${API}/auth/logout`,
      headers: { ...authed(session, false), 'x-csrf-token': 'nope' },
    });
    expect(wrong.statusCode).toBe(403);
    // Neither attempt revoked anything.
    const row = await one<{ revoked_at: Date | null }>(`SELECT revoked_at FROM session`);
    expect(row.revoked_at).toBeNull();
  });

  it("does not accept another session's token", async () => {
    const instance = makeApp();
    const a = await loginOk(instance);
    const b = await loginOk(instance);
    expect(a.csrf).not.toBe(b.csrf);
    const res = await instance.inject({
      method: 'POST',
      url: `${API}/auth/logout`,
      headers: { ...authed(a, false), 'x-csrf-token': b.csrf },
    });
    expect(res.statusCode).toBe(403);
  });

  it('does not check GET, and leaves login (no session) alone', async () => {
    const instance = makeApp();
    const session = await loginOk(instance);
    const me = await instance.inject({
      method: 'GET',
      url: `${API}/auth/me`,
      headers: authed(session, false),
    });
    expect(me.statusCode).toBe(200);
    // Login with a stale cookie but without a token still works (route is exempt).
    const again = await rawLogin(instance, PASSWORD, USERNAME, session.deviceId, {
      cookie: session.cookie,
    });
    expect(again.statusCode).toBe(200);
  });

  it('exempts /connector/ paths (signature auth)', async () => {
    const instance = makeApp();
    instance.post('/connector/v1/_test', () => ({ ok: true }));
    const session = await loginOk(instance);
    const res = await instance.inject({
      method: 'POST',
      url: '/connector/v1/_test',
      headers: authed(session, false),
    });
    expect(res.statusCode).toBe(200);
  });

  it('answers an unauthenticated non-GET with 401 (not 403)', async () => {
    const res = await makeApp().inject({ method: 'POST', url: `${API}/auth/logout` });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /auth/change-password', () => {
  it('changes the password and revokes every other session', async () => {
    const instance = makeApp();
    const a = await loginOk(instance);
    const b = await loginOk(instance);
    const res = await instance.inject({
      method: 'POST',
      url: `${API}/auth/change-password`,
      headers: authed(a),
      payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const meA = await instance.inject({
      method: 'GET',
      url: `${API}/auth/me`,
      headers: authed(a, false),
    });
    const meB = await instance.inject({
      method: 'GET',
      url: `${API}/auth/me`,
      headers: authed(b, false),
    });
    expect(meA.statusCode).toBe(200);
    expect(meB.statusCode).toBe(401);
    expect((await rawLogin(instance, PASSWORD)).statusCode).toBe(401);
    expect((await rawLogin(instance, NEW_PASSWORD)).statusCode).toBe(200);
    const audit = await one<{ after: { other_sessions_revoked: number } }>(
      `SELECT after FROM audit_log WHERE action = 'auth.password_change'`,
    );
    expect(audit.after.other_sessions_revoked).toBe(1);
    expect(JSON.stringify(audit)).not.toContain('argon2');
  });

  it('rejects a wrong current password, a weak new password and an unchanged one', async () => {
    const instance = makeApp();
    const session = await loginOk(instance);
    const call = (payload: object): Promise<LightMyRequestResponse> =>
      instance.inject({
        method: 'POST',
        url: `${API}/auth/change-password`,
        headers: authed(session),
        payload,
      });
    const wrong = await call({ currentPassword: 'not-the-password', newPassword: NEW_PASSWORD });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json<Body>().error.details.reason).toBe('CURRENT_PASSWORD_INCORRECT');
    const weak = await call({ currentPassword: PASSWORD, newPassword: 'short' });
    expect(weak.json<Body>().error.details.reason).toBe('TOO_SHORT');
    const same = await call({ currentPassword: PASSWORD, newPassword: PASSWORD });
    expect(same.json<Body>().error.details.reason).toBe('SAME_AS_CURRENT');
    // Nothing changed.
    expect((await rawLogin(instance, PASSWORD)).statusCode).toBe(200);
  });

  it('rate limits repeated wrong current passwords (429)', async () => {
    const instance = makeApp();
    const session = await loginOk(instance);
    const call = (): Promise<LightMyRequestResponse> =>
      instance.inject({
        method: 'POST',
        url: `${API}/auth/change-password`,
        headers: authed(session),
        payload: { currentPassword: 'not-the-password', newPassword: NEW_PASSWORD },
      });
    for (let i = 0; i < 5; i += 1) expect((await call()).statusCode).toBe(400);
    const limited = await call();
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });

  it('confines a must_change_password user to the auth routes until they change it', async () => {
    const instance = makeApp();
    await owner.query(`UPDATE app_user SET must_change_password = true WHERE id = $1`, [userId]);
    const session = await loginOk(instance);
    expect(session.body.user.mustChangePassword).toBe(true);
    const blocked = await instance.inject({
      method: 'GET',
      url: `${API}/sync/pull`,
      headers: authed(session, false),
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json<Body>().error.details.reason).toBe('PASSWORD_CHANGE_REQUIRED');
    const me = await instance.inject({
      method: 'GET',
      url: `${API}/auth/me`,
      headers: authed(session, false),
    });
    expect(me.statusCode).toBe(200);
    const change = await instance.inject({
      method: 'POST',
      url: `${API}/auth/change-password`,
      headers: authed(session),
      payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(change.statusCode).toBe(200);
    const after = await instance.inject({
      method: 'GET',
      url: `${API}/sync/pull?scope=mine`,
      headers: authed(session, false),
    });
    expect(after.statusCode).not.toBe(403);
  });
});

describe('logging', () => {
  it('never writes passwords, session tokens, CSRF tokens or cookies to the log', async () => {
    const instance = makeApp();
    await rawLogin(instance, 'wrong-password-123');
    const session = await loginOk(instance);
    await instance.inject({
      method: 'POST',
      url: `${API}/auth/change-password`,
      headers: authed(session),
      payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    await instance.inject({
      method: 'POST',
      url: `${API}/auth/logout`,
      headers: authed(session),
    });
    const text = logs.join('\n');
    expect(text.length).toBeGreaterThan(0);
    for (const secret of [
      PASSWORD,
      NEW_PASSWORD,
      'wrong-password-123',
      session.token,
      session.csrf,
      createHash('sha256').update(session.token).digest('hex'),
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text.toLowerCase()).not.toContain('set-cookie');
  });
});
