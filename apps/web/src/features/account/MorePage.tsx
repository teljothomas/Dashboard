import { Link } from 'react-router';
import { Badge } from '../../components/ui/form';
import { t, type MessageKey } from '../../lib/i18n';
import { useAuth, useCan } from '../auth/authStore';
import { SignOutButton } from '../auth/SignOutButton';

const linkClass =
  'flex min-h-11 items-center rounded-md border border-slate-200 bg-white px-4 text-base text-slate-900';

function MoreLink({ to, labelKey }: { to: string; labelKey: MessageKey }) {
  return (
    <li>
      <Link to={to} className={linkClass}>
        {t(labelKey)}
      </Link>
    </li>
  );
}

/** "More": account actions and the administration entry points the user may open. */
export function MorePage() {
  const { identity } = useAuth();
  const canUsers = useCan('users.manage');
  const canRoles = useCan('roles.manage');
  const canAudit = useCan('audit.view');

  return (
    <section className="space-y-6">
      <h1 className="text-xl font-semibold">{t('page.more.title')}</h1>

      {identity === undefined ? null : (
        <div>
          <p className="text-lg font-medium">{identity.user.displayName}</p>
          <p className="text-sm text-slate-600">{identity.user.username}</p>
          <p className="mt-2 flex flex-wrap gap-2">
            {identity.roles.map((role) => (
              <Badge key={role} tone="slate">
                {role}
              </Badge>
            ))}
          </p>
        </div>
      )}

      {canUsers || canRoles || canAudit ? (
        <div>
          <h2 className="mb-2 text-sm font-semibold tracking-wide text-slate-600 uppercase">
            {t('admin.section')}
          </h2>
          <ul className="space-y-2">
            {canUsers ? <MoreLink to="/admin/users" labelKey="admin.users.title" /> : null}
            {canRoles ? <MoreLink to="/admin/roles" labelKey="admin.roles.title" /> : null}
            {canAudit ? <MoreLink to="/admin/audit" labelKey="admin.audit.title" /> : null}
          </ul>
        </div>
      ) : null}

      <div>
        <h2 className="mb-2 text-sm font-semibold tracking-wide text-slate-600 uppercase">
          {t('account.section')}
        </h2>
        <ul className="space-y-2">
          <MoreLink to="/change-password" labelKey="password.change.title" />
        </ul>
        <div className="mt-4">
          <SignOutButton />
        </div>
      </div>
    </section>
  );
}
