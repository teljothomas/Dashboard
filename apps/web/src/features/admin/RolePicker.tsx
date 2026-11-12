import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { t } from '../../lib/i18n';
import { adminErrorMessage } from './adminErrors';
import { adminKeys, listRoles } from './adminApi';

interface RolePickerProps {
  selected: ReadonlySet<string>;
  onToggle: (roleId: string) => void;
  disabled?: boolean;
}

/** Checkbox per role. Needs `roles.manage` to list roles; without it the picker says so. */
export function RolePicker({ selected, onToggle, disabled = false }: RolePickerProps) {
  const legendId = useId();
  const roles = useQuery({ queryKey: adminKeys.roles, queryFn: listRoles });

  return (
    <fieldset aria-labelledby={legendId} disabled={disabled}>
      <legend id={legendId} className="mb-1 text-sm font-medium text-slate-800">
        {t('admin.roles.title')}
      </legend>
      {roles.isPending ? <p className="text-sm text-slate-600">{t('common.loading')}</p> : null}
      {roles.isError ? (
        <p role="alert" className="text-sm text-red-800">
          {t('admin.roles.unavailable')} {adminErrorMessage(roles.error)}
        </p>
      ) : null}
      <ul className="space-y-1">
        {(roles.data ?? []).map((role) => (
          <li key={role.id}>
            <label className="flex min-h-11 items-center gap-3 text-base">
              <input
                type="checkbox"
                className="size-5"
                checked={selected.has(role.id)}
                onChange={() => {
                  onToggle(role.id);
                }}
              />
              <span>{role.name}</span>
              <span className="text-sm text-slate-500">{role.code}</span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
