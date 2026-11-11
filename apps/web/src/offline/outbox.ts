import { SyncStatus, type PushResultItem, type SyncOp } from '@tradex/contracts';
import { uuidv7 } from '@tradex/domain';
import {
  ensureDeviceId,
  type LocalRecord,
  type MutationErrorInfo,
  type OutboxEntry,
  type TradexOfflineDb,
} from './db';
import { deriveSyncStatus } from './status';

/** Raised by `enqueueMutation` when the request itself is invalid (a programming error in a form). */
export class OutboxError extends Error {
  readonly code: 'ALREADY_EXISTS' | 'UNKNOWN_RECORD';
  constructor(code: OutboxError['code'], message: string) {
    super(message);
    this.name = 'OutboxError';
    this.code = code;
  }
}

export interface EnqueueInput {
  userId: string;
  entityType: string;
  entityId: string;
  op: SyncOp;
  /** Wire payload (entity create/update DTO, owned by the server entity handler). */
  payload: Record<string, unknown>;
  /** Fields to show locally when they differ from the payload (default: the payload itself). */
  localData?: Record<string, unknown>;
  /** UPDATE/SUBMIT/CANCEL of a record that is not in the local store yet: the version it is based on. */
  baseVersion?: number | null;
  dependsOn?: string[];
  mutationId?: string;
  now?: number;
}

/** Fields of a pulled or acknowledged DTO that the client mirrors on the local record. */
export function readServerFields(data: Record<string, unknown>): {
  version: number | null;
  serverStatus: string | null;
  number: string | null;
  serverSyncStatus: SyncStatus | null;
} {
  const sync = SyncStatus.safeParse(data.syncStatus);
  return {
    version:
      typeof data.version === 'number' && Number.isInteger(data.version) ? data.version : null,
    serverStatus: typeof data.status === 'string' ? data.status : null,
    number: typeof data.number === 'string' ? data.number : null,
    serverSyncStatus: sync.success ? sync.data : null,
  };
}

/** Outbox entries of one record of one user, oldest first. */
export async function entriesOf(
  db: TradexOfflineDb,
  userId: string,
  entityType: string,
  entityId: string,
): Promise<OutboxEntry[]> {
  return db.outbox
    .where('[entityType+entityId]')
    .equals([entityType, entityId])
    .filter((e) => e.userId === userId)
    .sortBy('createdAt');
}

/**
 * Recompute and store the derived BR-301 status of one record. Call inside a transaction that covers
 * `records` and `outbox`, right after the outbox change, so the label can never lag the queue.
 */
export async function refreshRecordStatus(
  db: TradexOfflineDb,
  userId: string,
  entityType: string,
  id: string,
): Promise<SyncStatus | undefined> {
  const record = await db.records.get([userId, entityType, id]);
  if (record === undefined) {
    return undefined;
  }
  const entries = await entriesOf(db, userId, entityType, id);
  const status = deriveSyncStatus({
    mutations: entries.map((e) => ({ state: e.state, errorCode: e.lastError?.code ?? null })),
    server: { syncStatus: record.serverSyncStatus, status: record.serverStatus },
  });
  if (status !== record.status) {
    await db.records.put({ ...record, status });
  }
  return status;
}

/**
 * Save a change locally and queue its mutation in ONE transaction: the local record and the outbox
 * entry either both exist or neither does (OFFLINE_DESIGN section 3).
 */
