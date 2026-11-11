import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

/** Constant key for the advisory lock that serialises concurrent migration runners. */
const MIGRATION_LOCK_KEY = 7_274_001;

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export interface MigrationFile {
  version: number;
  name: string;
  /** sha256 hex of the file content with line endings normalised to LF. */
  checksum: string;
  sql: string;
}

export interface MigrationResult {
  /** File names applied by this run, in order. */
  applied: string[];
  /** Number of already-applied migrations whose checksum matched. */
  alreadyApplied: number;
}

export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

/** Read and validate `NNNN_name.sql` files: versions start at 1 and are contiguous. */
export async function loadMigrations(dir: string): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const files: MigrationFile[] = [];
  for (const entry of entries) {
    const match = FILE_PATTERN.exec(entry);
    if (!match) {
      throw new MigrationError(`Invalid migration file name: ${entry} (expected NNNN_name.sql)`);
    }
    const sql = await readFile(join(dir, entry), 'utf8');
    files.push({
      version: Number(match[1]),
      name: entry,
      checksum: checksumOf(sql),
      sql,
    });
  }
  files.forEach((file, index) => {
    if (file.version !== index + 1) {
      throw new MigrationError(
        `Migration versions must be contiguous from 0001: expected ${String(index + 1).padStart(4, '0')}, found ${file.name}`,
      );
    }
  });
  return files;
}

interface AppliedRow {
  version: number;
  name: string;
  checksum: string;
}

/**
 * Apply pending migrations in order, each in its own transaction, recorded in `schema_migration`.
 * A checksum mismatch on an applied migration, or an applied migration with no file, aborts the run
 * before anything new is applied. Must connect as the DDL role (DATABASE_URL_MIGRATE).
 */
export async function runMigrations(
  connectionString: string,
  dir: string,
  log: (message: string) => void = () => undefined,
): Promise<MigrationResult> {
  const files = await loadMigrations(dir);
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migration (
           version     integer     PRIMARY KEY,
           name        text        NOT NULL UNIQUE,
           checksum    char(64)    NOT NULL,
           applied_at  timestamptz NOT NULL DEFAULT now()
         )`,
      );
      // Migration bookkeeping is owner-only: the runtime role must not rewrite checksums.
      await client.query(
        `DO $$
         BEGIN
           IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tradex_app') THEN
             REVOKE ALL ON schema_migration FROM tradex_app;
           END IF;
         END
         $$`,
      );

      const { rows } = await client.query<AppliedRow>(
        'SELECT version, name, checksum FROM schema_migration ORDER BY version',
      );
      const byVersion = new Map(rows.map((r) => [r.version, r]));
      for (const row of rows) {
        const file = files.find((f) => f.version === row.version);
        if (!file) {
          throw new MigrationError(
            `Applied migration ${row.name} has no file on disk; refusing to continue`,
          );
        }
        if (file.checksum !== row.checksum.trim() || file.name !== row.name) {
          throw new MigrationError(
            `Checksum mismatch for applied migration ${row.name}; applied migrations must never be edited`,
          );
        }
      }

      const applied: string[] = [];
      for (const file of files) {
        if (byVersion.has(file.version)) {
          continue;
        }
        await client.query('BEGIN');
        try {
          await client.query(file.sql);
          await client.query(
            'INSERT INTO schema_migration (version, name, checksum) VALUES ($1, $2, $3)',
            [file.version, file.name, file.checksum],
          );
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          const reason = err instanceof Error ? err.message : String(err);
          throw new MigrationError(`Migration ${file.name} failed and was rolled back: ${reason}`);
        }
        applied.push(file.name);
        log(`applied ${file.name}`);
      }
      return { applied, alreadyApplied: rows.length };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
}
