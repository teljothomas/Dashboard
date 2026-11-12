import type { Tx } from '../core/context.js';

/** One voucher written (created or changed) by an import batch. Unchanged vouchers are not listed. */
export interface ImportedVoucher {
  id: string;
  guid: string;
  isNew: boolean;
  baseType: string;
  voucherNumber: string;
  voucherDate: string;
  amount: string;
  erpEventId: string | null;
  isDeletedInTally: boolean;
}

export interface VouchersImportedEvent {
  companyId: string;
  batchId: string;
  vouchers: readonly ImportedVoucher[];
}

/**
 * Runs inside the batch transaction, after the vouchers are written and before the watermark moves.
 * A hook that throws rolls the whole batch back (the agent resends it), so later modules that do slow
 * or optional work should enqueue a job from the hook instead (SYNC_DESIGN section 5 step 3).
 */
export type VouchersImportedHook = (tx: Tx, event: VouchersImportedEvent) => Promise<void>;

const hooks = new Set<VouchersImportedHook>();

/** `tally.onVouchersImported(fn)`. Returns a function that removes the hook (tests). */
export function onVouchersImported(fn: VouchersImportedHook): () => void {
  hooks.add(fn);
  return () => {
    hooks.delete(fn);
  };
}

export async function runVouchersImportedHooks(
  tx: Tx,
  event: VouchersImportedEvent,
): Promise<void> {
  if (event.vouchers.length === 0) return;
  for (const hook of [...hooks]) {
    await hook(tx, event);
  }
}
