import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConnectorAgentDto, TallyCompanyDto } from '@tradex/contracts';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { ConfirmAction } from '../../components/ui/ConfirmAction';
import {
  Badge,
  FormError,
  InfoNote,
  primaryButtonClass,
  secondaryButtonClass,
  TextField,
} from '../../components/ui/form';
import { formatDateTime } from '../../lib/datetime';
import { t } from '../../lib/i18n';
import {
  createTallyCompany,
  issueRegistrationCode,
  listConnectorAgents,
  listTallyCompanies,
  revokeConnectorAgent,
  tallyKeys,
} from './tallyApi';
import { tallyErrorMessage } from './tallyErrors';

interface IssuedCode {
  companyId: string;
  code: string;
  expiresAt: string;
}

/** Companies, one-time registration codes and agents. Administration only (tally.connector.manage). */
export function TallyCompaniesPage() {
  // The code lives in component state only: shown once, never cached or stored.
  const [issued, setIssued] = useState<IssuedCode | undefined>();
  const companies = useQuery({ queryKey: tallyKeys.companies, queryFn: listTallyCompanies });

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">{t('tally.companies.title')}</h1>
      <p>
        <Link to="/tally" className="inline-block min-h-11 py-3 text-sky-700 underline">
          {t('tally.status.title')}
        </Link>
      </p>

      {companies.isPending ? <p className="text-slate-600">{t('common.loading')}</p> : null}
      {companies.isError ? <FormError message={tallyErrorMessage(companies.error)} /> : null}
      {companies.isSuccess && companies.data.length === 0 ? (
        <p className="text-slate-600">{t('tally.companies.empty')}</p>
      ) : null}

      <ul className="space-y-3">
        {(companies.data ?? []).map((company) => (
          <CompanyCard
            key={company.id}
            company={company}
            issued={issued?.companyId === company.id ? issued : undefined}
            onIssued={setIssued}
            onHide={() => {
              setIssued(undefined);
            }}
          />
        ))}
      </ul>

      <CreateCompanyForm />
      <AgentsSection />
    </section>
  );
}

