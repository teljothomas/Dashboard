import { NavLink, Outlet } from 'react-router';
import { SyncBanner } from '../components/ui/SyncBanner';
import { hasAnyPermission, useAuth } from '../features/auth/authStore';
import { t } from '../lib/i18n';
import { NAV_ITEMS } from './navItems';

/** Mobile-first shell: top bar, sync banner, content area, bottom navigation (touch targets >= 44 px). */
export function Layout() {
  const { identity, verified } = useAuth();
  const items = NAV_ITEMS.filter(
    (item) => item.anyOf.length === 0 || hasAnyPermission(identity, item.anyOf),
  );
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 bg-slate-900 text-white">
        <div className="mx-auto flex h-12 max-w-3xl items-center justify-between gap-3 px-4">
          <span className="text-base font-semibold">{t('app.name')}</span>
          {identity === undefined ? null : (
            <span className="truncate text-sm text-slate-300">{identity.user.displayName}</span>
          )}
        </div>
        {verified ? null : (
          <div role="status" className="bg-amber-600 px-4 py-2 text-sm text-white">
            {t('auth.unverified')}
          </div>
        )}
        <SyncBanner />
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pt-4 pb-24">
        <Outlet />
      </main>

      <nav
        aria-label={t('nav.label')}
        className="fixed inset-x-0 bottom-0 z-10 border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)]"
      >
        <ul className="mx-auto flex max-w-3xl">
          {items.map((item) => (
            <li key={item.to} className="flex-1">
              <NavLink
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  `flex min-h-14 items-center justify-center px-1 text-sm font-medium ${
                    isActive ? 'text-sky-700' : 'text-slate-600'
                  }`
                }
              >
                {t(item.labelKey)}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
