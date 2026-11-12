import { useEffect, type ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { t } from '../../lib/i18n';
import { loadSession, useAuth, useCan } from './authStore';

/** Ask the server once per page load who is signed in. */
export function useSessionBootstrap(): void {
  const { status } = useAuth();
  useEffect(() => {
    if (status === 'loading') {
      void loadSession();
    }
  }, [status]);
}

export function LoadingScreen() {
  return (
    <div role="status" className="flex min-h-full items-center justify-center p-6 text-slate-600">
      {t('auth.loading')}
    </div>
  );
}

/**
 * Layout route: everything below it needs a signed-in user. A user who must change the password
 * can reach nothing but the change-password page.
 */
export function RequireAuth() {
  useSessionBootstrap();
  const { status, identity } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return <LoadingScreen />;
  }
  if (status === 'anonymous' || identity === undefined) {
    const from = `${location.pathname}${location.search}`;
    return <Navigate to="/login" replace state={{ from }} />;
  }
  if (identity.user.mustChangePassword && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }
  return <Outlet />;
}

export function NotAllowed() {
  return (
    <section>
      <h1 className="text-xl font-semibold">{t('auth.notAllowed.title')}</h1>
      <p className="mt-2 text-slate-600">{t('auth.notAllowed.body')}</p>
    </section>
  );
}

/** Shows the page only when the user holds at least one of the permissions (UI hint; the API decides). */
export function RequirePermission({
  anyOf,
  children,
}: {
  anyOf: readonly string[];
  children: ReactNode;
}) {
  const allowed = useCan(...anyOf);
  return allowed ? <>{children}</> : <NotAllowed />;
}
