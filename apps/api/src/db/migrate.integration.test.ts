import { copyFile, mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, resetDatabase, testDbUrls } from '../../test/db.js';
import { loadMigrations, MigrationError, runMigrations } from './migrate.js';

const urls = testDbUrls();
const scratch: string[] = [];

async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tradex-mig-'));
  scratch.push(dir);
  return dir;
}

async function ownerQuery<T extends pg.QueryResultRow>(text: string): Promise<pg.QueryResult<T>> {
  const client = new pg.Client({ connectionString: urls.owner });
  await client.connect();
  try {
    return await client.query<T>(text);
  } finally {
    await client.end();
  }
}

beforeEach(async () => {
  await resetDatabase(urls);
});

afterAll(async () => {
  await Promise.all(scratch.map((d) => rm(d, { recursive: true, force: true })));
});

describe('migration runner', () => {
  it('applies on an empty database, then a second run is a no-op', async () => {
    const first = await runMigrations(urls.owner, MIGRATIONS_DIR);
    expect(first.applied).toEqual(['0001_core.sql']);
    expect(first.alreadyApplied).toBe(0);

    const second = await runMigrations(urls.owner, MIGRATIONS_DIR);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toBe(1);

    const { rows } = await ownerQuery<{ version: number; name: string; checksum: string }>(
      'SELECT version, name, checksum FROM schema_migration',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('0001_core.sql');
    expect(rows[0]?.checksum.trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('seeds divisions and settings', async () => {
    await runMigrations(urls.owner, MIGRATIONS_DIR);
    const divisions = await ownerQuery<{ code: string }>('SELECT code FROM division ORDER BY code');
    expect(divisions.rows.map((r) => r.code)).toEqual(['LOGISTICS', 'MEAT']);
    const settings = await ownerQuery<{ key: string; value: unknown }>(
      'SELECT key, value FROM app_setting ORDER BY key',
    );
    expect(settings.rows).toEqual([
      { key: 'fy_start_month', value: 4 },
      { key: 'tally_stale_hours', value: 24 },
    ]);
  });

  it('aborts on a checksum mismatch of an applied migration', async () => {
    const dir = await scratchDir();
    await copyFile(join(MIGRATIONS_DIR, '0001_core.sql'), join(dir, '0001_core.sql'));
    await runMigrations(urls.owner, dir);

    await appendFile(join(dir, '0001_core.sql'), '\n-- edited after apply\n');
    await expect(runMigrations(urls.owner, dir)).rejects.toThrow(/Checksum mismatch/);
  });

  it('ignores line-ending differences in the checksum', async () => {
    const dir = await scratchDir();
    await copyFile(join(MIGRATIONS_DIR, '0001_core.sql'), join(dir, '0001_core.sql'));
    await runMigrations(urls.owner, dir);

    const { readFile } = await import('node:fs/promises');
    const text = await readFile(join(dir, '0001_core.sql'), 'utf8');
    await writeFile(join(dir, '0001_core.sql'), text.replace(/\n/g, '\r\n'));
    const again = await runMigrations(urls.owner, dir);
    expect(again.applied).toEqual([]);
  });

  it('aborts when an applied migration has no file', async () => {
    const dir = await scratchDir();
    await copyFile(join(MIGRATIONS_DIR, '0001_core.sql'), join(dir, '0001_core.sql'));
    await runMigrations(urls.owner, dir);

    const empty = await scratchDir();
    await expect(runMigrations(urls.owner, empty)).rejects.toThrow(/no file on disk/);
  });

  it('rolls back a failing migration completely', async () => {
    const dir = await scratchDir();
    await copyFile(join(MIGRATIONS_DIR, '0001_core.sql'), join(dir, '0001_core.sql'));
    await writeFile(
      join(dir, '0002_bad.sql'),
      'CREATE TABLE partial_table (id integer);\nSELECT 1 / 0;\n',
    );
    await expect(runMigrations(urls.owner, dir)).rejects.toThrow(/0002_bad.sql failed/);

    const table = await ownerQuery<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_tables WHERE tablename = 'partial_table'`,
    );
    expect(table.rows[0]?.n).toBe('0');
    const recorded = await ownerQuery<{ n: string }>(
      'SELECT count(*)::text AS n FROM schema_migration',
    );
    expect(recorded.rows[0]?.n).toBe('1');
  });

  it('runs concurrent runners safely (advisory lock)', async () => {
    const results = await Promise.all([
      runMigrations(urls.owner, MIGRATIONS_DIR),
      runMigrations(urls.owner, MIGRATIONS_DIR),
    ]);
    const appliedTotal = results.reduce((n, r) => n + r.applied.length, 0);
    expect(appliedTotal).toBe(1);
  });

  it('keeps schema_migration unreadable for the app role', async () => {
    await runMigrations(urls.owner, MIGRATIONS_DIR);
    const client = new pg.Client({ connectionString: urls.app });
    await client.connect();
    try {
      await expect(client.query('SELECT * FROM schema_migration')).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      await client.end();
    }
  });
});

describe('loadMigrations validation', () => {
  it('rejects bad file names and gaps in versions', async () => {
    const badName = await scratchDir();
    await writeFile(join(badName, 'core.sql'), 'SELECT 1;');
    await expect(loadMigrations(badName)).rejects.toThrow(MigrationError);

    const gap = await scratchDir();
    await writeFile(join(gap, '0001_a.sql'), 'SELECT 1;');
    await writeFile(join(gap, '0003_c.sql'), 'SELECT 1;');
    await expect(loadMigrations(gap)).rejects.toThrow(/contiguous/);
  });
});
