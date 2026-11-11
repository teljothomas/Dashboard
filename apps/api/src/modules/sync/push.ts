import { uuidv7 } from '@tradex/domain';
import type { PushRequest, PushResultItem } from '@tradex/contracts';
import type { Database } from '../../db/index.js';
import { audit } from '../core/index.js';
import type { Tx } from '../core/context.js';
import { lockEntity, lockMutation, lockSyncWrite, toMutationError } from './locks.js';
import { mutationHash } from './policy.js';
import { getEntity } from './registry.js';
import type { ConflictDetails, HandlerOutcome, SyncCaller, SyncMutation } from './types.js';

type StoredResult = 'APPLIED' | 'CONFLICT' | 'REJECTED';

function entityKey(m: SyncMutation): string {
  return `${m.entityType}:${m.entityId}`;
}

/**
 * Returns the stored result of an earlier processing of this mutation id (idempotent replay), a
 * REJECTED `IDEMPOTENCY_MISMATCH` when the id was used by another user or with other content, or
 * undefined when the mutation is new. Caller holds the mutation lock.
 */
async function findReplay(
  tx: Tx,
  caller: SyncCaller,
  m: SyncMutation,
  hash: string,
): Promise<PushResultItem | undefined> {
  const stored = await tx
    .selectFrom('client_mutation')
    .select(['user_id', 'payload_hash', 'result_body'])
    .where('mutation_id', '=', m.mutationId)
    .executeTakeFirst();
  if (!stored) {
    return undefined;
  }
  if (stored.user_id !== caller.userId || stored.payload_hash !== hash) {
    return {
      mutationId: m.mutationId,
      result: 'REJECTED',
      error: {
        code: 'IDEMPOTENCY_MISMATCH',
        message: 'This mutation id was already used with different content',
      },
    };
  }
  return stored.result_body as unknown as PushResultItem;
}

/** Writes the final result (and the conflict row) and the sync-level audit entry. */
async function persist(
  tx: Tx,
  caller: SyncCaller,
  m: SyncMutation,
  hash: string,
  item: PushResultItem,
  auditAction: string,
): Promise<void> {
  await tx
    .insertInto('client_mutation')
    .values({
      mutation_id: m.mutationId,
      device_id: caller.deviceId as string,
      user_id: caller.userId,
      entity_type: m.entityType,
      entity_id: m.entityId,
      op: m.op,
      base_version: m.baseVersion,
      payload_hash: hash,
      client_created_at: m.clientCreatedAt,
      result: item.result as StoredResult,
      result_body: JSON.stringify(item),
    })
    .execute();
  await audit.record(tx, {
    action: auditAction,
    entityType: m.entityType,
    entityId: m.entityId,
    after: {
      mutationId: m.mutationId,
      op: m.op,
      result: item.result,
      ...(item.error ? { error: item.error.code } : {}),
      ...(item.conflictId ? { conflictId: item.conflictId } : {}),
    },
    ctx: caller.actor,
  });
}

async function insertConflict(
  tx: Tx,
  caller: SyncCaller,
  m: SyncMutation,
  id: string,
  conflict: ConflictDetails,
): Promise<void> {
  await tx
    .insertInto('sync_conflict')
    .values({
      id,
      mutation_id: m.mutationId,
      entity_type: m.entityType,
      entity_id: m.entityId,
      op: m.op,
      device_id: caller.deviceId as string,
      user_id: caller.userId,
      base_version: conflict.baseVersion,
      server_version: conflict.serverVersion,
      reason: conflict.reason,
      client_payload: JSON.stringify(m.payload),
      server_snapshot:
        conflict.serverSnapshot === null ? null : JSON.stringify(conflict.serverSnapshot),
    })
    .execute();
}

async function runHandler(tx: Tx, caller: SyncCaller, m: SyncMutation): Promise<HandlerOutcome> {
  const handler = getEntity(m.entityType);
  if (!handler) {
    return {
      result: 'REJECTED',
      error: { code: 'VALIDATION_FAILED', message: `Unknown entity type ${m.entityType}` },
    };
  }
  let outcome: Promise<HandlerOutcome> | undefined;
  switch (m.op) {
    case 'CREATE':
      outcome = handler.create?.(tx, caller, m);
      break;
    case 'UPDATE':
      outcome = handler.update?.(tx, caller, m);
      break;
    case 'SUBMIT':
      outcome = handler.submit?.(tx, caller, m);
      break;
    case 'CANCEL':
      outcome = handler.cancel?.(tx, caller, m);
      break;
  }
  if (!outcome) {
    return {
      result: 'REJECTED',
      error: { code: 'VALIDATION_FAILED', message: `${m.entityType} does not support ${m.op}` },
    };
  }
  return outcome;
}

