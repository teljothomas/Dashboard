import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { FormError, primaryButtonClass, TextField } from '../../components/ui/form';
import { api } from '../../lib/api';
import { t } from '../../lib/i18n';
import { resetErrorMessage } from './authErrors';

/** Public page: finish a password reset with the code an administrator read out (OD-032). */
export function ResetPasswordPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    if (newPassword !== confirm) {
      setError(t('password.mismatch'));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await api.post('/auth/reset/complete', {
        username: username.trim(),
        code: code.trim(),
        newPassword,
      });
      void navigate('/login', { replace: true });
    } catch (err) {
      setError(resetErrorMessage(err));
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center px-4 py-8">
      <h1 className="text-2xl font-semibold">{t('reset.title')}</h1>
      <p className="mt-1 text-slate-600">{t('reset.intro')}</p>
      <form
        onSubmit={(e) => {
          void onSubmit(e);
        }}
        className="mt-6 space-y-4"
        noValidate
      >
        <TextField
          label={t('login.username')}
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          value={username}
          onChange={(e) => {
            setUsername(e.target.value);
          }}
        />
        <TextField
          label={t('reset.code')}
          name="code"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          required
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
          }}
        />
        <TextField
          label={t('password.new')}
          name="newPassword"
          type="password"
          autoComplete="new-password"
          required
          value={newPassword}
          onChange={(e) => {
            setNewPassword(e.target.value);
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
          disabled={busy || username.trim() === '' || code.trim() === '' || newPassword === ''}
        >
          {busy ? t('reset.submitting') : t('reset.submit')}
        </button>
      </form>
      <p className="mt-6 text-center text-sm">
        <Link to="/login" className="inline-block min-h-11 py-3 text-sky-700 underline">
          {t('reset.backToLogin')}
        </Link>
      </p>
    </main>
  );
}
