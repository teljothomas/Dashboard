import { resolveConflict, listConflicts } from './conflicts.js';
import { pull } from './pull.js';
import { processPush } from './push.js';
import { clearEntities, getEntity, listEntities, registerEntity } from './registry.js';

/** Sync service interface (INTERFACES section 7). */
export const sync = { registerEntity, clearEntities, getEntity, listEntities };

export { registerSyncRoutes } from './routes.js';
export { CONFLICT_APPROVER_PERMISSIONS } from './conflicts.js';
export { lockSyncWrite } from './locks.js';
export { canonicalJson, classifyStaleUpdate, mutationHash } from './policy.js';
export type { StaleInput, StaleKind, StaleResult } from './policy.js';
export { clearEntities, getEntity, listEntities, pull, processPush, registerEntity };
export { listConflicts, resolveConflict };
export type {
  ChangedRow,
  ConflictDetails,
  ConflictRef,
  EntitySummary,
  HandlerOutcome,
  ResolutionInput,
  SyncCaller,
  SyncEntityHandler,
  SyncMutation,
} from './types.js';
