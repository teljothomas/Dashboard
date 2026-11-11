import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MIGRATIONS_DIR,
  resetDatabase,
  sqlState,
  testDbUrls,
  truncateAll,
} from '../../../test/db.js';
import { insertTestIdentity } from '../../../test/identity.js';
import { createDatabase, type Database } from '../../db/index.js';
import { loadMigrations, runMigrations } from '../../db/migrate.js';
import { AppError } from '../../errors.js';
import { defaultGrants, PERMISSIONS, SYSTEM_ROLES } from './catalogue.js';
import { verifyPassword } from './password.js';
import { createOwner, seedIdentity } from './index.js';

const urls = testDbUrls();
const API_DIR = fileURLToPath(new URL('../../../', import.meta.url));
const GOOD_PASSWORD = 'tractor-lantern-meadow-42';
const USER = '01930000-0000-7000-8000-000000001001';
const DEVICE = '01930000-0000-7000-8000-00000000a001';

let db: Database;
let owner: pg.Pool;

beforeAll(async () => {
  await resetDatabase(urls);
  await runMigrations(urls.owner, MIGRATIONS_DIR);
  db = createDatabase(urls.app);
  owner = new pg.Pool({ connectionString: urls.owner, max: 2 });
});

beforeEach(async () => {
  await truncateAll(urls);
});

afterAll(async () => {
  await db.destroy();
  await owner.end();
});

async function count(table: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
  return Number(rows[0]?.n);
}

async function expectAppError(
  promise: Promise<unknown>,
  code: string,
  reason?: string,
): Promise<void> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  if (reason !== undefined) expect((err as AppError).details?.reason).toBe(reason);
}

describe('0004_identity migration', () => {
  it('is applied once and a second run is a no-op', async () => {
    const files = await loadMigrations(MIGRATIONS_DIR);
    const second = await runMigrations(urls.owner, MIGRATIONS_DIR);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toBe(files.length);
    expect(files.map((f) => f.name)).toContain('0004_identity.sql');
  });

  it('creates the identity tables', async () => {
    const { rows } = await owner.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const names = rows.map((r) => r.tablename);
    for (const t of [
      'app_user',
      'role',
      'permission',
      'role_permission',
      'user_role',
      'session',
      'password_reset',
      'device',
      'login_attempt',
    ]) {
      expect(names).toContain(t);
    }
  });

  it('enforces the client_mutation.device_id foreign key', async () => {
    await insertTestIdentity(owner, [USER], [DEVICE]);
    const insert = (device: string): Promise<unknown> =>
      owner.query(
        `INSERT INTO client_mutation (mutation_id, device_id, user_id, entity_type, entity_id, op,
           payload_hash, client_created_at, result, result_body)
         VALUES (gen_random_uuid(), $1, $2, 'thing', gen_random_uuid(), 'CREATE', repeat('a', 64),
           now(), 'APPLIED', '{}')`,
        [device, USER],
      );
    await expect(insert('01930000-0000-7000-8000-00000000ffff')).rejects.toSatisfy(
      (e: unknown) => sqlState(e) === '23503',
    );
    await expect(insert(DEVICE)).resolves.toBeDefined();
  });

  it('stores usernames lowercase only and unique', async () => {
    await insertTestIdentity(owner, [USER], []);
    await expect(
      owner.query(
        `INSERT INTO app_user (id, username, display_name, password_hash)
         VALUES (gen_random_uuid(), 'MixedCase', 'x', '$argon2id$x')`,
      ),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === '23514');
    await expect(
      owner.query(
        `INSERT INTO app_user (id, username, display_name, password_hash)
         VALUES (gen_random_uuid(), 'test-user-1', 'x', '$argon2id$x')`,
      ),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === '23505');
  });

  it('rejects a non-argon2id password hash', async () => {
    await expect(
      owner.query(
        `INSERT INTO app_user (id, username, display_name, password_hash)
         VALUES (gen_random_uuid(), 'plain-hash', 'x', 'plaintext')`,
      ),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === '23514');
  });

  it('protects system roles from deletion and code changes', async () => {
    await db.transaction().execute((tx) => seedIdentity(tx));
    await expect(owner.query(`DELETE FROM role WHERE code = 'OWNER'`)).rejects.toSatisfy(
      (e: unknown) => sqlState(e) === 'TX403',
    );
    await expect(
      owner.query(`UPDATE role SET code = 'BOSS' WHERE code = 'OWNER'`),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === 'TX403');
    await expect(
      owner.query(`UPDATE role SET name = 'Chief' WHERE code = 'OWNER'`),
    ).resolves.toBeDefined();
  });

  it('keeps one user_role per (user, role, division) including the null division', async () => {
    await db.transaction().execute((tx) => seedIdentity(tx));
    await insertTestIdentity(owner, [USER], []);
    const add = (): Promise<unknown> =>
      owner.query(
        `INSERT INTO user_role (id, user_id, role_id) VALUES (gen_random_uuid(), $1, $2)`,
        [USER, SYSTEM_ROLES[5]?.id],
      );
    await add();
    await expect(add()).rejects.toSatisfy((e: unknown) => sqlState(e) === '23505');
  });
});

