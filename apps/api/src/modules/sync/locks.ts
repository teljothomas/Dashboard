import { sql } from 'kysely';
import { ZodError } from 'zod';
import type { MutationError } from '@tradex/contracts';
import { AppError } from '../../errors.js';
import type { Tx } from '../core/context.js';

/**
 * Advisory lock key shared by every transaction that writes syncable rows through the sync server
 * (shared) and by every pull (exclusive).
 *
 * Why: `sync_seq` is stamped when a row is written, but the row only becomes visible at commit. A
 * pull that read up to seq 10 could miss a row stamped 8 whose transaction commits afterwards, and
 * the device would never see it. A pull takes the exclusive lock first, so it waits for every
 * in-flight sync write to commit and blocks new ones while it reads. Any other code path that writes
 * a syncable table (admin edits of reference data, jobs) must call `lockSyncWrite` in the same
 * transaction before writing.
 */
export const SYNC_WRITE_LOCK_KEY = '731000101';

export async function lockSyncWrite(tx: Tx): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock_shared(${SYNC_WRITE_LOCK_KEY}::bigint)`.execute(tx);
}

export async function lockSyncPull(tx: Tx): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(${SYNC_WRITE_LOCK_KEY}::bigint)`.execute(tx);
}

/** Serialises everything done for one mutation id (concurrent replays of the same outbox entry). */
export async function lockMutation(tx: Tx, mutationId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sync:mutation:${mutationId}`}::text, 0))`.execute(
    tx,
  );
}

/** Serialises mutations and conflict resolutions on one entity. */
export async function lockEntity(tx: Tx, entityType: string, entityId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sync:entity:${entityType}:${entityId}`}::text, 0))`.execute(
    tx,
  );
}

function sqlState(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : undefined;
}

/** SQLSTATE raised by `forbid_update_when_locked()` (0001_core.sql). */
const RECORD_LOCKED_SQLSTATE = 'TX423';

/** True for a locked-row trigger error. */
export function isRecordLockedError(err: unknown): boolean {
  return sqlState(err) === RECORD_LOCKED_SQLSTATE;
}

/**
 * Domain failure raised by a handler that maps to a REJECTED mutation result, or null when the
 * error is unexpected (the caller rethrows and the request fails with 500).
 */
export function toMutationError(err: unknown): MutationError | null {
  if (err instanceof AppError) {
    if (err.code === 'INTERNAL' || err.code === 'UNAUTHENTICATED') {
      return null;
    }
    return { code: err.code, message: err.message };
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const where = first && first.path.length > 0 ? `${first.path.join('.')}: ` : '';
    return {
      code: 'VALIDATION_FAILED',
      message: `Payload validation failed (${where}${first?.message ?? 'invalid'})`,
    };
  }
  if (isRecordLockedError(err)) {
    return { code: 'RECORD_LOCKED', message: 'Record is approved, posted or period-locked' };
  }
  return null;
}
