import { sessionStore } from '../lib/session';
import { getOfflineDb, type TradexOfflineDb } from './db';
import { createSyncEngine, type SyncEngine } from './syncEngine';

export interface OfflineRuntime {
  db: TradexOfflineDb;
  engine: SyncEngine;
}

let runtime: OfflineRuntime | undefined;

/** The app-wide database and sync engine, created on first use. */
export function getOfflineRuntime(): OfflineRuntime {
  if (runtime === undefined) {
    const db = getOfflineDb();
    runtime = {
      db,
      engine: createSyncEngine({ db, getUserId: () => sessionStore.get().userId }),
    };
  }
  return runtime;
}

/** Start background syncing (app start, online, interval). Returns a cleanup function. */
export function startOfflineRuntime(): () => void {
  return getOfflineRuntime().engine.start();
}
