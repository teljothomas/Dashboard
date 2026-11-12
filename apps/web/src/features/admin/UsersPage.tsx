import { useInfiniteQuery } from '@tanstack/react-query';
import { USER_STATUS_VALUES, type UserDto } from '@tradex/contracts';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  Badge,
  FormError,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from '../../components/ui/form';
import { t } from '../../lib/i18n';
import { adminErrorMessage } from './adminErrors';
import { adminKeys, listUsers, type UserFilter } from './adminApi';

export function userStatusBadge(status: UserDto['status']) {
  if (status === 'ACTIVE') return <Badge tone="green">{t('admin.users.status.ACTIVE')}</Badge>;
  if (status === 'DISABLED') return <Badge tone="slate">{t('admin.users.status.DISABLED')}</Badge>;
  return <Badge tone="amber">{t('admin.users.status.LOCKED')}</Badge>;
}

export function UsersPage() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<UserFilter['status']>('');
  const [applied, setApplied] = useState<UserFilter>({ q: '', status: '' });

  const users = useInfiniteQuery({
    queryKey: adminKeys.users(applied),
    queryFn: ({ pageParam }) => listUsers(applied, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.meta?.nextCursor,
  });

  function onSearch(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setApplied({ q: q.trim(), status });
  }

  const rows = users.data?.pages.flatMap((page) => page.data) ?? [];

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('admin.users.title')}</h1>
        <Link to="/admin/users/new" className={primaryButtonClass}>
          {t('admin.users.new')}
        </Link>
      </div>

      <form onSubmit={onSearch} role="search" className="space-y-2">
        <label className="block text-sm font-medium text-slate-800" htmlFor="user-search">
          {t('admin.users.search')}
        </label>
        <input
          id="user-search"
          type="search"
          className={inputClass}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
          }}
        />
        <label className="block text-sm font-medium text-slate-800" htmlFor="user-status">
          {t('admin.users.statusFilter')}
        </label>
        <select
          id="user-status"
          className={inputClass}
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as UserFilter['status']);
          }}
        >
          <option value="">{t('common.all')}</option>
          {USER_STATUS_VALUES.map((value) => (
            <option key={value} value={value}>
              {t(`admin.users.status.${value}`)}
            </option>
          ))}
        </select>
        <button type="submit" className={secondaryButtonClass}>
          {t('common.search')}
        </button>
      </form>

      {users.isPending ? <p className="text-slate-600">{t('common.loading')}</p> : null}
      {users.isError ? <FormError message={adminErrorMessage(users.error)} /> : null}
      {users.isSuccess && rows.length === 0 ? (
        <p className="text-slate-600">{t('admin.users.empty')}</p>
      ) : null}

      <ul className="space-y-2">
        {rows.map((user) => (
          <li key={user.id}>
            <Link
              to={`/admin/users/${user.id}`}
              className="block rounded-md border border-slate-200 bg-white p-3"
            >
              <span className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{user.displayName}</span>
                {userStatusBadge(user.status)}
              </span>
              <span className="block truncate text-sm text-slate-600">{user.username}</span>
              <span className="mt-1 block text-sm text-slate-600">
                {user.roles.length === 0
                  ? t('admin.users.noRoles')
                  : user.roles.map((role) => role.roleName).join(', ')}
              </span>
            </Link>
          </li>
        ))}
      </ul>

      {users.hasNextPage ? (
        <button
          type="button"
          className={`${secondaryButtonClass} w-full`}
          disabled={users.isFetchingNextPage}
          onClick={() => {
            void users.fetchNextPage();
          }}
        >
          {t('common.loadMore')}
        </button>
      ) : null}
    </section>
  );
}
