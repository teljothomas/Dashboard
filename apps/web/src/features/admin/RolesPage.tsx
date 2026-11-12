import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Badge, FormError, primaryButtonClass } from '../../components/ui/form';
import { t } from '../../lib/i18n';
import { adminKeys, listRoles } from './adminApi';
import { adminErrorMessage } from './adminErrors';

export function RolesPage() {
  const roles = useQuery({ queryKey: adminKeys.roles, queryFn: listRoles });
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('admin.roles.title')}</h1>
        <Link to="/admin/roles/new" className={primaryButtonClass}>
          {t('admin.roles.new')}
        </Link>
      </div>
      {roles.isPending ? <p className="text-slate-600">{t('common.loading')}</p> : null}
      {roles.isError ? <FormError message={adminErrorMessage(roles.error)} /> : null}
      <ul className="space-y-2">
        {(roles.data ?? []).map((role) => (
          <li key={role.id}>
            <Link
              to={`/admin/roles/${role.id}`}
              className="block rounded-md border border-slate-200 bg-white p-3"
            >
              <span className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{role.name}</span>
                {role.isSystem ? <Badge tone="slate">{t('admin.roles.system')}</Badge> : null}
              </span>
              <span className="block text-sm text-slate-600">{role.code}</span>
              <span className="block text-sm text-slate-600">
                {t('admin.roles.permissionCount', { count: role.permissions.length })}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
