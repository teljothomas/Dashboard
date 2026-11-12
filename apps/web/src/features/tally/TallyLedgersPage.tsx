import { useInfiniteQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  Badge,
  FormError,
  InfoNote,
  inputClass,
  secondaryButtonClass,
} from '../../components/ui/form';
import { t } from '../../lib/i18n';
import { formatMoney } from '../../lib/money';
import { MirrorSource } from './MirrorSource';
import { listTallyLedgers, tallyKeys, type LedgerFilter } from './tallyApi';
import { tallyErrorMessage } from './tallyErrors';

/** Read-only browse of the Tally ledger mirror. */
export function TallyLedgersPage() {
  const [q, setQ] = useState('');
  const [isParty, setIsParty] = useState<LedgerFilter['isParty']>('');
  const [applied, setApplied] = useState<LedgerFilter>({ q: '', isParty: '' });

  const ledgers = useInfiniteQuery({
    queryKey: tallyKeys.ledgers(applied),
    queryFn: ({ pageParam }) => listTallyLedgers(applied, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.meta?.nextCursor,
  });

  function onSearch(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setApplied({ q: q.trim(), isParty });
  }

  const rows = ledgers.data?.pages.flatMap((page) => page.data) ?? [];

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">{t('tally.ledgers.title')}</h1>
      <p>
        <Link to="/tally" className="inline-block min-h-11 py-3 text-sky-700 underline">
          {t('tally.status.title')}
        </Link>
      </p>
      <InfoNote>{t('tally.data.readOnly')}</InfoNote>

      <form onSubmit={onSearch} role="search" className="space-y-2">
        <label className="block text-sm font-medium text-slate-800" htmlFor="ledger-search">
          {t('tally.ledgers.search')}
        </label>
        <input
          id="ledger-search"
          type="search"
          className={inputClass}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
          }}
        />
        <label className="block text-sm font-medium text-slate-800" htmlFor="ledger-kind">
          {t('tally.ledgers.kind')}
        </label>
        <select
          id="ledger-kind"
          className={inputClass}
          value={isParty}
          onChange={(e) => {
            setIsParty(e.target.value as LedgerFilter['isParty']);
          }}
        >
          <option value="">{t('common.all')}</option>
          <option value="true">{t('tally.ledgers.kind.true')}</option>
          <option value="false">{t('tally.ledgers.kind.false')}</option>
        </select>
        <button type="submit" className={secondaryButtonClass}>
          {t('common.search')}
        </button>
      </form>

      {ledgers.isPending ? <p className="text-slate-600">{t('common.loading')}</p> : null}
      {ledgers.isError ? <FormError message={tallyErrorMessage(ledgers.error)} /> : null}
      {ledgers.isSuccess && rows.length === 0 ? (
        <p className="text-slate-600">{t('tally.ledgers.empty')}</p>
      ) : null}

      <ul className="space-y-2">
        {rows.map((ledger) => (
          <li
            key={ledger.id}
            className="space-y-1 rounded-md border border-slate-200 bg-white p-3 text-sm"
          >
            <p className="flex items-center justify-between gap-2">
              <span className="font-medium break-words">{ledger.name}</span>
              <span className="flex shrink-0 gap-1">
                {ledger.isParty ? <Badge tone="green">{t('tally.ledgers.party')}</Badge> : null}
                {ledger.archivedInTally ? (
                  <Badge tone="amber">{t('tally.ledgers.archived')}</Badge>
                ) : null}
              </span>
            </p>
            {ledger.parentGroup === null ? null : (
              <p className="text-slate-600">
                {t('tally.ledgers.group', { group: ledger.parentGroup })}
              </p>
            )}
            {ledger.gstin === null ? null : (
              <p className="text-slate-600">{t('tally.ledgers.gstin', { gstin: ledger.gstin })}</p>
            )}
            {ledger.openingBalance === null ? null : (
              <p className="text-slate-600">
                {t('tally.ledgers.opening', { amount: formatMoney(ledger.openingBalance) })}
              </p>
            )}
            <MirrorSource asOf={ledger.asOf} />
          </li>
        ))}
      </ul>

      {ledgers.hasNextPage ? (
        <button
          type="button"
          className={`${secondaryButtonClass} w-full`}
          disabled={ledgers.isFetchingNextPage}
          onClick={() => {
            void ledgers.fetchNextPage();
          }}
        >
          {t('common.loadMore')}
        </button>
      ) : null}
    </section>
  );
}