export async function enqueueMutation(
  db: TradexOfflineDb,
  input: EnqueueInput,
): Promise<OutboxEntry> {
  const deviceId = await ensureDeviceId(db);
  const now = input.now ?? Date.now();
  const mutationId = input.mutationId ?? uuidv7();

  return db.transaction('rw', db.records, db.outbox, db.serverShadow, async () => {
    const key: [string, string, string] = [input.userId, input.entityType, input.entityId];
    const existing = await db.records.get(key);
    const earlier = await entriesOf(db, input.userId, input.entityType, input.entityId);

    if (input.op === 'CREATE' && (existing !== undefined || earlier.length > 0)) {
      throw new OutboxError(
        'ALREADY_EXISTS',
        `${input.entityType} ${input.entityId} already exists`,
      );
    }
    if (input.op !== 'CREATE' && existing === undefined && input.baseVersion === undefined) {
      throw new OutboxError(
        'UNKNOWN_RECORD',
        `${input.entityType} ${input.entityId} is not on this device; pass its baseVersion`,
      );
    }

    // FIFO key: strictly increasing even when two saves land in the same millisecond.
    const last = await db.outbox.orderBy('createdAt').last();
    const createdAt = Math.max(now, (last?.createdAt ?? 0) + 1);

    let baseVersion: number | null = null;
    if (input.op !== 'CREATE') {
      // Behind another mutation of the same record the base is unknown until that one is acknowledged;
      // it is filled from the local record when this entry becomes the head (see `resolveBaseVersion`).
      baseVersion = earlier.length > 0 ? null : (input.baseVersion ?? existing?.version ?? null);
    }

    const entry: OutboxEntry = {
      mutationId,
      userId: input.userId,
      deviceId,
      entityType: input.entityType,
      entityId: input.entityId,
      op: input.op,
      baseVersion,
      clientCreatedAt: new Date(now).toISOString(),
      payload: input.payload,
      dependsOn: input.dependsOn ?? [],
      state: 'PENDING',
      attempts: 0,
      lastError: null,
      conflictId: null,
      createdAt,
    };
    await db.outbox.put(entry);

    const localFields = input.localData ?? input.payload;
    const data =
      input.op === 'CREATE' || input.op === 'UPDATE'
        ? { ...(existing?.data ?? {}), ...localFields }
        : (existing?.data ?? {});
    const record: LocalRecord = {
      userId: input.userId,
      entityType: input.entityType,
      id: input.entityId,
      version: existing?.version ?? input.baseVersion ?? null,
      serverStatus: existing?.serverStatus ?? null,
      serverSyncStatus: existing?.serverSyncStatus ?? null,
      number: existing?.number ?? null,
      data,
      status: 'LOCAL_ONLY',
      updatedAt: now,
    };
    await db.records.put(record);
    await refreshRecordStatus(db, input.userId, input.entityType, input.entityId);
    return entry;
  });
}

/** A mutation as the engine sends it, with its base version resolved. */
export interface ReadyMutation {
  entry: OutboxEntry;
  baseVersion: number | null;
}

async function dependenciesUploaded(db: TradexOfflineDb, entry: OutboxEntry): Promise<boolean> {
  if (entry.dependsOn.length === 0) {
    return true;
  }
  const items = await db.attachmentsQueue.bulkGet(entry.dependsOn);
  return items.every((item) => item !== undefined && item.state === 'UPLOADED');
}

/**
 * Next mutations to send, FIFO. Rules:
 *  - only entries of `userId` (data stays locked to the user who made it);
 *  - at most ONE entry per record per batch, so a follow-up edit always goes out with the version the
 *    server assigned to the previous one;
 *  - a record with a CONFLICT or REJECTED entry sends nothing until a person acts (SYNC_DESIGN 2.1);
 *  - an entry whose attachments are not uploaded yet holds back the rest of its record.
 * `exclude` holds mutations that already came back transient in this run.
 */
