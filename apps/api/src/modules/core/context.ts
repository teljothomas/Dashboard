import { AsyncLocalStorage } from 'node:async_hooks';
import type { Kysely } from 'kysely';
import type { DB } from '../../db/index.js';

/**
 * A Kysely handle. Core services take a transaction (a `Transaction` is a `Kysely`) so that the
 * business write and its audit row commit together. Passing the root instance works too but
 * gives no atomicity.
 */
export type Tx = Kysely<DB>;

/** Who is acting, for audit rows and `created_by`/`updated_by`. Populated by the auth seam (Phase 04). */
export interface ActorContext {
  userId?: string | undefined;
  agentId?: string | undefined;
  deviceId?: string | undefined;
  requestId?: string | undefined;
  ip?: string | undefined;
}

const storage = new AsyncLocalStorage<ActorContext>();

/** Run `fn` with `ctx` as the ambient actor context (one request, one job). */
export function runWithContext<T>(ctx: ActorContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Ambient actor context, or undefined for system work (jobs, migrations). */
export function getContext(): ActorContext | undefined {
  return storage.getStore();
}
