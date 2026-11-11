import type { SyncStatus } from '@tradex/contracts';
import { createStore } from '../lib/store';

/**
 * Connectivity and sync summary shown in the global banner (OFFLINE_DESIGN §5).
 * `syncing`, `needsAttention`, `authPaused` and `lowStorage` are written by the sync engine.
 */
export interface SyncState {
  online: boolean;
  /** Items currently uploading or queued to upload. */
  syncing: number;
  /** Items in FAILED or REQUIRES_RECONCILIATION that need a person. */
  needsAttention: number;
  /** Sync stopped because the session expired (401); resumes after sign-in. */
  authPaused: boolean;
  /** Less than 50 MB of browser storage left. */
  lowStorage: boolean;
}

export const syncStatusStore = createStore<SyncState>({
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  syncing: 0,
  needsAttention: 0,
  authPaused: false,
  lowStorage: false,
});

/** Track browser online/offline events. Returns a cleanup function. */
export function startConnectivityMonitor(): () => void {
  const update = (): void => {
    syncStatusStore.set({ online: navigator.onLine });
  };
  update();
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  return () => {
    window.removeEventListener('online', update);
    window.removeEventListener('offline', update);
  };
}

// ---------------------------------------------------------------------------------------------
// BR-301 status derivation (SYNC_DESIGN 2.4). Pure: no database access.
// ---------------------------------------------------------------------------------------------

/** Outbox states as far as the status is concerned. */
export type MutationView = {
  state: 'PENDING' | 'SENDING' | 'CONFLICT' | 'REJECTED';
  /** Error code of the last rejection (`RECORD_LOCKED`, `VALIDATION_FAILED`, ...). */
  errorCode?: string | null;
};

/** What the server told us about the record (all optional: a record never synced has none). */
export interface ServerPart {
  /** Status the server computed itself (INTERFACES section 4). Authoritative when present. */
  syncStatus?: SyncStatus | null;
  /** Lifecycle status: `SUBMITTED`, `APPROVED`, ... */
  status?: string | null;
  /** Tally posting status of the record, when one exists. */
  postingStatus?: string | null;
  /** An open `sync_conflict` exists for the record. */
  openConflict?: boolean;
  /** Since when the posting has been UNCERTAIN (epoch ms). */
  uncertainSinceMs?: number | null;
}

export interface StatusInput {
  /** Outbox entries of this record only. */
  mutations: readonly MutationView[];
  /** An attachment of this record failed permanently. */
  attachmentFailed?: boolean;
  server?: ServerPart;
  nowMs?: number;
}

export const UNCERTAIN_RECONCILE_AFTER_MS = 24 * 60 * 60 * 1000;

const RECONCILE_POSTING = new Set(['REJECTED', 'DEAD', 'ALTERED_IN_TALLY']);
const AWAITING_TALLY_POSTING = new Set([
  'PENDING',
  'READY',
  'BLOCKED_MAPPING',
  'BLOCKED_VALIDATION',
  'CLAIMED',
  'FAILED_RETRYABLE',
  'UNCERTAIN',
]);

/**
 * Precedence, top to bottom (SYNC_DESIGN 2.4):
 * LOCAL_ONLY, FAILED, REQUIRES_RECONCILIATION, AWAITING_APPROVAL, AWAITING_TALLY, POSTED_TO_TALLY, SYNCED.
 *
 * One refinement: a PENDING/SENDING mutation queued behind a CONFLICT or REJECTED mutation of the same
 * record cannot upload until a person acts, so it does not count as LOCAL_ONLY; otherwise the record
 * would look harmlessly "waiting to upload" while it is stuck. Rejected entries are acknowledged by the
 * server, so they are never LOCAL_ONLY themselves.
 */
export function deriveSyncStatus(input: StatusInput): SyncStatus {
  const { mutations, server } = input;
  const nowMs = input.nowMs ?? Date.now();

  const blocked = mutations.some((m) => m.state === 'CONFLICT' || m.state === 'REJECTED');
  const waiting = mutations.some((m) => m.state === 'PENDING' || m.state === 'SENDING');

  // 1. LOCAL_ONLY
  if (waiting && !blocked) {
    return 'LOCAL_ONLY';
  }

  // 2. FAILED: validation-style rejection, or an attachment that failed permanently.
  const failedRejection = mutations.some(
    (m) => m.state === 'REJECTED' && m.errorCode !== 'RECORD_LOCKED',
  );
  if (failedRejection || input.attachmentFailed === true) {
    return 'FAILED';
  }

  // 3. REQUIRES_RECONCILIATION
  const lockedRejection = mutations.some(
    (m) => m.state === 'REJECTED' && m.errorCode === 'RECORD_LOCKED',
  );
  const conflict = mutations.some((m) => m.state === 'CONFLICT');
  const uncertainTooLong =
    server?.postingStatus === 'UNCERTAIN' &&
    server.uncertainSinceMs !== undefined &&
    server.uncertainSinceMs !== null &&
    nowMs - server.uncertainSinceMs > UNCERTAIN_RECONCILE_AFTER_MS;
  if (
    conflict ||
    lockedRejection ||
    server?.openConflict === true ||
    server?.syncStatus === 'REQUIRES_RECONCILIATION' ||
    (server?.postingStatus !== undefined &&
      server.postingStatus !== null &&
      RECONCILE_POSTING.has(server.postingStatus)) ||
    uncertainTooLong
  ) {
    return 'REQUIRES_RECONCILIATION';
  }

  // Server part. The status the server computed wins; otherwise derive it from the raw fields.
  const serverStatus = server?.syncStatus;
  if (serverStatus !== undefined && serverStatus !== null) {
    // The server never reports LOCAL_ONLY; a record it holds is at least SYNCED.
    return serverStatus === 'LOCAL_ONLY' ? 'SYNCED' : serverStatus;
  }

  // 4. AWAITING_APPROVAL
  if (server?.status === 'SUBMITTED') {
    return 'AWAITING_APPROVAL';
  }
  // 5. AWAITING_TALLY
  if (
    server?.status === 'APPROVED' &&
    server.postingStatus !== undefined &&
    server.postingStatus !== null &&
    AWAITING_TALLY_POSTING.has(server.postingStatus)
  ) {
    return 'AWAITING_TALLY';
  }
  // 6. POSTED_TO_TALLY
  if (server?.postingStatus === 'POSTED_VERIFIED') {
    return 'POSTED_TO_TALLY';
  }
  // 7. SYNCED
  return 'SYNCED';
}

/** Statuses that need a person (counted in the banner). */
export function needsAttention(status: SyncStatus): boolean {
  return status === 'FAILED' || status === 'REQUIRES_RECONCILIATION';
}
