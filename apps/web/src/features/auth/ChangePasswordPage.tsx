import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { FormError, InfoNote, primaryButtonClass, TextField } from '../../components/ui/form';
import { api, ApiError } from '../../lib/api';
import { t } from '../../lib/i18n';
import { authErrorMessage } from './authErrors';
import { expireSession, loadSession, useAuth } from './authStore';

/**
 * Change password. Forced (no other page reachable, see RequireAuth) while the administrator-set
 * temporary password is still in use.
 */
export function ChangePasswordPage() {
  const { identity } = useAuth();
  const navigate = useNavigate();
  const forced = identity?.user.mustChangePassword ?? false;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    if (next !== confirm) {
      setError(t('password.mismatch'));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await api.post('/auth/change-password', { currentPassword: current, newPassword: next });
      // The flag is cleared on the server: re-read the identity, then leave the page.
      await loadSession();
      void navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        expireSession();
        return;
      }
      setError(authErrorMessage(err));
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-sm px-4 py-8">
      {forced ? null : (
        <p>
          <Link to="/more" className="inline-block min-h-11 py-3 text-sky-700 underline">
            {t('password.back')}
          </Link>
        </p>
      )}
      <h1 className="text-2xl font-semibold">{t('password.change.title')}</h1>
      {forced ? (
        <div className="mt-3">
          <InfoNote>{t('password.change.forced')}</InfoNote>
        </div>
      ) : null}
      <form
        onSubmit={(e) => {
          void onSubmit(e);
        }}
        className="mt-6 space-y-4"
        noValidate
      >
        <TextField
          label={t('password.current')}
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
          value={current}
          onChange={(e) => {
            setCurrent(e.target.value);
          }}
        />
        <TextField
          label={t('password.new')}
          name="newPassword"
          type="password"
          autoComplete="new-password"
          hint={t('password.policyHint')}
          required
          value={next}
          onChange={(e) => {
            setNext(e.target.value);
          }}
        />
        <TextField
          label={t('password.confirm')}
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => {
            setConfirm(e.target.value);
          }}
        />
        <FormError message={error} />
        <button
          type="submit"
          className={`${primaryButtonClass} w-full`}
          disabled={busy || current === '' || next === ''}
        >
          {busy ? t('password.change.submitting') : t('password.change.submit')}
        </button>
      </form>
    </main>
  );
}
