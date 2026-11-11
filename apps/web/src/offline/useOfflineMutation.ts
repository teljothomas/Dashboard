import type { SyncOp } from '@tradex/contracts';
import { uuidv7 } from '@tradex/domain';
import { useCallback, useState } from 'react';
import { sessionStore } from '../lib/session';
import type { OutboxEntry, TradexOfflineDb } from './db';
import { enqueueMutation } from './outbox';
import { getOfflineRuntime } from './runtime';

export class OfflineMutationError extends Error {
  readonly code: 'NO_SESSION';
  constructor(code: OfflineMutationError['code'], message: string) {
    super(message);
    this.name = 'OfflineMutationError';
    this.code = code;
  }
}

export interface OfflineMutationInput {
  /** Defaults to CREATE when no `entityId` is given, UPDATE otherwise. */
  op?: SyncOp;
  /** CREATE: client-generated UUID v7 (generated here when omitted). */
  entityId?: string;
  payload: Record<string, unknown>;
  /** What to show locally when it differs from the wire payload. */
  localData?: Record<string, unknown>;
  /** For a record that is not on this device yet. */
  baseVersion?: number | null;
  /** Local attachment ids that must upload first. */
  dependsOn?: string[];
}

export interface OfflineMutationSaved {
  mutationId: string;
  entityId: string;
  entry: OutboxEntry;
}

export interface OfflineMutationDeps {
  db: TradexOfflineDb;
  /** Called after the local save. Default: ask the sync engine for a run. Never awaited. */
  triggerSync: () => void;
  getUserId: () => string | undefined;
}

function defaultDeps(): OfflineMutationDeps {
  const { db, engine } = getOfflineRuntime();
  return {
    db,
    triggerSync: () => {
      void engine.trigger('local-save');
    },
    getUserId: () => sessionStore.get().userId,
  };
}

/**
 * Save locally, queue the mutation (one transaction), then ask for a sync. Resolves as soon as the
 * data is safe on the device: it never waits for the network.
 */
export async function saveOffline(
  deps: OfflineMutationDeps,
  entityType: string,
  input: OfflineMutationInput,
): Promise<OfflineMutationSaved> {
  const userId = deps.getUserId();
  if (userId === undefined) {
    throw new OfflineMutationError('NO_SESSION', 'Sign in before saving');
  }
  const op: SyncOp = input.op ?? (input.entityId === undefined ? 'CREATE' : 'UPDATE');
  const entityId = input.entityId ?? uuidv7();
  const entry = await enqueueMutation(deps.db, {
    userId,
    entityType,
    entityId,
    op,
    payload: input.payload,
    ...(input.localData === undefined ? {} : { localData: input.localData }),
    ...(input.baseVersion === undefined ? {} : { baseVersion: input.baseVersion }),
    ...(input.dependsOn === undefined ? {} : { dependsOn: input.dependsOn }),
  });
  try {
    deps.triggerSync();
  } catch {
    // The save is durable; the next interval or online event uploads it.
  }
  return { mutationId: entry.mutationId, entityId, entry };
}

/**
 * Hook for module forms: `const save = useOfflineMutation('expense'); await save.mutateAsync({ payload })`.
 * `deps` is for tests; the app uses the shared runtime.
 */
export function useOfflineMutation(entityType: string, deps?: OfflineMutationDeps) {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const mutateAsync = useCallback(
    async (input: OfflineMutationInput): Promise<OfflineMutationSaved> => {
      setIsPending(true);
      setError(null);
      try {
        return await saveOffline(deps ?? defaultDeps(), entityType, input);
      } catch (err) {
        const failure = err instanceof Error ? err : new Error(String(err));
        setError(failure);
        throw failure;
      } finally {
        setIsPending(false);
      }
    },
    [deps, entityType],
  );

  const reset = useCallback(() => {
    setError(null);
  }, []);

  return { mutateAsync, isPending, error, reset };
}