describe('seedIdentity', () => {
  it('seeds the catalogue, six roles and the matrix, then is a no-op on repeat', async () => {
    const expectedGrants = SYSTEM_ROLES.reduce((n, r) => n + defaultGrants(r.code).length, 0);
    const first = await db.transaction().execute((tx) => seedIdentity(tx));
    expect(first).toEqual({
      permissions: PERMISSIONS.length,
      roles: 6,
      rolePermissions: expectedGrants,
    });
    expect(await count('permission')).toBe(PERMISSIONS.length);
    expect(await count('role')).toBe(6);
    expect(await count('role_permission')).toBe(expectedGrants);

    const again = await db.transaction().execute((tx) => seedIdentity(tx));
    expect(again).toEqual({ permissions: 0, roles: 0, rolePermissions: 0 });
    expect(await count('role_permission')).toBe(expectedGrants);
  });

  it('stores the matrix exactly (database equals catalogue)', async () => {
    await db.transaction().execute((tx) => seedIdentity(tx));
    const { rows } = await owner.query<{ code: string; permission_code: string; scope: string }>(
      `SELECT r.code, rp.permission_code, rp.scope
         FROM role_permission rp JOIN role r ON r.id = rp.role_id`,
    );
    const actual = rows.map((r) => `${r.code}|${r.permission_code}|${r.scope}`).sort();
    const expected = SYSTEM_ROLES.flatMap((r) =>
      defaultGrants(r.code).map((g) => `${r.code}|${g.permission}|${g.scope}`),
    ).sort();
    expect(actual).toEqual(expected);
    const roles = await owner.query<{ is_system: boolean }>('SELECT is_system FROM role');
    expect(roles.rows.every((r) => r.is_system)).toBe(true);
  });

  it('does not change the scope of a grant an administrator edited', async () => {
    await db.transaction().execute((tx) => seedIdentity(tx));
    await owner.query(
      `UPDATE role_permission SET scope = 'OWN' WHERE permission_code = 'expense.view'
         AND role_id = $1`,
      [SYSTEM_ROLES[3]?.id],
    );
    await db.transaction().execute((tx) => seedIdentity(tx));
    const { rows } = await owner.query<{ scope: string }>(
      `SELECT scope FROM role_permission WHERE permission_code = 'expense.view' AND role_id = $1`,
      [SYSTEM_ROLES[3]?.id],
    );
    expect(rows[0]?.scope).toBe('OWN');
  });
});

