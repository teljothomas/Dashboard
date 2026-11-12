import type { AuditEntryDto, AuditQuery } from '@tradex/contracts';
import { sql } from 'kysely';
import type { Tx } from '../core/context.js';

/**
 * `GET /audit` (audit.view): newest first, keyset paged by id. Filters are exact matches plus an
 * inclusive time range. The log is append-only and never holds secrets (audit.record callers pass
 * field names and ids, not passwords or codes).
 */
export async function listAudit(
  db: Tx,
  query: AuditQuery,
): Promise<{ items: AuditEntryDto[]; nextCursor: string | null }> {
  let qb = db
    .selectFrom('audit_log')
    .select([
      'id',
      'at',
      'actor_user_id',
      'device_id',
      'request_id',
      'action',
      'entity_type',
      'entity_id',
      'before',
      'after',
      'ip',
    ])
    .orderBy('id', 'desc')
    .limit(query.limit + 1);
  if (query.entityType !== undefined) qb = qb.where('entity_type', '=', query.entityType);
  if (query.entityId !== undefined) qb = qb.where('entity_id', '=', query.entityId);
  if (query.action !== undefined) qb = qb.where('action', '=', query.action);
  if (query.actorUserId !== undefined) qb = qb.where('actor_user_id', '=', query.actorUserId);
  if (query.from !== undefined) qb = qb.where('at', '>=', new Date(query.from));
  if (query.to !== undefined) qb = qb.where('at', '<=', new Date(query.to));
  if (query.before !== undefined) qb = qb.where(sql<boolean>`id < ${query.before}::bigint`);

  const rows = await qb.execute();
  const page = rows.slice(0, query.limit);
  return {
    items: page.map((row) => ({
      id: row.id,
      at: row.at.toISOString(),
      actorUserId: row.actor_user_id,
      deviceId: row.device_id,
      requestId: row.request_id,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      before: row.before,
      after: row.after,
      ip: row.ip,
    })),
    nextCursor: rows.length > query.limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}
