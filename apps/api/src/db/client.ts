import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { DB } from './generated.js';

export type Database = Kysely<DB>;

/** PostgreSQL type OIDs whose default JS parsing is unsafe for this system. */
const OID_DATE = 1082;

function getTypeParser(oid: number, format?: 'text' | 'binary'): (value: string) => unknown {
  if (oid === OID_DATE) {
    return (value: string) => value;
  }
  return pg.types.getTypeParser(oid, format) as (value: string) => unknown;
}

/**
 * Create the runtime Kysely instance (tradex_app role, DML only).
 * `date` columns stay as `YYYY-MM-DD` strings: the default parser builds a local-time Date and
 * shifts business dates (ADR-015). numeric and int8 stay strings (money is never a JS float).
 */
export function createDatabase(connectionString: string): Database {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    types: { getTypeParser: getTypeParser as typeof pg.types.getTypeParser },
  });
  // An idle client dropped by the server must not crash the process; the next query reconnects.
  pool.on('error', () => undefined);
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

/** Liveness of the database connection. Never returns server details. */
export async function isDatabaseHealthy(db: Database): Promise<boolean> {
  try {
    await sql`SELECT 1`.execute(db);
    return true;
  } catch {
    return false;
  }
}
