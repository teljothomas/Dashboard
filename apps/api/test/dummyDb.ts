import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type Dialect,
  type Driver,
} from 'kysely';
import type { Database } from '../src/db/index.js';

/** Kysely instance that never touches a network: every query succeeds with no rows. */
export function createDummyDatabase(): Database {
  return new Kysely({ dialect: dummyDialect(new DummyDriver()) });
}

/** Kysely instance whose connections always fail, to exercise unhealthy paths. */
export function createFailingDatabase(): Database {
  const failing = new DummyDriver();
  failing.acquireConnection = () => Promise.reject(new Error('connection refused (test)'));
  return new Kysely({ dialect: dummyDialect(failing) });
}

function dummyDialect(driver: Driver): Dialect {
  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => driver,
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
}
