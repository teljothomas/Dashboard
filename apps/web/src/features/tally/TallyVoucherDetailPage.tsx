import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { FormError, InfoNote } from '../../components/ui/form';
import { t } from '../../lib/i18n';
import { formatMoney } from '../../lib/money';
import { MirrorSource } from './MirrorSource';
import { getTallyVoucher, tallyKeys } from './tallyApi';
import { tallyErrorMessage } from './tallyErrors';
import { VoucherFlags } from './TallyVouchersPage';

/** One mirrored voucher with its ledger and stock lines. Read-only. */
export function TallyVoucherDetailPage() {
  const { guid = '' } = useParams();
  const voucher = useQuery({
    queryKey: tallyKeys.voucher(guid),
    queryFn: () => getTallyVoucher(guid),
    enabled: guid !== '',
  });
  const data = voucher.data;

  return (
    <section className="space-y-4">
      <p>
        <Link to="/tally/vouchers" className="inline-block min-h-11 py-3 text-sky-700 underline">
          {t('tally.vouchers.back')}
        </Link>
      </p>
      {voucher.isPending ? <p className="text-slate-600">{t('common.loading')}</p> : null}
      {voucher.isError ? <FormError message={tallyErrorMessage(voucher.error)} /> : null}
      {data === undefined ? null : (
        <>
          <div className="space-y-1">
            <h1 className="text-xl font-semibold break-words">
              {data.voucherTypeName} {t('tally.vouchers.number', { number: data.voucherNumber })}
            </h1>
            <p className="flex items-center gap-2 text-sm text-slate-700">
              <span>{data.voucherDate}</span>
              <span className="font-medium">{formatMoney(data.amount)}</span>
              <VoucherFlags voucher={data} />
            </p>
            {data.partyLedgerName === null ? null : (
              <p className="text-sm break-words text-slate-600">
                {t('tally.vouchers.party', { party: data.partyLedgerName })}
              </p>
            )}
            {data.reference === null ? null : (
              <p className="text-sm break-words text-slate-600">
                {t('tally.vouchers.reference', { reference: data.reference })}
              </p>
            )}
            {data.narration === null ? null : (
              <p className="text-sm break-words text-slate-700">{data.narration}</p>
            )}
            <MirrorSource asOf={data.asOf} />
          </div>
          <InfoNote>{t('tally.data.readOnly')}</InfoNote>

          <section className="space-y-2 rounded-md border border-slate-200 bg-white p-4">
            <h2 className="text-base font-semibold">{t('tally.vouchers.ledgerLines')}</h2>
            {data.ledgerLines.length === 0 ? (
              <p className="text-sm text-slate-600">{t('tally.vouchers.noLines')}</p>
            ) : null}
            <ul className="space-y-2">
              {data.ledgerLines.map((line) => (
                <li
                  key={line.lineNo}
                  className="flex justify-between gap-2 rounded-md border border-slate-200 p-3 text-sm"
                >
                  <span className="break-words">{line.ledgerName}</span>
                  <span className="shrink-0 font-medium">{formatMoney(line.amount)}</span>
                </li>
              ))}
            </ul>
          </section>

          {data.inventoryLines.length === 0 ? null : (
            <section className="space-y-2 rounded-md border border-slate-200 bg-white p-4">
              <h2 className="text-base font-semibold">{t('tally.vouchers.inventoryLines')}</h2>
              <ul className="space-y-2">
                {data.inventoryLines.map((line) => (
                  <li
                    key={line.lineNo}
                    className="space-y-1 rounded-md border border-slate-200 p-3 text-sm"
                  >
                    <p className="flex justify-between gap-2">
                      <span className="break-words">{line.stockItemName}</span>
                      <span className="shrink-0 font-medium">{formatMoney(line.amount)}</span>
                    </p>
                    <p className="text-slate-600">
                      {line.qty}
                      {line.uom === null ? '' : ` ${line.uom}`}
                      {line.rate === null ? '' : ` @ ${line.rate}`}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </section>
  );
}
