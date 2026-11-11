import type { SyncOp, SyncStatus } from '@tradex/contracts';
import Dexie, { type Table } from 'dexie';
import { getDeviceId, setDeviceId } from '../lib/session';

/**
 * Local database (OFFLINE_DESIGN section 3). One Dexie database per browser profile. Schema changes
 * add a new `version(n)` block below and bump `CURRENT_SCHEMA_VERSION`; never edit an old block.
 */
export const DB_NAME = 'tradex-offline';
export const CURRENT_SCHEMA_VERSION = 1;

export type OutboxState = 'PENDING' | 'SENDING' | 'CONFLICT' | 'REJECTED';

export interface MutationErrorInfo {
  code: string;
  message: string;
}

/** Pending mutation. FIFO by `createdAt` (strictly increasing, see `enqueueMutation`). */
export interface OutboxEntry {
  mutationId: string;
  /** Session user that made the change. Entries are only ever sent under this user. */
  userId: string;
  deviceId: string;
  entityType: string;
  entityId: string;
  op: SyncOp;
  /**
   * Version the edit is based on. Null for CREATE, and for a mutation queued behind another one for
   * the same record: it is filled from the local record when it becomes the head of its record.
   */
  baseVersion: number | null;
  clientCreatedAt: string;
  payload: Record<string, unknown>;
  /** `attachmentsQueue.localId`s that must be uploaded before this mutation is sent. */
  dependsOn: string[];
  state: OutboxState;
  attempts: number;
  lastError: MutationErrorInfo | null;
  conflictId: string | null;
  createdAt: number;
}

/** Local copy of a syncable record: server data plus local edits. */
export interface LocalRecord {
  entityType: string;
  id: string;
  /** Server version this copy is based on. Null until the server has acknowledged the record. */
  version: number | null;
  /** Server lifecycle status (`SUBMITTED`, `APPROVED`, ...). */
  serverStatus: string | null;
  /** Server part of the BR-301 status (INTERFACES section 4). */
  serverSyncStatus: SyncStatus | null;
  /** Human number assigned by the server. Null while the record is local only. */
  number: string | null;
  data: Record<string, unknown>;
  /** Derived BR-301 label (local overlay applied), kept denormalised for lists and counts. */
  status: SyncStatus;
  updatedAt: number;
}

/** Server copy stored aside while the record has pending local mutations (SYNC_DESIGN 2.2). */
export interface ServerShadow {
  entityType: string;
  id: string;
  version: number | null;
  data: Record<string, unknown>;
  syncSeq: number;
}

export interface ReferenceRow {
  entityType: string;
  id: string;
  data: Record<string, unknown>;
  syncSeq: number;
}

export type AttachmentQueueState = 'PENDING' | 'UPLOADING' | 'UPLOADED' | 'FAILED';

/** Blob and metadata until uploaded. Upload itself arrives with the attachment WPs (placeholder step). */
export interface AttachmentQueueItem {
  localId: string;
  state: AttachmentQueueState;
  createdAt: number;
  blob: Blob;
  fileName: string;
  mimeType: string;
  /** Server attachment id once uploaded. */
  attachmentId: string | null;
  lastError: MutationErrorInfo | null;
}

export interface MetaRow {
  key: string;
  value: unknown;
}

export class TradexOfflineDb extends Dexie {
  declare records: Table<LocalRecord, [string, string]>;
  declare serverShadow: Table<ServerShadow, [string, string]>;
  declare reference: Table<ReferenceRow, [string, string]>;
  declare outbox: Table<OutboxEntry, string>;
  declare attachmentsQueue: Table<AttachmentQueueItem, string>;
  declare meta: Table<MetaRow, string>;

  constructor(name: string = DB_NAME) {
    super(name);
    this.version(1).stores({
      records: '[entityType+id], entityType, status, updatedAt',
      serverShadow: '[entityType+id]',
      reference: '[entityType+id], entityType',
      outbox: 'mutationId, [entityType+entityId], state, createdAt, userId',
      attachmentsQueue: 'localId, state, createdAt',
      meta: 'key',
    });
  }
}

let defaultDb: TradexOfflineDb | undefined;

/** The shared app database. Tests create their own instances with a unique name. */
export function getOfflineDb(): TradexOfflineDb {
  defaultDb ??= new TradexOfflineDb();
  return defaultDb;
}

export async function getMeta<T>(db: TradexOfflineDb, key: string): Promise<T | undefined> {
  const row = await db.meta.get(key);
  return row === undefined ? undefined : (row.value as T);
}

export async function setMeta(db: TradexOfflineDb, key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value });
}

/** Meta keys. Pull cursors are per scope (and per user for `mine`). */
export const META = {
  deviceId: 'deviceId',
  schemaVersion: 'schemaVersion',
  lastPushAt: 'lastPushAt',
  lastPullAt: 'lastPullAt',
  cursor: (scope: string, userId?: string): string =>
    userId === undefined ? `cursor:${scope}` : `cursor:${scope}:${userId}`,
} as const;

/**
 * Device id bootstrap: one UUID per browser, stored in `meta` with a localStorage mirror, and the same
 * value that `getDeviceId()` sends as `X-Device-Id`. Meta wins when the two disagree (the mirror can
 * be cleared by the user; the database is the durable copy).
 */
export async function ensureDeviceId(db: TradexOfflineDb): Promise<string> {
  const stored = await getMeta<string>(db, META.deviceId);
  let id: string;
  if (typeof stored === 'string' && stored !== '') {
    id = stored;
    if (getDeviceId() !== stored) {
      setDeviceId(stored);
    }
  } else {
    id = getDeviceId();
    await setMeta(db, META.deviceId, id);
  }
  await setMeta(db, META.schemaVersion, CURRENT_SCHEMA_VERSION);
  return id;
}
