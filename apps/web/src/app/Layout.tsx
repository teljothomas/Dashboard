import { NavLink, Outlet } from 'react-router';
import { SyncBanner } from '../components/ui/SyncBanner';
import { t } from '../lib/i18n';
import { NAV_ITEMS } from './navItems';

/** Mobile-first shell: top bar, sync banner, content area, bottom navigation (touch targets >= 44 px). */
export function Layout() {
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 bg-slate-900 text-white">
        <div className="mx-auto flex h-12 max-w-3xl items-center px-4">
          <span className="text-base font-semibold">{t('app.name')}</span>
        </div>
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
          {NAV_ITEMS.map((item) => (
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