export async function nextBatch(
  db: TradexOfflineDb,
  userId: string,
  limit: number,
  exclude: ReadonlySet<string> = new Set(),
): Promise<ReadyMutation[]> {
  const mine = await db.outbox.where('userId').equals(userId).sortBy('createdAt');
  const blocked = new Set<string>();
  for (const e of mine) {
    if (e.state === 'CONFLICT' || e.state === 'REJECTED') {
      blocked.add(`${e.entityType}/${e.entityId}`);
    }
  }
  const seen = new Set<string>();
  const batch: ReadyMutation[] = [];
  for (const entry of mine) {
    if (batch.length >= limit) {
      break;
    }
    const recordKey = `${entry.entityType}/${entry.entityId}`;
    if (seen.has(recordKey)) {
      continue;
    }
    seen.add(recordKey);
    if (entry.state !== 'PENDING' || blocked.has(recordKey) || exclude.has(entry.mutationId)) {
      continue;
    }
    if (!(await dependenciesUploaded(db, entry))) {
      continue;
    }
    let baseVersion = entry.baseVersion;
    if (baseVersion === null && entry.op !== 'CREATE') {
      const record = await db.records.get([entry.userId, entry.entityType, entry.entityId]);
      baseVersion = record?.version ?? null;
      if (baseVersion === null) {
        continue; // unknown base: cannot be sent safely
      }
    }
    batch.push({ entry, baseVersion });
  }
  return batch;
}

export async function markSending(db: TradexOfflineDb, mutationIds: string[]): Promise<void> {
  await db.transaction('rw', db.outbox, async () => {
    for (const id of mutationIds) {
      await db.outbox.update(id, { state: 'SENDING' });
    }
  });
}

/**
 * Put entries back to PENDING after a failed or aborted send. A crash mid-push leaves SENDING
 * behind; resending is safe because the server replays stored results by mutationId.
 */
export async function releaseSending(
  db: TradexOfflineDb,
  mutationIds: string[],
  options: { countAttempt: boolean; error?: MutationErrorInfo },
): Promise<void> {
  await db.transaction('rw', db.outbox, db.records, async () => {
    for (const id of mutationIds) {
      const entry = await db.outbox.get(id);
      if (entry === undefined || entry.state !== 'SENDING') {
        continue;
      }
      await db.outbox.put({
        ...entry,
        state: 'PENDING',
        attempts: entry.attempts + (options.countAttempt ? 1 : 0),
        lastError: options.error ?? entry.lastError,
      });
    }
  });
}

/** Run at the start of every sync run (the lock is held): SENDING entries are orphans of a crash. */
export async function resetOrphanedSending(db: TradexOfflineDb): Promise<number> {
  const orphans = await db.outbox.where('state').equals('SENDING').primaryKeys();
  await releaseSending(db, orphans, { countAttempt: false });
  return orphans.length;
}

export interface PushOutcome {
  applied: number;
  conflicts: number;
  rejected: number;
  /** DUPLICATE_SUSPECTED / BLOCKED_BY_PREVIOUS / no result: back to PENDING, resend later. */
  transient: string[];
}

/**
 * Apply the server's per-mutation results. The outbox entry is deleted ONLY on APPLIED. In the same
 * transaction the local record takes the acknowledged server summary, so the status moves
 * LOCAL_ONLY -> SYNCED/AWAITING_* atomically with the entry disappearing.
 */
