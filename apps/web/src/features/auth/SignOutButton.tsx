import { useState } from 'react';
import { dangerButtonClass, FormError, secondaryButtonClass } from '../../components/ui/form';
import { ApiNetworkError } from '../../lib/api';
import { t } from '../../lib/i18n';
import { sessionStore } from '../../lib/session';
import { outboxCounts } from '../../offline/outbox';
import { getOfflineRuntime } from '../../offline/runtime';
import { signOut } from './authStore';

/**
 * Sign out. With items still waiting to upload it asks first and shows the count (OFFLINE_DESIGN §5).
 * Signing out never deletes them: they stay on this phone, locked to this user.
 */
export function SignOutButton() {
  const [pending, setPending] = useState<number | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function finish(): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await signOut();
    } catch (err) {
      setError(err instanceof ApiNetworkError ? t('signout.offline') : t('error.generic'));
      setBusy(false);
      setPending(undefined);
    }
  }

  async function onClick(): Promise<void> {
    setError(undefined);
    const userId = sessionStore.get().userId;
    let count = 0;
    if (userId !== undefined) {
      try {
        const counts = await outboxCounts(getOfflineRuntime().db, userId);
        count = counts.syncing + counts.needsAttention;
      } catch {
        // Local database unreadable: sign out rather than trap the user.
      }
    }
    if (count > 0) {
      setPending(count);
      return;
    }
    await finish();
  }

  if (pending !== undefined) {
    return (
      <div
        role="alertdialog"
        aria-labelledby="signout-title"
        className="space-y-3 rounded-md border border-amber-300 bg-amber-50 p-4"
      >
        <p id="signout-title" className="font-medium text-amber-950">
          {t('signout.pending.title', { count: pending })}
        </p>
        <p className="text-sm text-amber-950">{t('signout.pending.body')}</p>
        <FormError message={error} />
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            className={dangerButtonClass}
            disabled={busy}
            onClick={() => {
              void finish();
            }}
          >
            {t('signout.confirm')}
          </button>
          <button
            type="button"
            className={secondaryButtonClass}
            disabled={busy}
            onClick={() => {
              setPending(undefined);
            }}
          >
            {t('signout.stay')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <FormError message={error} />
      <button
        type="button"
        className={secondaryButtonClass}
        disabled={busy}
        onClick={() => {
          void onClick();
        }}
      >
        {t('signout.button')}
      </button>
    </div>
  );
}
