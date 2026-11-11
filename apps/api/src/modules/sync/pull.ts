import type { PullChange, PullQuery, PullResponse } from '@tradex/contracts';
import type { Database } from '../../db/index.js';
import { lockSyncPull } from './locks.js';
import { listEntities } from './registry.js';
import type { SyncCaller } from './types.js';

/**
 * GET /sync/pull (SYNC_DESIGN 2.2). Changes of every entity type registered for the scope, merged
 * in `sync_seq` order after the cursor. Each handler is asked for `limit + 1` rows, so the merged
 * page is exact and `hasMore` is known without a count.
 *
 * The exclusive sync lock (see `lockSyncPull`) makes the page complete: no sync write is in flight
 * while the handlers read, so no row with a lower `sync_seq` can commit after the cursor moves past it.
 */
export async function pull(
  db: Database,
  caller: SyncCaller,
  query: PullQuery,
): Promise<PullResponse> {
  const { scope, cursor, limit } = query;
  const collected: PullChange[] = [];

  await db.transaction().execute(async (tx) => {
    await lockSyncPull(tx);
    for (const [entityType, handler] of listEntities()) {
      if (!handler.scopes.includes(scope)) {
        continue;
      }
      const rows = await handler.scopeFilter(tx, caller, scope, cursor, limit + 1);
      for (const row of rows) {
        collected.push({
          entityType,
          entityId: row.entityId,
          syncSeq: Number(row.syncSeq),
          deleted: row.deleted,
          data: handler.serialize(row.row, caller),
        });
      }
    }
  });

  collected.sort((a, b) => a.syncSeq - b.syncSeq || (a.entityType < b.entityType ? -1 : 1));
  const changes = collected.slice(0, limit);
  const last = changes[changes.length - 1];
  return {
    changes,
    nextCursor: last ? last.syncSeq : cursor,
    hasMore: collected.length > limit,
  };
}
