import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SCOPE_VALUES, type GrantScope, type RoleDto } from '@tradex/contracts';
import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  FormError,
  InfoNote,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
  TextField,
} from '../../components/ui/form';
import { t } from '../../lib/i18n';
import { adminKeys, createRole, listRoles, updateRole } from './adminApi';
import { adminErrorMessage } from './adminErrors';

type Grants = Record<string, GrantScope | ''>;

/** Every permission any role holds. The OWNER role holds all of them, so this is the catalogue. */
function catalogueOf(roles: readonly RoleDto[]): string[] {
  const all = new Set<string>();
  for (const role of roles) for (const grant of role.permissions) all.add(grant.permission);
  return [...all].sort();
}

function grantsOf(role: RoleDto | undefined): Grants {
  const grants: Grants = {};
  for (const grant of role?.permissions ?? []) grants[grant.permission] = grant.scope;
  return grants;
}

/** Create a custom role or view/edit one. System roles are shown read-only (the API refuses edits). */
export function RoleEditorPage() {
  const { id } = useParams();
  const roles = useQuery({ queryKey: adminKeys.roles, queryFn: listRoles });

  return (
    <div className="space-y-4">
      <p>
        <Link to="/admin/roles" className="inline-block min-h-11 py-3 text-sky-700 underline">
          {t('admin.roles.back')}
        </Link>
      </p>
      {roles.isPending ? <p className="text-slate-600">{t('common.loading')}</p> : null}
      {roles.isError ? <FormError message={adminErrorMessage(roles.error)} /> : null}
      {roles.isSuccess ? <RoleForm key={id ?? 'new'} id={id} roles={roles.data} /> : null}
    </div>
  );
}

function RoleForm({ id, roles }: { id: string | undefined; roles: RoleDto[] }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const existing = id === undefined ? undefined : roles.find((role) => role.id === id);
  const readOnly = existing?.isSystem ?? false;
  const catalogue = useMemo(() => catalogueOf(roles), [roles]);

  const [code, setCode] = useState('');
  const [name, setName] = useState(existing?.name ?? '');
  const [grants, setGrants] = useState<Grants>(grantsOf(existing));

  const save = useMutation({
    mutationFn: async () => {
      const permissions = Object.entries(grants)
        .filter((entry): entry is [string, GrantScope] => entry[1] !== '')
        .map(([permission, scope]) => ({ permission, scope }));
      if (existing === undefined) {
        return createRole({ code: code.trim(), name: name.trim(), permissions });
      }
      return updateRole(existing.id, { name: name.trim(), permissions });
    },
    onSuccess: async (role) => {
      await queryClient.invalidateQueries({ queryKey: adminKeys.roles });
      if (existing === undefined) void navigate(`/admin/roles/${role.id}`, { replace: true });
    },
  });

  if (id !== undefined && existing === undefined) {
    return <FormError message={t('admin.roles.notFound')} />;
  }

  const groups = new Map<string, string[]>();
  for (const permission of catalogue) {
    const group = permission.split('.')[0] ?? permission;
    groups.set(group, [...(groups.get(group) ?? []), permission]);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!readOnly && !save.isPending) save.mutate();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <h1 className="text-xl font-semibold">
        {existing === undefined ? t('admin.roles.new') : existing.name}
      </h1>
      {readOnly ? <InfoNote>{t('admin.roles.systemNote')}</InfoNote> : null}
      {existing === undefined ? (
        <TextField
          label={t('admin.roles.code')}
          name="code"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          hint={t('admin.roles.codeHint')}
          required
          value={code}
          onChange={(e) => {
            setCode(e.target.value.toUpperCase());
          }}
        />
      ) : (
        <p className="text-sm text-slate-600">{existing.code}</p>
      )}
      <TextField
        label={t('admin.roles.name')}
        name="name"
        required
        disabled={readOnly}
        value={name}
        onChange={(e) => {
          setName(e.target.value);
        }}
      />

      <div className="space-y-4">
        {[...groups].map(([group, permissions]) => (
          <fieldset key={group} className="space-y-2">
            <legend className="text-sm font-semibold tracking-wide text-slate-600 uppercase">
              {group}
            </legend>
            {permissions.map((permission) => (
              <div key={permission} className="flex items-center justify-between gap-3">
                <label htmlFor={`grant-${permission}`} className="min-w-0 break-words text-sm">
                  {permission}
                </label>
                <select
                  id={`grant-${permission}`}
                  className={`${inputClass} w-32 shrink-0`}
                  disabled={readOnly}
                  value={grants[permission] ?? ''}
                  onChange={(e) => {
                    const value = e.target.value as GrantScope | '';
                    setGrants((current) => ({ ...current, [permission]: value }));
                  }}
                >
                  <option value="">{t('admin.roles.scope.none')}</option>
                  {SCOPE_VALUES.map((scope) => (
                    <option key={scope} value={scope}>
                      {t(`admin.roles.scope.${scope}`)}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </fieldset>
        ))}
      </div>

      {save.isError ? <FormError message={adminErrorMessage(save.error)} /> : null}
      {save.isSuccess ? <InfoNote>{t('common.saved')}</InfoNote> : null}
      {readOnly ? null : (
        <div className="flex flex-wrap gap-3">
          <button
            type="submit"
            className={primaryButtonClass}
            disabled={
              save.isPending || name.trim() === '' || (existing === undefined && code.trim() === '')
            }
          >
            {existing === undefined ? t('admin.roles.create') : t('common.save')}
          </button>
          <Link to="/admin/roles" className={secondaryButtonClass}>
            {t('common.cancel')}
          </Link>
        </div>
      )}
    </form>
  );
}
