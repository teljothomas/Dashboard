import { t } from '../../lib/i18n';
import { useStore } from '../../lib/store';
import { syncStatusStore } from '../../offline/status';

/** Global offline / syncing / needs-attention banner. Renders nothing when all is well. */
export function SyncBanner() {
  const online = useStore(syncStatusStore, (s) => s.online);
  const syncing = useStore(syncStatusStore, (s) => s.syncing);
  const needsAttention = useStore(syncStatusStore, (s) => s.needsAttention);

  let message: string | undefined;
  let tone = 'bg-slate-700 text-white';
  if (!online) {
    message = t('sync.offline');
    tone = 'bg-amber-600 text-white';
  } else if (needsAttention > 0) {
    message = t('sync.attention', { count: needsAttention });
    tone = 'bg-red-700 text-white';
  } else if (syncing > 0) {
    message = t('sync.syncing', { count: syncing });
  }

  if (message === undefined) {
    return null;
  }
  return (
    <div role="status" aria-live="polite" className={`px-4 py-2 text-sm ${tone}`}>
      {message}
    </div>
  );
}
