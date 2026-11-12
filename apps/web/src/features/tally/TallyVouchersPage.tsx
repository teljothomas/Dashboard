import { useInfiniteQuery } from '@tanstack/react-query';
import { VOUCHER_BASE_TYPES, type TallyVoucherDto } from '@tradex/contracts';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  Badge,
  FormError,
  InfoNote,
  inputClass,
  secondaryButtonClass,
  TextField,
} from '../../components/ui/form';
import { t } from '../../lib/i18n';
import { formatMoney } from '../../lib/money';
import { MirrorSource } from './MirrorSource';
import { listTallyVouchers, tallyKeys, type VoucherFilter } from './tallyApi';
import { tallyErrorMessage } from './tallyErrors';

const EMPTY_FILTER: VoucherFilter = {
  q: '',
  baseType: '',
  from: '',
  to: '',
  includeDeleted: false,
};

export function VoucherFlags({ voucher }: { voucher: TallyVoucherDto }) {
  if (!voucher.isCancelled && !voucher.isDeletedInTally) return null;
  return (
    <span className="flex shrink-0 gap-1">
      {voucher.isCancelled ? <Badge tone="amber">{t('tally.vouchers.cancelled')}</Badge> : null}
      {voucher.isDeletedInTally ? <Badge tone="red">{t('tally.vouchers.deleted')}</Badge> : null}
    </span>
  );
}

/** Read-only browse of the Tally voucher mirror. */
export function TallyVouchersPage() {
  const [form, setForm] = useState<VoucherFilter>(EMPTY_FILTER);
  const [applied, setApplied] = useState<VoucherFilter>(EMPTY_FILTER);

  const vouchers = useInfiniteQuery({
    queryKey: tallyKeys.vouchers(applied),
    queryFn: ({ pageParam }) => listTallyVouchers(applied, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.meta?.nextCursor,
  });

  function onSearch(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setApplied({ ...form, q: form.q.trim() });
  }

  const rows = vouchers.data?.pages.flatMap((page) => page.data) ?? [];

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">{t('tally.vouchers.title')}</h1>
      <p>
        <Link to="/tally" className="inline-block min-h-11 py-3 text-sky-700 underline">
          {t('tally.status.title')}
        </Link>
      </p>
      <InfoNote>{t('tally.data.readOnly')}</InfoNote>

      <form onSubmit={onSearch} role="search" className="space-y-3">
        <TextField
          label={t('tally.vouchers.search')}
          name="q"
          type="search"
          value={form.q}
          onChange={(e) => {
            setForm({ ...form, q: e.target.value });
          }}
        />
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-800" htmlFor="voucher-type">
            {t('tally.vouchers.type')}
          </label>
          <select
            id="voucher-type"
            className={inputClass}
            value={form.baseType}
            onChange={(e) => {
              setForm({ ...form, baseType: e.target.value as VoucherFilter['baseType'] });
            }}
          >
            <option value="">{t('common.all')}</option>
            {VOUCHER_BASE_TYPES.map((value) => (
              <option key={value} value={value}>
                {t(`tally.vouchers.baseType.${value}`)}
              </option>
            ))}
          </select>
        </div>
        <TextField
          label={t('tally.vouchers.from')}
          name="from"
          type="date"
          value={form.from}
          onChange={(e) => {
            setForm({ ...form, from: e.target.value });
          }}
        />
        <TextField
          label={t('tally.vouchers.to')}
          name="to"
          type="date"
          value={form.to}
          onChange={(e) => {
            setForm({ ...form, to: e.target.value });
          }}
        />
        <label className="flex min-h-11 items-center gap-3 text-base text-slate-900">
          <input
            type="checkbox"
            className="size-5"
            checked={form.includeDeleted}
            onChange={(e) => {
              setForm({ ...form, includeDeleted: e.target.checked });
            }}
          />
          {t('tally.vouchers.includeDeleted')}
        </label>
        <button type="submit" className={secondaryButtonClass}>
          {t('common.search')}
        </button>
      </form>

      {vouchers.isPending ? <p className="text-slate-600">{t('common.loading')}</p> : null}
      {vouchers.isError ? <FormError message={tallyErrorMessage(vouchers.error)} /> : null}
      {vouchers.isSuccess && rows.length === 0 ? (
        <p className="text-slate-600">{t('tally.vouchers.empty')}</p>
      ) : null}

      <ul className="space-y-2">
        {rows.map((voucher) => (
          <li key={voucher.id}>
            <Link
              to={`/tally/vouchers/${encodeURIComponent(voucher.guid)}`}
              className="block space-y-1 rounded-md border border-slate-200 bg-white p-3 text-sm"
            >
              <span className="flex items-center justify-between gap-2">
                <span className="font-medium break-words">
                  {voucher.voucherTypeName}{' '}
                  {t('tally.vouchers.number', { number: voucher.voucherNumber })}
                </span>
                <VoucherFlags voucher={voucher} />
              </span>
              <span className="flex justify-between gap-2 text-slate-700">
                <span>{voucher.voucherDate}</span>
                <span className="font-medium">{formatMoney(voucher.amount)}</span>
              </span>
              {voucher.partyLedgerName === null ? null : (
                <span className="block break-words text-slate-600">
                  {t('tally.vouchers.party', { party: voucher.partyLedgerName })}
                </span>
              )}
              <MirrorSource asOf={voucher.asOf} />
            </Link>
          </li>
        ))}
      </ul>

      {vouchers.hasNextPage ? (
        <button
          type="button"
          className={`${secondaryButtonClass} w-full`}
          disabled={vouchers.isFetchingNextPage}
          onClick={() => {
            void vouchers.fetchNextPage();
          }}
        >
          {t('common.loadMore')}
        </button>
      ) : null}
    </section>
  );
}