function CompanyCard({
  company,
  issued,
  onIssued,
  onHide,
}: {
  company: TallyCompanyDto;
  issued: IssuedCode | undefined;
  onIssued: (code: IssuedCode) => void;
  onHide: () => void;
}) {
  const [copyFailed, setCopyFailed] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<string | undefined>();

  async function onIssue(): Promise<void> {
    setIssuing(true);
    setIssueError(undefined);
    setCopyFailed(false);
    try {
      onIssued(await issueRegistrationCode(company.id));
    } catch (err) {
      setIssueError(tallyErrorMessage(err));
    } finally {
      setIssuing(false);
    }
  }

  async function onCopy(): Promise<void> {
    if (issued === undefined) return;
    try {
      await navigator.clipboard.writeText(issued.code);
      setCopyFailed(false);
    } catch {
      setCopyFailed(true);
    }
  }

  return (
    <li
      aria-label={company.displayName}
      className="space-y-3 rounded-md border border-slate-200 bg-white p-4"
    >
      <div className="space-y-1">
        <p className="flex items-center justify-between gap-2">
          <span className="font-medium break-words">{company.displayName}</span>
          {company.isTest ? <Badge tone="slate">{t('tally.status.testCompany')}</Badge> : null}
        </p>
        <p className="text-sm break-words text-slate-600">{company.tallyName}</p>
        <p className="text-sm text-slate-600">
          {t('tally.companies.booksFromOn', { date: company.booksFrom })}
        </p>
      </div>

      {issued === undefined ? (
        <>
          <FormError message={issueError} />
          <button
            type="button"
            className={secondaryButtonClass}
            disabled={issuing}
            onClick={() => {
              void onIssue();
            }}
          >
            {t('tally.companies.issueCode')}
          </button>
        </>
      ) : (
        <div role="region" aria-label={t('tally.companies.codeLabel')} className="space-y-3">
          <p className="text-sm text-slate-700">{t('tally.companies.codeShownOnce')}</p>
          <p
            data-testid="registration-code"
            className="rounded-md bg-slate-100 px-3 py-3 text-center font-mono text-xl tracking-widest break-all select-all"
          >
            {issued.code}
          </p>
          <p className="text-sm text-slate-600">
            {t('tally.companies.codeExpires', { when: formatDateTime(issued.expiresAt) })}
          </p>
          {copyFailed ? <FormError message={t('tally.companies.copyFailed')} /> : null}
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              className={primaryButtonClass}
              onClick={() => {
                void onCopy();
              }}
            >
              {t('tally.companies.copy')}
            </button>
            <button
              type="button"
              className={secondaryButtonClass}
              onClick={() => {
                setCopyFailed(false);
                onHide();
              }}
            >
              {t('tally.companies.codeDone')}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function CreateCompanyForm() {
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState('');
  const [tallyName, setTallyName] = useState('');
  const [companyNumber, setCompanyNumber] = useState('');
  const [booksFrom, setBooksFrom] = useState('');
  const [tallyGuid, setTallyGuid] = useState('');
  const [isTest, setIsTest] = useState(false);

  const create = useMutation({
    mutationFn: () =>
      createTallyCompany({
        displayName: displayName.trim(),
        tallyName: tallyName.trim(),
        companyNumber: companyNumber.trim(),
        booksFrom,
        tallyGuid: tallyGuid.trim() === '' ? null : tallyGuid.trim(),
        isTest,
      }),
    onSuccess: async () => {
      setDisplayName('');
      setTallyName('');
      setCompanyNumber('');
      setBooksFrom('');
      setTallyGuid('');
      setIsTest(false);
      await queryClient.invalidateQueries({ queryKey: tallyKeys.companies });
      await queryClient.invalidateQueries({ queryKey: tallyKeys.status });
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!create.isPending) create.mutate();
  }

  const incomplete = displayName.trim() === '' || tallyName.trim() === '' || booksFrom === '';

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      aria-label={t('tally.companies.add')}
      className="space-y-4 rounded-md border border-slate-200 bg-white p-4"
    >
      <h2 className="text-base font-semibold">{t('tally.companies.add')}</h2>
      <TextField
        label={t('tally.companies.displayName')}
        name="displayName"
        required
        value={displayName}
        onChange={(e) => {
          setDisplayName(e.target.value);
        }}
      />
      <TextField
        label={t('tally.companies.tallyName')}
        hint={t('tally.companies.tallyNameHint')}
        name="tallyName"
        required
        value={tallyName}
        onChange={(e) => {
          setTallyName(e.target.value);
        }}
      />
      <TextField
        label={t('tally.companies.companyNumber')}
        name="companyNumber"
        value={companyNumber}
        onChange={(e) => {
          setCompanyNumber(e.target.value);
        }}
      />
      <TextField
        label={t('tally.companies.booksFrom')}
        name="booksFrom"
        type="date"
        required
        value={booksFrom}
        onChange={(e) => {
          setBooksFrom(e.target.value);
        }}
      />
      <TextField
        label={t('tally.companies.tallyGuid')}
        name="tallyGuid"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        value={tallyGuid}
        onChange={(e) => {
          setTallyGuid(e.target.value);
        }}
      />
      <label className="flex min-h-11 items-center gap-3 text-base text-slate-900">
        <input
          type="checkbox"
          className="size-5"
          checked={isTest}
          onChange={(e) => {
            setIsTest(e.target.checked);
          }}
        />
        {t('tally.companies.isTest')}
      </label>
      {create.isError ? <FormError message={tallyErrorMessage(create.error)} /> : null}
      {create.isSuccess ? <InfoNote>{t('tally.companies.created')}</InfoNote> : null}
      <button
        type="submit"
        className={primaryButtonClass}
        disabled={create.isPending || incomplete}
      >
        {t('tally.companies.create')}
      </button>
    </form>
  );
}

function AgentsSection() {
  const queryClient = useQueryClient();
  const agents = useQuery({ queryKey: tallyKeys.agents, queryFn: listConnectorAgents });
  const revoke = useMutation({
    mutationFn: (id: string) => revokeConnectorAgent(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: tallyKeys.agents });
      await queryClient.invalidateQueries({ queryKey: tallyKeys.status });
    },
  });
  const error = revoke.error ?? agents.error;

  return (
    <section className="space-y-3 rounded-md border border-slate-200 bg-white p-4">
      <h2 className="text-base font-semibold">{t('tally.agents.title')}</h2>
      {agents.isPending ? <p className="text-slate-600">{t('common.loading')}</p> : null}
      {error === null ? null : <FormError message={tallyErrorMessage(error)} />}
      {agents.isSuccess && agents.data.length === 0 ? (
        <p className="text-sm text-slate-600">{t('tally.agents.none')}</p>
      ) : null}
      <ul className="space-y-2">
        {(agents.data ?? []).map((agent) => (
          <AgentRow
            key={agent.id}
            agent={agent}
            busy={revoke.isPending}
            onRevoke={() => {
              revoke.mutate(agent.id);
            }}
          />
        ))}
      </ul>
    </section>
  );
}

function AgentRow({
  agent,
  busy,
  onRevoke,
}: {
  agent: ConnectorAgentDto;
  busy: boolean;
  onRevoke: () => void;
}) {
  return (
    <li
      aria-label={agent.machineName}
      className="space-y-2 rounded-md border border-slate-200 p-3 text-sm"
    >
      <p className="flex items-center justify-between gap-2">
        <span className="font-medium break-all">{agent.machineName}</span>
        <Badge tone={agent.status === 'ACTIVE' ? 'green' : 'red'}>
          {t(`tally.agents.status.${agent.status}`)}
        </Badge>
      </p>
      {agent.isLeaseHolder ? <Badge tone="green">{t('tally.agents.leaseHolder')}</Badge> : null}
      <p className="text-slate-600">
        {t('tally.agents.version', { version: agent.agentVersion })} ·{' '}
        {agent.lastSeenAt === null
          ? t('tally.agents.neverSeen')
          : t('tally.agents.lastSeen', { when: formatDateTime(agent.lastSeenAt) })}
      </p>
      <p className="text-slate-600">
        {t('tally.agents.registered', { when: formatDateTime(agent.registeredAt) })}
      </p>
      {agent.status === 'ACTIVE' ? (
        <ConfirmAction
          label={t('tally.agents.revoke')}
          warning={t('tally.agents.revokeWarning')}
          confirmLabel={t('tally.agents.revokeConfirm')}
          disabled={busy}
          onConfirm={onRevoke}
        />
      ) : null}
    </li>
  );
}
