import { fileURLToPath } from 'node:url';
import { MigrationError, runMigrations } from './migrate.js';

/** Resolves to apps/api/migrations from both src/db (tsx) and dist/db (compiled). */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL_MIGRATE;
  if (!url) {
    throw new MigrationError(
      'DATABASE_URL_MIGRATE is not set (owner-role connection string; see apps/api/.env.example)',
    );
  }
  const result = await runMigrations(url, MIGRATIONS_DIR, (m) => console.log(m));
  console.log(
    result.applied.length === 0
      ? `no pending migrations (${String(result.alreadyApplied)} already applied)`
      : `applied ${String(result.applied.length)} migration(s)`,
  );
}

main().catch((err: unknown) => {
  // Never print the connection string: report only the message of our own errors.
  if (err instanceof MigrationError) {
    console.error(err.message);
  } else {
    console.error('Migration failed:', err instanceof Error ? err.message : 'unknown error');
  }
  process.exit(1);
});