export async function applyPushResults(
  db: TradexOfflineDb,
  sent: readonly OutboxEntry[],
  results: readonly PushResultItem[],
): Promise<PushOutcome> {
  const byId = new Map(results.map((r) => [r.mutationId, r]));
  const outcome: PushOutcome = { applied: 0, conflicts: 0, rejected: 0, transient: [] };

  await db.transaction('rw', db.outbox, db.records, db.serverShadow, async () => {
    for (const sentEntry of sent) {
      const entry = await db.outbox.get(sentEntry.mutationId);
      if (entry === undefined) {
        continue;
      }
      const result = byId.get(entry.mutationId);
      const touched: [string, string, string] = [entry.userId, entry.entityType, entry.entityId];

      switch (result?.result) {
        case 'APPLIED': {
          await db.outbox.delete(entry.mutationId);
          const record = await db.records.get(touched);
          if (record !== undefined && result.entity !== undefined) {
            await db.records.put({
              ...record,
              version: result.entity.version,
              serverStatus: result.entity.status,
              number: result.entity.number ?? record.number,
              serverSyncStatus: result.entity.syncStatus,
            });
          }
          if ((await entriesOf(db, entry.userId, entry.entityType, entry.entityId)).length === 0) {
            // The follow-up pull delivers the post-apply server row (the push bumped its sync_seq).
            await db.serverShadow.delete(touched);
          }
          outcome.applied += 1;
          break;
        }
        case 'CONFLICT':
          await db.outbox.put({
            ...entry,
            state: 'CONFLICT',
            conflictId: result.conflictId ?? null,
            lastError: result.error ?? entry.lastError,
            attempts: entry.attempts + 1,
          });
          outcome.conflicts += 1;
          break;
        case 'REJECTED':
          await db.outbox.put({
            ...entry,
            state: 'REJECTED',
            lastError: result.error ?? { code: 'REJECTED', message: 'Rejected by the server' },
            attempts: entry.attempts + 1,
          });
          outcome.rejected += 1;
          break;
        case 'DUPLICATE_SUSPECTED':
        case 'BLOCKED_BY_PREVIOUS':
        case undefined:
          await db.outbox.put({
            ...entry,
            state: 'PENDING',
            lastError: result?.error ?? entry.lastError,
            attempts: entry.attempts + 1,
          });
          outcome.transient.push(entry.mutationId);
          break;
      }
      await refreshRecordStatus(db, entry.userId, entry.entityType, entry.entityId);
    }
  });
  return outcome;
}

/** A person decided to try again (REJECTED/CONFLICT -> PENDING). */
export async function retryEntry(db: TradexOfflineDb, mutationId: string): Promise<void> {
  await db.transaction('rw', db.outbox, db.records, async () => {
    const entry = await db.outbox.get(mutationId);
    if (entry === undefined || (entry.state !== 'REJECTED' && entry.state !== 'CONFLICT')) {
      return;
    }
    await db.outbox.put({
      ...entry,
      state: 'PENDING',
      attempts: 0,
      lastError: null,
      conflictId: null,
    });
    await refreshRecordStatus(db, entry.userId, entry.entityType, entry.entityId);
  });
}

/**
 * A person decided to drop a blocked change (for example after choosing KEEP_SERVER). Discarding a
 * CREATE removes the whole local record with everything queued behind it.
 */
export async function discardEntry(db: TradexOfflineDb, mutationId: string): Promise<void> {
  await db.transaction('rw', db.outbox, db.records, db.serverShadow, async () => {
    const entry = await db.outbox.get(mutationId);
    if (entry === undefined || (entry.state !== 'REJECTED' && entry.state !== 'CONFLICT')) {
      return;
    }
    if (entry.op === 'CREATE') {
      // The server never saw this record, so nothing that was queued behind the CREATE can apply.
      const dependents = await entriesOf(db, entry.userId, entry.entityType, entry.entityId);
      await db.outbox.bulkDelete(dependents.map((e) => e.mutationId));
      await db.records.delete([entry.userId, entry.entityType, entry.entityId]);
      await db.serverShadow.delete([entry.userId, entry.entityType, entry.entityId]);
      return;
    }
    await db.outbox.delete(mutationId);
    await refreshRecordStatus(db, entry.userId, entry.entityType, entry.entityId);
  });
}

export interface OutboxCounts {
  /** PENDING + SENDING entries. */
  syncing: number;
  /** Records in FAILED or REQUIRES_RECONCILIATION. */
  needsAttention: number;
}

export async function outboxCounts(db: TradexOfflineDb, userId: string): Promise<OutboxCounts> {
  const [pending, sending, flagged] = await Promise.all([
    db.outbox
      .where('userId')
      .equals(userId)
      .filter((e) => e.state === 'PENDING')
      .count(),
    db.outbox
      .where('userId')
      .equals(userId)
      .filter((e) => e.state === 'SENDING')
      .count(),
    db.records
      .where('[userId+status]')
      .anyOf([
        [userId, 'FAILED'],
        [userId, 'REQUIRES_RECONCILIATION'],
      ])
      .count(),
  ]);
  return { syncing: pending + sending, needsAttention: flagged };
}
