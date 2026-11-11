import type {
  ConflictListQuery,
  ResolveConflictRequest,
  ResolveConflictResponse,
  SyncConflictDto,
} from '@tradex/contracts';
import type { Selectable } from 'kysely';
import type { Database, DB } from '../../db/index.js';
import { AppError } from '../../errors.js';
import { audit } from '../core/index.js';
import type { Tx } from '../core/context.js';
import { isRecordLockedError, lockEntity, lockSyncWrite } from './locks.js';
import { getEntity, listEntities } from './registry.js';
import type { EntitySummary, SyncCaller } from './types.js';

type ConflictRow = Selectable<DB['sync_conflict']>;

/**
 * "Owner of record or approver" (INTERFACES section 2, sync rows). The pushing user always owns
 * their own conflicts. An approver is scoped per entity type: each handler declares the one
 * permission that governs its type (`approverPermission`), so an expense approver cannot see or
 * resolve advance, attendance or stock conflicts. Types without a declared permission are
 * owner-only. Division/OWN scoping is added with the identity tables (Phase 04).
 */
function canApprove(caller: SyncCaller, entityType: string): boolean {
  const permission = getEntity(entityType)?.approverPermission;
  return permission !== undefined && caller.permissions.includes(permission);
}

/** Entity types the caller may approve conflicts for. */
function approvableTypes(caller: SyncCaller): string[] {
  return listEntities()
    .filter(([, handler]) => handler.approverPermission !== undefined)
    .filter(([entityType]) => canApprove(caller, entityType))
    .map(([entityType]) => entityType);
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function toConflictDto(row: ConflictRow): SyncConflictDto {
  return {
    id: row.id,
    mutationId: row.mutation_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    op: row.op as SyncConflictDto['op'],
    deviceId: row.device_id,
    userId: row.user_id,
    baseVersion: row.base_version,
    serverVersion: row.server_version,
    reason: row.reason,
    clientPayload: asObject(row.client_payload),
    serverSnapshot: row.server_snapshot === null ? null : asObject(row.server_snapshot),
    status: row.status as SyncConflictDto['status'],
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at === null ? null : iso(row.resolved_at),
    note: row.note,
    createdAt: iso(row.created_at),
  };
}

/** GET /sync/conflicts: own conflicts plus those of types the caller approves. Keyset on the uuid v7 id. */
export async function listConflicts(
  db: Database,
  caller: SyncCaller,
  query: ConflictListQuery,
): Promise<{ items: SyncConflictDto[]; nextCursor: string | undefined }> {
  let q = db
    .selectFrom('sync_conflict')
    .selectAll()
    .orderBy('id', 'asc')
    .limit(query.limit + 1);
  const types = approvableTypes(caller);
  q = q.where((eb) =>
    types.length > 0
      ? eb.or([eb('user_id', '=', caller.userId), eb('entity_type', 'in', types)])
      : eb('user_id', '=', caller.userId),
  );
  if (query.status !== 'ALL') {
    q = q.where('status', '=', query.status);
  }
  if (query.cursor) {
    q = q.where('id', '>', query.cursor);
  }
  const rows = await q.execute();
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toConflictDto),
    nextCursor: rows.length > query.limit && last ? last.id : undefined,
  };
}

async function resolveInTx(
  tx: Tx,
  caller: SyncCaller,
  conflictId: string,
  body: ResolveConflictRequest,
): Promise<ResolveConflictResponse> {
  const row = await tx
    .selectFrom('sync_conflict')
    .selectAll()
    .where('id', '=', conflictId)
    .forUpdate()
    .executeTakeFirst();
  // Not-found for anything the caller may not resolve: no hint that the conflict exists.
  if (!row || (row.user_id !== caller.userId && !canApprove(caller, row.entity_type))) {
    throw new AppError('NOT_FOUND', 'Conflict not found');
  }
  if (row.status !== 'OPEN') {
    throw new AppError('INVALID_TRANSITION', 'Conflict is already resolved', {
      status: row.status,
    });
  }

  let entity: EntitySummary | null = null;
  let values: Record<string, unknown> | null = null;
  if (body.resolution !== 'KEEP_SERVER') {
    const handler = getEntity(row.entity_type);
    if (!handler?.applyResolution) {
      throw new AppError('VALIDATION_FAILED', `${row.entity_type} cannot apply a resolution`);
    }
    values = body.resolution === 'MERGED' ? (body.values ?? {}) : asObject(row.client_payload);
    await lockSyncWrite(tx);
    await lockEntity(tx, row.entity_type, row.entity_id);
    entity = await handler.applyResolution(tx, caller, {
      conflict: {
        id: row.id,
        mutationId: row.mutation_id,
        entityType: row.entity_type,
        entityId: row.entity_id,
        op: row.op,
        baseVersion: row.base_version,
        serverVersion: row.server_version,
      },
      resolution: body.resolution,
      values,
    });
  }

  const status =
    body.resolution === 'KEEP_SERVER'
      ? 'RESOLVED_KEEP_SERVER'
      : body.resolution === 'APPLY_CLIENT'
        ? 'RESOLVED_APPLY_CLIENT'
        : 'RESOLVED_MERGED';
  const updated = await tx
    .updateTable('sync_conflict')
    .set({
      status,
      resolved_by: caller.userId,
      resolved_at: new Date(),
      resolved_values: values === null ? null : JSON.stringify(values),
      note: body.note ?? null,
    })
    .where('id', '=', row.id)
    .returningAll()
    .executeTakeFirstOrThrow();

  await audit.record(tx, {
    action: 'sync.conflict.resolved',
    entityType: row.entity_type,
    entityId: row.entity_id,
    before: { status: 'OPEN' },
    after: {
      status,
      conflictId: row.id,
      mutationId: row.mutation_id,
      resolution: body.resolution,
      ...(values === null ? {} : { values }),
      ...(body.note ? { note: body.note } : {}),
    },
    ctx: caller.actor,
  });

  return { conflict: toConflictDto(updated), entity };
}

/** POST /sync/conflicts/:id/resolve. One transaction; the conflict row is locked while resolving. */
export async function resolveConflict(
  db: Database,
  caller: SyncCaller,
  conflictId: string,
  body: ResolveConflictRequest,
): Promise<ResolveConflictResponse> {
  try {
    return await db.transaction().execute((tx) => resolveInTx(tx, caller, conflictId, body));
  } catch (err) {
    if (isRecordLockedError(err)) {
      throw new AppError('RECORD_LOCKED', 'Record is approved, posted or period-locked');
    }
    throw err;
  }
}
