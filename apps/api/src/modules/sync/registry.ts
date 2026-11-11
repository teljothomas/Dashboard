import type { SyncEntityHandler } from './types.js';

const ENTITY_TYPE = /^[a-z][a-z0-9_]*$/;

const handlers = new Map<string, SyncEntityHandler>();

/**
 * Registers the handler for an entity type (INTERFACES section 7). Each domain module registers
 * its types at startup. Registering a type twice is a programming error.
 */
export function registerEntity<TRow>(entityType: string, handler: SyncEntityHandler<TRow>): void {
  if (!ENTITY_TYPE.test(entityType) || entityType.length > 64) {
    throw new Error(`Invalid sync entity type: ${entityType}`);
  }
  if (handlers.has(entityType)) {
    throw new Error(`Sync entity type already registered: ${entityType}`);
  }
  handlers.set(entityType, handler);
}

export function getEntity(entityType: string): SyncEntityHandler | undefined {
  return handlers.get(entityType);
}

/** Registered types in name order (stable pull order). */
export function listEntities(): [string, SyncEntityHandler][] {
  return [...handlers.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Test hook: drop every registration. */
export function clearEntities(): void {
  handlers.clear();
}
