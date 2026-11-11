import type { SyncStatus } from '@tradex/contracts';
import { useState } from 'react';
import { t, type MessageKey } from '../../lib/i18n';

const TONE: Record<SyncStatus, string> = {
  LOCAL_ONLY: 'bg-amber-100 text-amber-900 border-amber-400',
  SYNCED: 'bg-emerald-100 text-emerald-900 border-emerald-400',
  AWAITING_APPROVAL: 'bg-sky-100 text-sky-900 border-sky-400',
  AWAITING_TALLY: 'bg-indigo-100 text-indigo-900 border-indigo-400',
  POSTED_TO_TALLY: 'bg-green-200 text-green-900 border-green-500',
  FAILED: 'bg-red-100 text-red-900 border-red-400',
  REQUIRES_RECONCILIATION: 'bg-orange-100 text-orange-900 border-orange-500',
};

/** BR-301 status chip. Tap to read what the status means (OFFLINE_DESIGN section 5). */
export function SyncStatusChip({ status }: { status: SyncStatus }) {
  const [open, setOpen] = useState(false);
  const label = t(`syncStatus.${status}.label` as MessageKey);
  const explanation = t(`syncStatus.${status}.explain` as MessageKey);
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`min-h-11 rounded-full border px-3 text-sm font-medium ${TONE[status]}`}
      >
        {label}
      </button>
      {open ? (
        <span role="note" className="max-w-xs text-sm text-slate-700">
          {explanation}
        </span>
      ) : null}
    </span>
  );
}