describe('createOwner', () => {
  it('seeds a fresh database, creates the OWNER with a verifiable hash and audits it', async () => {
    const created = await createOwner(db, {
      username: '  Boss.One ',
      displayName: 'The Boss',
      password: GOOD_PASSWORD,
    });
    expect(created.username).toBe('boss.one');

    const { rows } = await owner.query<{
      password_hash: string;
      status: string;
      must_change_password: boolean;
      role_code: string;
      division_id: string | null;
    }>(
      `SELECT u.password_hash, u.status, u.must_change_password, r.code AS role_code, ur.division_id
         FROM app_user u JOIN user_role ur ON ur.user_id = u.id JOIN role r ON r.id = ur.role_id
        WHERE u.id = $1`,
      [created.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'ACTIVE',
      must_change_password: false,
      role_code: 'OWNER',
      division_id: null,
    });
    expect(rows[0]?.password_hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(rows[0]?.password_hash ?? '', GOOD_PASSWORD)).toBe(true);
    expect(await count('role')).toBe(6);

    const audit = await owner.query<{ action: string; entity_id: string; after: unknown }>(
      `SELECT action, entity_id, after FROM audit_log`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ action: 'user.create', entity_id: created.id });
    const text = JSON.stringify(audit.rows[0]?.after);
    expect(text).not.toContain(GOOD_PASSWORD);
    expect(text).not.toContain('argon2');
  });

  it('refuses a second OWNER unless additional is set', async () => {
    await createOwner(db, { username: 'first-owner', displayName: 'One', password: GOOD_PASSWORD });
    await expectAppError(
      createOwner(db, { username: 'second-owner', displayName: 'Two', password: GOOD_PASSWORD }),
      'INVALID_TRANSITION',
      'OWNER_EXISTS',
    );
    expect(await count('app_user')).toBe(1);
    await createOwner(db, {
      username: 'second-owner',
      displayName: 'Two',
      password: GOOD_PASSWORD,
      additional: true,
    });
    expect(await count('app_user')).toBe(2);
  });

  it('rejects a duplicate username, a bad username and a weak password without writing', async () => {
    await createOwner(db, { username: 'dup-user', displayName: 'A', password: GOOD_PASSWORD });
    await expectAppError(
      createOwner(db, {
        username: 'DUP-USER',
        displayName: 'B',
        password: GOOD_PASSWORD,
        additional: true,
      }),
      'VALIDATION_FAILED',
      'USERNAME_TAKEN',
    );
    await expectAppError(
      createOwner(db, {
        username: 'a b',
        displayName: 'B',
        password: GOOD_PASSWORD,
        additional: true,
      }),
      'VALIDATION_FAILED',
    );
    await expectAppError(
      createOwner(db, {
        username: 'weak-pass',
        displayName: 'B',
        password: 'short',
        additional: true,
      }),
      'VALIDATION_FAILED',
      'TOO_SHORT',
    );
    await expectAppError(
      createOwner(db, {
        username: 'weak-pass',
        displayName: 'B',
        password: 'password123',
        additional: true,
      }),
      'VALIDATION_FAILED',
      'COMMON',
    );
    expect(await count('app_user')).toBe(1);
  });

  it('allows only one of two concurrent bootstraps', async () => {
    const attempt = (name: string): Promise<unknown> =>
      createOwner(db, { username: name, displayName: name, password: GOOD_PASSWORD }).then(
        () => 'ok',
        (e: unknown) => (e instanceof AppError ? e.code : 'other'),
      );
    const results = await Promise.all([attempt('race-one'), attempt('race-two')]);
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'INVALID_TRANSITION')).toHaveLength(1);
    expect(await count('app_user')).toBe(1);
  });
});

describe('user:create-owner CLI', () => {
  function run(
    args: string[],
    input: string,
    env: NodeJS.ProcessEnv = {},
  ): { status: number | null; out: string } {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/create-owner.ts', ...args], {
      cwd: API_DIR,
      input,
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: urls.app, ...env },
      timeout: 60_000,
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  }

  it('creates an OWNER from stdin in test mode, never echoing the password', async () => {
    const r = run([], `cli.owner\n${GOOD_PASSWORD}\n${GOOD_PASSWORD}\n`);
    expect(r.status).toBe(0);
    expect(r.out).toContain('Created OWNER user "cli.owner"');
    expect(r.out).not.toContain(GOOD_PASSWORD);
    const { rows } = await owner.query<{ password_hash: string; code: string }>(
      `SELECT u.password_hash, r.code FROM app_user u
         JOIN user_role ur ON ur.user_id = u.id JOIN role r ON r.id = ur.role_id
        WHERE u.username = 'cli.owner'`,
    );
    expect(rows[0]?.code).toBe('OWNER');
    expect(await verifyPassword(rows[0]?.password_hash ?? '', GOOD_PASSWORD)).toBe(true);
  });

  it('refuses a second OWNER, allows --additional, and rejects mismatched passwords', async () => {
    expect(run(['--username', 'owner-a'], `${GOOD_PASSWORD}\n${GOOD_PASSWORD}\n`).status).toBe(0);

    const refused = run(['--username', 'owner-b'], `${GOOD_PASSWORD}\n${GOOD_PASSWORD}\n`);
    expect(refused.status).toBe(1);
    expect(refused.out).toContain('An OWNER already exists');
    expect(await count('app_user')).toBe(1);

    const mismatch = run(
      ['--username', 'owner-b', '--additional'],
      `${GOOD_PASSWORD}\nother-password-1\n`,
    );
    expect(mismatch.status).toBe(1);
    expect(mismatch.out).toContain('do not match');

    const added = run(
      ['--username', 'owner-b', '--additional'],
      `${GOOD_PASSWORD}\n${GOOD_PASSWORD}\n`,
    );
    expect(added.status).toBe(0);
    expect(await count('app_user')).toBe(2);
  });

  it('reads no password outside test mode without a terminal', () => {
    const r = run(['--username', 'no-tty'], `${GOOD_PASSWORD}\n${GOOD_PASSWORD}\n`, {
      NODE_ENV: 'production',
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain('interactive terminal is required');
    expect(r.out).not.toContain(GOOD_PASSWORD);
  });
});