/** One mutation in its own transaction: replay, apply, store result and audit atomically. */
async function attempt(
  tx: Tx,
  caller: SyncCaller,
  m: SyncMutation,
  hash: string,
): Promise<PushResultItem> {
  await lockMutation(tx, m.mutationId);
  const replay = await findReplay(tx, caller, m, hash);
  if (replay) {
    return replay;
  }
  await lockSyncWrite(tx);
  await lockEntity(tx, m.entityType, m.entityId);

  const outcome = await runHandler(tx, caller, m);
  switch (outcome.result) {
    case 'APPLIED': {
      const item: PushResultItem = {
        mutationId: m.mutationId,
        result: 'APPLIED',
        entity: outcome.entity,
      };
      await persist(tx, caller, m, hash, item, outcome.merged ? 'sync.merged' : 'sync.applied');
      return item;
    }
    case 'CONFLICT': {
      // The conflict row references client_mutation, so the mutation row goes first.
      const conflictId = uuidv7();
      const item: PushResultItem = { mutationId: m.mutationId, result: 'CONFLICT', conflictId };
      await persist(tx, caller, m, hash, item, 'sync.conflict');
      await insertConflict(tx, caller, m, conflictId, outcome.conflict);
      return item;
    }
    case 'REJECTED': {
      const item: PushResultItem = {
        mutationId: m.mutationId,
        result: 'REJECTED',
        error: outcome.error,
      };
      await persist(tx, caller, m, hash, item, 'sync.rejected');
      return item;
    }
    case 'DUPLICATE_SUSPECTED':
      // Soft duplicate: not final, not stored. The client resends with `confirmDuplicate`.
      return {
        mutationId: m.mutationId,
        result: 'DUPLICATE_SUSPECTED',
        error: outcome.error,
      };
  }
}

/** Records a rejection raised by throwing, in a fresh transaction (the failed one rolled back). */
async function recordRejection(
  tx: Tx,
  caller: SyncCaller,
  m: SyncMutation,
  hash: string,
  error: { code: string; message: string },
): Promise<PushResultItem> {
  await lockMutation(tx, m.mutationId);
  const replay = await findReplay(tx, caller, m, hash);
  if (replay) {
    return replay;
  }
  const item: PushResultItem = { mutationId: m.mutationId, result: 'REJECTED', error };
  await persist(tx, caller, m, hash, item, 'sync.rejected');
  return item;
}

async function processOne(
  db: Database,
  caller: SyncCaller,
  m: SyncMutation,
): Promise<PushResultItem> {
  const hash = mutationHash(m);
  try {
    return await db.transaction().execute((tx) => attempt(tx, caller, m, hash));
  } catch (err) {
    const error = toMutationError(err);
    if (!error) {
      throw err;
    }
    return db.transaction().execute((tx) => recordRejection(tx, caller, m, hash, error));
  }
}

/**
 * POST /sync/push (SYNC_DESIGN 2.1). Mutations run in array (creation) order, each in its own
 * transaction. After a mutation for entity X ends CONFLICT, REJECTED or DUPLICATE_SUSPECTED, later
 * mutations for X in the same batch return BLOCKED_BY_PREVIOUS (not applied, not stored); unrelated
 * entities continue. An unexpected error fails the whole request with 500; mutations committed
 * before it are replayed idempotently when the client retries.
 */
export async function processPush(
  db: Database,
  caller: SyncCaller,
  request: PushRequest,
): Promise<PushResultItem[]> {
  const blocked = new Set<string>();
  const results: PushResultItem[] = [];
  for (const m of request.mutations) {
    if (blocked.has(entityKey(m))) {
      results.push({ mutationId: m.mutationId, result: 'BLOCKED_BY_PREVIOUS' });
      continue;
    }
    const item = await processOne(db, caller, m);
    if (item.result !== 'APPLIED') {
      blocked.add(entityKey(m));
    }
    results.push(item);
  }
  return results;
}
