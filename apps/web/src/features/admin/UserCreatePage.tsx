import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  FormError,
  InfoNote,
  primaryButtonClass,
  secondaryButtonClass,
  TextField,
} from '../../components/ui/form';
import { t } from '../../lib/i18n';
import { adminErrorMessage } from './adminErrors';
import { createUser } from './adminApi';
import { RolePicker } from './RolePicker';

export function UserCreatePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [roleIds, setRoleIds] = useState<ReadonlySet<string>>(new Set());

  const create = useMutation({
    mutationFn: () =>
      createUser({
        username: username.trim(),
        displayName: displayName.trim(),
        phone: phone.trim() === '' ? null : phone.trim(),
        password,
        // A new user has no division limiter; one can only be set by an API client for now.
        roles: [...roleIds].map((roleId) => ({ roleId, divisionId: null })),
      }),
    onSuccess: async (user) => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      // Do not keep the temporary password around in memory longer than needed.
      setPassword('');
      void navigate(`/admin/users/${user.id}`, { replace: true });
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!create.isPending) create.mutate();
  }

  function toggleRole(roleId: string): void {
    setRoleIds((current) => {
      const next = new Set(current);
      if (next.has(roleId)) next.delete(roleId);
      else next.add(roleId);
      return next;
    });
  }

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">{t('admin.users.new')}</h1>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <TextField
          label={t('login.username')}
          name="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="off"
          required
          value={username}
          onChange={(e) => {
            setUsername(e.target.value);
          }}
        />
        <TextField
          label={t('admin.users.displayName')}
          name="displayName"
          autoComplete="off"
          required
          value={displayName}
          onChange={(e) => {
            setDisplayName(e.target.value);
          }}
        />
        <TextField
          label={t('admin.users.phone')}
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="off"
          value={phone}
          onChange={(e) => {
            setPhone(e.target.value);
          }}
        />
        <TextField
          label={t('admin.users.tempPassword')}
          name="password"
          type="password"
          autoComplete="new-password"
          hint={t('admin.users.tempPasswordHint')}
          required
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
          }}
        />
        <RolePicker selected={roleIds} onToggle={toggleRole} />
        <InfoNote>{t('admin.users.divisionNote')}</InfoNote>
        {create.isError ? <FormError message={adminErrorMessage(create.error)} /> : null}
        <div className="flex flex-wrap gap-3">
          <button
            type="submit"
            className={primaryButtonClass}
            disabled={
              create.isPending ||
              username.trim() === '' ||
              displayName.trim() === '' ||
              password === ''
            }
          >
            {t('admin.users.create')}
          </button>
          <Link to="/admin/users" className={secondaryButtonClass}>
            {t('common.cancel')}
          </Link>
        </div>
      </form>
    </section>
  );
}
