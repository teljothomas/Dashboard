import { z } from 'zod';
import { SyncStatus, Uuid } from './common.js';

/** INTERFACES section 4 / SYNC_DESIGN section 2. Device sync (channel D) wire contract. */

/** Hard limit of mutations per push (SYNC_DESIGN 2.1). */
export const MAX_PUSH_MUTATIONS = 50;
/** Default and maximum page size of a pull. */
export const MAX_PULL_LIMIT = 500;

export const SYNC_OPS = ['CREATE', 'UPDATE', 'SUBMIT', 'CANCEL'] as const;
export const SyncOp = z.enum(SYNC_OPS);
export type SyncOp = z.infer<typeof SyncOp>;

/** snake_case identifier of a syncable or reference entity type (`expense`, `fuel_entry`). */
export const EntityType = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'Expected a snake_case entity type');

export const SYNC_SCOPES = ['reference', 'mine'] as const;
export const SyncScope = z.enum(SYNC_SCOPES);
export type SyncScope = z.infer<typeof SyncScope>;

export const PushMutation = z.object({
  mutationId: Uuid,
  entityType: EntityType,
  entityId: Uuid,
  op: SyncOp,
  /** Version the client edited from. Null for CREATE. */
  baseVersion: z.number().int().min(0).nullable(),
  clientCreatedAt: z.iso.datetime({ offset: true }),
  /** Entity create/update DTO. Shape is owned by the entity handler. */
  payload: z.record(z.string(), z.unknown()),
});
export type PushMutation = z.infer<typeof PushMutation>;

export const PushRequest = z.object({
  deviceId: Uuid,
  mutations: z.array(PushMutation).min(1).max(MAX_PUSH_MUTATIONS),
});
export type PushRequest = z.infer<typeof PushRequest>;

export const MUTATION_RESULTS = [
  'APPLIED',
  'CONFLICT',
  'REJECTED',
  'DUPLICATE_SUSPECTED',
  'BLOCKED_BY_PREVIOUS',
] as const;
export const MutationResult = z.enum(MUTATION_RESULTS);
export type MutationResult = z.infer<typeof MutationResult>;

export const SyncedEntitySummary = z.object({
  id: Uuid,
  version: z.number().int(),
  status: z.string().nullable(),
  /** Human number assigned by the server (EXP-2026-00123), null until assigned. */
  number: z.string().nullable(),
  syncStatus: SyncStatus,
});
export type SyncedEntitySummary = z.infer<typeof SyncedEntitySummary>;

export const MutationError = z.object({ code: z.string(), message: z.string() });
export type MutationError = z.infer<typeof MutationError>;

export const PushResultItem = z.object({
  mutationId: Uuid,
  result: MutationResult,
  entity: SyncedEntitySummary.optional(),
  conflictId: Uuid.optional(),
  error: MutationError.optional(),
});
export type PushResultItem = z.infer<typeof PushResultItem>;

export const PushResponse = z.object({ results: z.array(PushResultItem) });
export type PushResponse = z.infer<typeof PushResponse>;

/** `GET /sync/pull?scope=&cursor=&limit=`. Query strings arrive as text, so numbers are coerced. */
export const PullQuery = z.object({
  scope: SyncScope,
  cursor: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.coerce.number().int().min(1).max(MAX_PULL_LIMIT).default(MAX_PULL_LIMIT),
});
export type PullQuery = z.infer<typeof PullQuery>;

export const PullChange = z.object({
  entityType: EntityType,
  entityId: Uuid,
  syncSeq: z.number().int().min(1),
  deleted: z.boolean(),
  data: z.record(z.string(), z.unknown()),
});
export type PullChange = z.infer<typeof PullChange>;

export const PullResponse = z.object({
  changes: z.array(PullChange),
  nextCursor: z.number().int().min(0),
  hasMore: z.boolean(),
});
export type PullResponse = z.infer<typeof PullResponse>;

export const CONFLICT_STATUSES = [
  'OPEN',
  'RESOLVED_KEEP_SERVER',
  'RESOLVED_APPLY_CLIENT',
  'RESOLVED_MERGED',
] as const;
export const ConflictStatus = z.enum(CONFLICT_STATUSES);
export type ConflictStatus = z.infer<typeof ConflictStatus>;

export const SyncConflictDto = z.object({
  id: Uuid,
  mutationId: Uuid,
  entityType: EntityType,
  entityId: Uuid,
  op: SyncOp,
  deviceId: Uuid,
  userId: z.string(),
  baseVersion: z.number().int().nullable(),
  serverVersion: z.number().int().nullable(),
  reason: z.string(),
  clientPayload: z.record(z.string(), z.unknown()),
  serverSnapshot: z.record(z.string(), z.unknown()).nullable(),
  status: ConflictStatus,
  resolvedBy: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
});
export type SyncConflictDto = z.infer<typeof SyncConflictDto>;

/** `GET /sync/conflicts?status=&limit=&cursor=` (default: OPEN). Cursor is the last conflict id. */
export const ConflictListQuery = z.object({
  status: z.union([z.literal('ALL'), ConflictStatus]).default('OPEN'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: Uuid.optional(),
});
export type ConflictListQuery = z.infer<typeof ConflictListQuery>;

export const CONFLICT_RESOLUTIONS = ['KEEP_SERVER', 'APPLY_CLIENT', 'MERGED'] as const;
export const ConflictResolution = z.enum(CONFLICT_RESOLUTIONS);
export type ConflictResolution = z.infer<typeof ConflictResolution>;

/**
 * `POST /sync/conflicts/:id/resolve`. KEEP_SERVER and APPLY_CLIENT take no values (the stored
 * client payload is applied). MERGED carries the explicit values to write.
 */
export const ResolveConflictRequest = z
  .object({
    resolution: ConflictResolution,
    values: z.record(z.string(), z.unknown()).optional(),
    note: z.string().min(1).max(2000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.resolution === 'MERGED') {
      if (!value.values || Object.keys(value.values).length === 0) {
        ctx.addIssue({ code: 'custom', path: ['values'], message: 'MERGED requires values' });
      }
    } else if (value.values !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['values'],
        message: 'values are only allowed for MERGED',
      });
    }
  });
export type ResolveConflictRequest = z.infer<typeof ResolveConflictRequest>;

/** `entity` is the new server summary after APPLY_CLIENT / MERGED, null for KEEP_SERVER. */
export const ResolveConflictResponse = z.object({
  conflict: SyncConflictDto,
  entity: SyncedEntitySummary.nullable(),
});
export type ResolveConflictResponse = z.infer<typeof ResolveConflictResponse>;
