import { createStore } from '../lib/store';

/**
 * Connectivity and sync summary shown in the global banner (OFFLINE_DESIGN §5).
 * `syncing` and `needsAttention` are written by the sync engine in Phase 12; here they only default to 0.
 */
export interface SyncState {
  online: boolean;
  /** Items currently uploading or queued to upload. */
  syncing: number;
  /** Items in FAILED or REQUIRES_RECONCILIATION that need a person. */
  needsAttention: number;
}

export const syncStatusStore = createStore<SyncState>({
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  syncing: 0,
  needsAttention: 0,
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
