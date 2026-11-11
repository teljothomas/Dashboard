import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

export interface TestDbUrls {
  /** tradex_app (DML only) on tradex_test. */
  app: string;
  /** tradex_owner (DDL) on tradex_test. */
  owner: string;
}

/** Read test DB URLs from the environment and refuse anything but a database named `*_test`. */
export function testDbUrls(): TestDbUrls {
  const app = process.env.DATABASE_URL_TEST;
  const owner = process.env.DATABASE_URL_TEST_MIGRATE;
  if (!app || !owner) {
    throw new Error(
      'DATABASE_URL_TEST and DATABASE_URL_TEST_MIGRATE must be set (see apps/api/.env.example)',
    );
  }
  for (const url of [app, owner]) {
    const dbName = new URL(url).pathname.replace(/^\//, '');
    if (!dbName.endsWith('_test')) {
      throw new Error('Integration tests only run against a database whose name ends with _test');
    }
  }
  return { app, owner };
}

export function appRoleName(urls: TestDbUrls): string {
  return decodeURIComponent(new URL(urls.app).username);
}

/**
 * Drop and recreate the public schema as the owner role, restoring the grants that
 * deploy/db-init/01-roles.sql sets up. Gives migration tests a truly empty database.
 */
export async function resetDatabase(urls: TestDbUrls): Promise<void> {
  const app = appRoleName(urls);
  const client = new pg.Client({ connectionString: urls.owner });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await client.query(`GRANT USAGE ON SCHEMA public TO ${quoteIdent(app)}`);
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${quoteIdent(app)}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${quoteIdent(app)}`,
    );
  } finally {
    await client.end();
  }
}

/** Tables holding migration-seeded reference rows or bookkeeping: never truncated between tests. */
const KEEP_TABLES = new Set(['schema_migration', 'division', 'app_setting']);

/** Truncate every data table (as owner) and restart identities. */
export async function truncateAll(urls: TestDbUrls): Promise<void> {
  const client = new pg.Client({ connectionString: urls.owner });
  await client.connect();
  try {
    const { rows } = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const tables = rows.map((r) => r.tablename).filter((t) => !KEEP_TABLES.has(t));
    if (tables.length > 0) {
      await client.query(`TRUNCATE ${tables.map(quoteIdent).join(', ')} RESTART IDENTITY CASCADE`);
    }
  } finally {
    await client.end();
  }
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** SQLSTATE of a pg error, or undefined. */
export function sqlState(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : undefined;
}
