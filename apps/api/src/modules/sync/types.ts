import type {
  MutationError,
  PushMutation,
  SyncScope,
  SyncedEntitySummary,
} from '@tradex/contracts';
import type { ActorContext, Tx } from '../core/context.js';

/** Who is pushing or pulling, as established by the auth seam. */
export interface SyncCaller {
  userId: string;
  /** Device the request comes from (the push body's `deviceId`; the pull's authenticated device). */
  deviceId: string | null;
  permissions: readonly string[];
  /** Actor fields for audit rows. */
  actor: ActorContext;
}

/** One device mutation as received (after Zod validation). */
export type SyncMutation = PushMutation;

export type EntitySummary = SyncedEntitySummary;

/** Server side of a conflict, written to `sync_conflict` by the framework. */
export interface ConflictDetails {
  /** Short machine reason, e.g. `STALE_FINANCIAL_FIELD`, `UNIQUE_VIOLATION`. */
  reason: string;
  baseVersion: number | null;
  serverVersion: number | null;
  serverSnapshot: Record<string, unknown> | null;
}

/**
 * What a handler returns. `REJECTED` may also be signalled by throwing an `AppError` (RECORD_LOCKED,
 * INVALID_TRANSITION, VALIDATION_FAILED, FORBIDDEN, NOT_FOUND) or a ZodError; the framework rolls
 * back the mutation's transaction and records the rejection.
 *
 * A handler that returns anything other than `APPLIED` must not have written business rows: the
 * framework commits the transaction so the conflict row and stored result land together.
 */
export type HandlerOutcome =
  | {
      result: 'APPLIED';
      entity: EntitySummary;
      /** Disjoint non-financial auto-merge. */ merged?: boolean;
    }
  | { result: 'CONFLICT'; conflict: ConflictDetails }
  | { result: 'REJECTED'; error: MutationError }
  | { result: 'DUPLICATE_SUSPECTED'; error: MutationError };

/** A row a handler reports for a pull. `syncSeq` is the `sync_seq` column (bigint text from pg). */
export interface ChangedRow<TRow = unknown> {
  entityId: string;
  syncSeq: string | number | bigint;
  deleted: boolean;
  row: TRow;
}

export interface ConflictRef {
  id: string;
  mutationId: string;
  entityType: string;
  entityId: string;
  op: string;
  baseVersion: number | null;
  serverVersion: number | null;
}

export interface ResolutionInput {
  conflict: ConflictRef;
  resolution: 'APPLY_CLIENT' | 'MERGED';
  /** APPLY_CLIENT: the stored client payload. MERGED: the explicit values. */
  values: Record<string, unknown>;
}

/**
 * Entity handler registered with `sync.registerEntity` (INTERFACES section 7). All methods run in
 * the framework's transaction (`tx`) and must audit their own domain changes in it. The framework
 * already holds the per-entity advisory lock and the sync write lock, so the entity row can be read
 * and written without `FOR UPDATE` races from other sync pushes.
 *
 * Operations a type does not support (reference types) are simply omitted: the mutation is rejected
 * with VALIDATION_FAILED.
 */
export interface SyncEntityHandler<TRow = unknown> {
  /** Pull scopes this type participates in. */
  scopes: readonly SyncScope[];
  create?(tx: Tx, caller: SyncCaller, mutation: SyncMutation): Promise<HandlerOutcome>;
  update?(tx: Tx, caller: SyncCaller, mutation: SyncMutation): Promise<HandlerOutcome>;
  submit?(tx: Tx, caller: SyncCaller, mutation: SyncMutation): Promise<HandlerOutcome>;
  cancel?(tx: Tx, caller: SyncCaller, mutation: SyncMutation): Promise<HandlerOutcome>;
  /**
   * Rows with `sync_seq > afterSeq` visible to the caller in `scope`, ordered by `sync_seq`,
   * at most `limit`. Archived or revoked rows carry `deleted: true`.
   */
  scopeFilter(
    tx: Tx,
    caller: SyncCaller,
    scope: SyncScope,
    afterSeq: number,
    limit: number,
  ): Promise<ChangedRow<TRow>[]>;
  /** DTO sent to the device for a row returned by `scopeFilter`. */
  serialize(row: TRow, caller: SyncCaller): Record<string, unknown>;
  /**
   * Applies a conflict resolution (APPLY_CLIENT or MERGED) over the current server row, ignoring the
   * stale base version but still honouring locks (throw RECORD_LOCKED). Returns the new summary.
   */
  applyResolution?(tx: Tx, caller: SyncCaller, input: ResolutionInput): Promise<EntitySummary>;
}
