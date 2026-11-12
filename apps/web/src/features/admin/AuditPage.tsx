import { useInfiniteQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { FormError, secondaryButtonClass, TextField } from '../../components/ui/form';
import { formatDateTime } from '../../lib/datetime';
import { t } from '../../lib/i18n';
import { adminKeys, listAudit, type AuditFilter } from './adminApi';
import { adminErrorMessage } from './adminErrors';

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Read-only audit trail, newest first, filtered by entity type and action. */
export function AuditPage() {
  const [entityType, setEntityType] = useState('');
  const [action, setAction] = useState('');
  const [applied, setApplied] = useState<AuditFilter>({ entityType: '', action: '' });

  const audit = useInfiniteQuery({
    queryKey: adminKeys.audit(applied),
    queryFn: ({ pageParam }) => listAudit(applied, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.meta?.nextCursor,
  });

  function onSearch(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setApplied({ entityType, action });
  }

  const rows = audit.data?.pages.flatMap((page) => page.data) ?? [];

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">{t('admin.audit.title')}</h1>
      <form onSubmit={onSearch} role="search" className="space-y-3">
        <TextField
          label={t('admin.audit.entityType')}
          name="entityType"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={entityType}
          onChange={(e) => {
            setEntityType(e.target.value);
          }}
        />
        <TextField
          label={t('admin.audit.action')}
          name="action"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={action}
          onChange={(e) => {
            setAction(e.target.value);
          }}
        />
        <button type="submit" className={secondaryButtonClass}>
          {t('common.search')}
        </button>
      </form>

      {audit.isPending ? <p className="text-slate-600">{t('common.loading')}</p> : null}
      {audit.isError ? <FormError message={adminErrorMessage(audit.error)} /> : null}
      {audit.isSuccess && rows.length === 0 ? (
        <p className="text-slate-600">{t('admin.audit.empty')}</p>
      ) : null}

      <ul className="space-y-2">
        {rows.map((entry) => (
          <li key={entry.id} className="rounded-md border border-slate-200 bg-white p-3 text-sm">
            <p className="font-medium break-words">{entry.action}</p>
            <p className="break-all text-slate-600">
              {entry.entityType} · {entry.entityId}
            </p>
            <p className="text-slate-600">{formatDateTime(entry.at)}</p>
            {entry.before === null && entry.after === null ? null : (
              <details className="mt-1">
                <summary className="min-h-11 cursor-pointer py-3 text-sky-700">
                  {t('admin.audit.details')}
                </summary>
                {entry.before === null ? null : (
                  <pre className="overflow-x-auto rounded bg-slate-100 p-2 text-xs">
                    {t('admin.audit.before')}: {json(entry.before)}
                  </pre>
                )}
                {entry.after === null ? null : (
                  <pre className="mt-1 overflow-x-auto rounded bg-slate-100 p-2 text-xs">
                    {t('admin.audit.after')}: {json(entry.after)}
                  </pre>
                )}
              </details>
            )}
          </li>
        ))}
      </ul>

      {audit.hasNextPage ? (
        <button
          type="button"
          className={`${secondaryButtonClass} w-full`}
          disabled={audit.isFetchingNextPage}
          onClick={() => {
            void audit.fetchNextPage();
          }}
        >
          {t('common.loadMore')}
        </button>
      ) : null}
    </section>
  );
}
