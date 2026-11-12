import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { FormError, InfoNote, primaryButtonClass, TextField } from '../../components/ui/form';
import { t } from '../../lib/i18n';
import { authErrorMessage, safeReturnPath } from './authErrors';
import { signIn, useAuth } from './authStore';
import { LoadingScreen, useSessionBootstrap } from './RequireAuth';

export function LoginPage() {
  useSessionBootstrap();
  const { status, expired } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const from = safeReturnPath((location.state as { from?: unknown } | null)?.from);

  if (status === 'loading') {
    return <LoadingScreen />;
  }
  if (status === 'authenticated') {
    return <Navigate to={from} replace />;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await signIn(username.trim(), password);
      void navigate(from, { replace: true });
    } catch (err) {
      setPassword('');
      setError(authErrorMessage(err));
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center px-4 py-8">
      <h1 className="text-2xl font-semibold">{t('app.name')}</h1>
      <p className="mt-1 text-slate-600">{t('login.title')}</p>

      <form
        onSubmit={(e) => {
          void onSubmit(e);
        }}
        className="mt-6 space-y-4"
        noValidate
      >
        {expired ? <InfoNote>{t('login.expired')}</InfoNote> : null}
        <TextField
          label={t('login.username')}
          name="username"
          type="text"
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
          label={t('login.password')}
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
          }}
        />
        <FormError message={error} />
        <button
          type="submit"
          className={`${primaryButtonClass} w-full`}
          disabled={busy || username.trim() === '' || password === ''}
        >
          {busy ? t('login.submitting') : t('login.submit')}
        </button>
      </form>

      <p className="mt-6 text-center text-sm">
        <Link to="/reset-password" className="inline-block min-h-11 py-3 text-sky-700 underline">
          {t('login.haveResetCode')}
        </Link>
      </p>
    </main>
  );
}
