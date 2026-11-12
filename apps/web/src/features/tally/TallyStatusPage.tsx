import { useQuery } from '@tanstack/react-query';
import type { TallyCompanyStatusDto } from '@tradex/contracts';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Badge, FormError, InfoNote, secondaryButtonClass } from '../../components/ui/form';
import { formatDateTime } from '../../lib/datetime';
import { t } from '../../lib/i18n';
import { useCan } from '../auth/authStore';
import { getTallyStatus, tallyKeys } from './tallyApi';
import { tallyErrorMessage } from './tallyErrors';

const linkClass =
  'flex min-h-11 items-center rounded-md border border-slate-200 bg-white px-4 text-base text-slate-900';

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
      {children}
    </div>
  );
}

/** Connection health of the Tally connector: heartbeat, lease holder, import progress, freshness. */
export function TallyStatusPage() {
  const canManage = useCan('tally.connector.manage');
  const canView = useCan('tally.data.view');
  const status = useQuery({ queryKey: tallyKeys.status, queryFn: getTallyStatus });

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('tally.status.title')}</h1>
        <button
          type="button"
          className={secondaryButtonClass}
          disabled={status.isFetching}
          onClick={() => {
            void status.refetch();
          }}
        >
          {t('tally.status.refresh')}
        </button>
      </div>

      {canManage || canView ? (
        <ul className="space-y-2">
          {canManage ? (
            <li>
              <Link to="/tally/companies" className={linkClass}>
                {t('tally.link.companies')}
              </Link>
            </li>
          ) : null}
          {canView ? (
            <>
              <li>
                <Link to="/tally/ledgers" className={linkClass}>
                  {t('tally.link.ledgers')}
                </Link>
              </li>
              <li>
                <Link to="/tally/vouchers" className={linkClass}>
                  {t('tally.link.vouchers')}
                </Link>
              </li>
            </>
          ) : null}
        </ul>
      ) : null}

      {status.isPending ? <p className="text-slate-600">{t('common.loading')}</p> : null}
      {status.isError ? <FormError message={tallyErrorMessage(status.error)} /> : null}
      {status.isSuccess && status.data.companies.length === 0 ? (
        <p className="text-slate-600">{t('tally.status.empty')}</p>
      ) : null}

      {(status.data?.companies ?? []).map((company) => (
        <CompanyStatus key={company.companyId} company={company} />
      ))}
    </section>
  );
}

function CompanyStatus({ company }: { company: TallyCompanyStatusDto }) {
  const { lease, lastHeartbeat, watermarks, freshness } = company;
  return (
    <article
      aria-label={company.displayName}
      className="space-y-4 rounded-md border border-slate-200 bg-white p-4"
    >
      <div className="space-y-1">
        <h2 className="text-base font-semibold break-words">{company.displayName}</h2>
        <p className="text-sm break-words text-slate-600">{company.tallyName}</p>
        <p className="flex flex-wrap gap-2">
          <Badge tone={freshness.stale ? 'amber' : 'green'}>
            {freshness.stale ? t('tally.status.stale') : t('tally.status.fresh')}
          </Badge>
          <Badge tone="slate">{t(`tally.status.postingMode.${company.postingMode}`)}</Badge>
          {company.isTest ? <Badge tone="slate">{t('tally.status.testCompany')}</Badge> : null}
        </p>
      </div>

      <div className="space-y-1">
        {freshness.asOf === null ? (
          <p className="text-sm text-slate-700">{t('tally.status.neverSynced')}</p>
        ) : (
          <p className="text-sm text-slate-700">
            {t('tally.status.asOf', { when: formatDateTime(freshness.asOf) })}
          </p>
        )}
        {freshness.stale ? (
          <InfoNote>
            {t('tally.status.staleWarning', { hours: freshness.staleAfterHours })}
          </InfoNote>
        ) : null}
      </div>

      <Block title={t('tally.status.lease')}>
        {lease === null ? (
          <p className="text-sm text-slate-600">{t('tally.status.noLease')}</p>
        ) : (
          <>
            <p className="text-sm break-words">
              {t('tally.status.leaseHolder', {
                machine: lease.holderMachineName,
                epoch: lease.epoch,
              })}
            </p>
            <p className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
              <Badge tone={lease.active ? 'green' : 'amber'}>
                {lease.active ? t('tally.status.leaseActive') : t('tally.status.leaseExpired')}
              </Badge>
              {t('tally.status.leaseExpires', { when: formatDateTime(lease.expiresAt) })}
            </p>
          </>
        )}
      </Block>

      <Block title={t('tally.status.heartbeat')}>
        {lastHeartbeat === null ? (
          <p className="text-sm text-slate-600">{t('tally.status.noHeartbeat')}</p>
        ) : (
          <>
            <p className="text-sm text-slate-700">{formatDateTime(lastHeartbeat.at)}</p>
            <p className="flex flex-wrap gap-2">
              <Badge tone={lastHeartbeat.tallyReachable ? 'green' : 'red'}>
                {lastHeartbeat.tallyReachable
                  ? t('tally.status.reachable')
                  : t('tally.status.unreachable')}
              </Badge>
              <Badge tone={lastHeartbeat.companyMatch ? 'green' : 'red'}>
                {lastHeartbeat.companyMatch
                  ? t('tally.status.companyMatch')
                  : t('tally.status.companyMismatch')}
              </Badge>
            </p>
            {lastHeartbeat.tallyVersion === null ? null : (
              <p className="text-sm text-slate-600">
                {t('tally.status.tallyVersion', { version: lastHeartbeat.tallyVersion })}
              </p>
            )}
            <p className="text-sm text-slate-600">
              {t('tally.status.journalPending', { count: lastHeartbeat.journalPending })}
            </p>
            {lastHeartbeat.error === null ? null : (
              <FormError message={t('tally.status.lastError', { error: lastHeartbeat.error })} />
            )}
          </>
        )}
      </Block>

      <Block title={t('tally.status.watermarks')}>
        <ul className="space-y-2">
          {watermarks.map((mark) => (
            <li key={mark.stream} className="rounded-md border border-slate-200 p-3 text-sm">
              <p className="font-medium">{t(`tally.status.stream.${mark.stream}`)}</p>
              <p className="text-slate-600">
                {t('tally.status.position', { id: mark.lastAlterId })} ·{' '}
                {mark.lastSuccessAt === null
                  ? t('tally.status.neverImported')
                  : t('tally.status.lastSuccess', { when: formatDateTime(mark.lastSuccessAt) })}
              </p>
              <p className="text-slate-600">
                {mark.lastFullReconAt === null
                  ? t('tally.status.neverRecon')
                  : t('tally.status.lastFullRecon', { when: formatDateTime(mark.lastFullReconAt) })}
              </p>
            </li>
          ))}
        </ul>
      </Block>
    </article>
  );
}
