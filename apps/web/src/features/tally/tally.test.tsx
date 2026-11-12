import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  errorBody,
  mockApi,
  renderApp,
  resetAuth,
  signInAs,
  type MockHandler,
} from '../../test-utils/auth';

const COMPANY_ID = '01930000-0000-7000-8000-0000000000c1';
const AGENT_ID = '01930000-0000-7000-8000-0000000000e1';
const OLD_AGENT_ID = '01930000-0000-7000-8000-0000000000e2';
const AS_OF = '2026-11-12T08:30:00.000Z';

function companyStatus(overrides: Record<string, unknown> = {}) {
  return {
    companyId: COMPANY_ID,
    displayName: 'Acme Meats',
    tallyName: 'Acme Meats Pvt Ltd',
    isTest: false,
    postingMode: 'DISABLED',
    lease: {
      holderAgentId: AGENT_ID,
      holderMachineName: 'TALLY-PC',
      epoch: 4,
      expiresAt: '2026-11-12T09:00:00.000Z',
      active: true,
    },
    lastHeartbeat: {
      agentId: AGENT_ID,
      at: '2026-11-12T08:59:00.000Z',
      tallyReachable: true,
      companyMatch: true,
      tallyVersion: 'TallyPrime 7.0',
      journalPending: 3,
      error: null,
    },
    watermarks: [
      { stream: 'MASTERS', lastAlterId: 120, lastSuccessAt: AS_OF, lastFullReconAt: AS_OF },
      { stream: 'VOUCHERS', lastAlterId: 5400, lastSuccessAt: AS_OF, lastFullReconAt: null },
      { stream: 'BALANCES', lastAlterId: 0, lastSuccessAt: null, lastFullReconAt: null },
    ],
    freshness: { asOf: AS_OF, stale: false, staleAfterHours: 24 },
    ...overrides,
  };
}

function company(overrides: Record<string, unknown> = {}) {
  return {
    id: COMPANY_ID,
    displayName: 'Acme Meats',
    tallyName: 'Acme Meats Pvt Ltd',
    companyNumber: '',
    booksFrom: '2026-04-01',
    tallyGuid: null,
    fingerprint: 'fp',
    isTest: true,
    postingMode: 'DISABLED',
    createdAt: '2026-11-01T08:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    companyId: COMPANY_ID,
    machineName: 'TALLY-PC',
    agentVersion: '0.1.0',
    status: 'ACTIVE',
    registeredAt: '2026-11-02T08:00:00.000Z',
    lastSeenAt: '2026-11-12T08:59:00.000Z',
    lastStatus: null,
    isLeaseHolder: true,
    ...overrides,
  };
}

function ledger(overrides: Record<string, unknown> = {}) {
  return {
    source: 'TALLY',
    asOf: AS_OF,
    id: 'l1',
    companyId: COMPANY_ID,
    guid: 'guid-l1',
    name: 'Sharma Traders',
    parentGroup: 'Sundry Debtors',
    isParty: true,
    gstin: '27ABCDE1234F1Z5',
    openingBalance: '1250.50',
    archivedInTally: false,
    ...overrides,
  };
}

function voucher(overrides: Record<string, unknown> = {}) {
  return {
    source: 'TALLY',
    asOf: AS_OF,
    id: 'v1',
    companyId: COMPANY_ID,
    guid: 'guid-v1',
    voucherTypeName: 'Sales',
    baseType: 'SALES',
    voucherNumber: 'S-101',
    voucherDate: '2026-11-10',
    reference: null,
    partyLedgerName: 'Sharma Traders',
    narration: null,
    amount: '5000.00',
    isCancelled: false,
    isDeletedInTally: false,
    erpEventId: null,
    alterId: 77,
    ...overrides,
  };
}

const none: MockHandler = () => ({ body: { data: [] } });

beforeEach(() => {
  resetAuth();
  signInAs(['dashboard.view', 'tally.connector.manage', 'tally.data.view']);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tally access control', () => {
  it('a user without dashboard.view sees "No access" and nothing is requested', () => {
    resetAuth();
    signInAs(['trip.view']);
    const calls = mockApi({});
    renderApp('/tally');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('No access');
    expect(calls).toHaveLength(0);
  });

  it('companies need tally.connector.manage, data needs tally.data.view', () => {
    resetAuth();
    signInAs(['dashboard.view']);
    const calls = mockApi({});
    const first = renderApp('/tally/companies');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('No access');
    first.unmount();
    renderApp('/tally/vouchers');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('No access');
    expect(calls).toHaveLength(0);
  });

  it('More lists only the Tally pages the user may open', () => {
    resetAuth();
    signInAs(['tally.data.view']);
    renderApp('/more');
    expect(screen.getByRole('link', { name: 'Tally ledgers' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Tally vouchers' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Tally status' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Tally companies and agents' }),
    ).not.toBeInTheDocument();
  });
});

describe('tally status', () => {
  it('shows heartbeat, lease holder, watermarks and a fresh badge', async () => {
    mockApi({ 'GET /tally/status': () => ({ body: { data: { companies: [companyStatus()] } } }) });
    renderApp('/tally');
    const card = await screen.findByRole('article', { name: 'Acme Meats' });
    expect(within(card).getByText('Up to date')).toBeInTheDocument();
    expect(within(card).queryByText('Stale')).not.toBeInTheDocument();
    expect(within(card).getByText('Posting off')).toBeInTheDocument();
    expect(within(card).getByText('TALLY-PC holds the connection (epoch 4)')).toBeInTheDocument();
    expect(within(card).getByText('Active')).toBeInTheDocument();
    expect(within(card).getByText('Tally reachable')).toBeInTheDocument();
    expect(within(card).getByText('Company matches')).toBeInTheDocument();
    expect(within(card).getByText('Version TallyPrime 7.0')).toBeInTheDocument();
    expect(within(card).getByText('3 waiting in the agent journal')).toBeInTheDocument();
    expect(within(card).getByText('Masters')).toBeInTheDocument();
    expect(within(card).getByText('Vouchers')).toBeInTheDocument();
    expect(within(card).getByText('Balances')).toBeInTheDocument();
    expect(within(card).getByText(/position 5400/)).toBeInTheDocument();
    expect(within(card).getByText(/never imported/)).toBeInTheDocument();
    expect(within(card).getByText(/Tally data as of/)).toBeInTheDocument();
  });

  it('flags stale data, a missing lease and a wrong company', async () => {
    mockApi({
      'GET /tally/status': () => ({
        body: {
          data: {
            companies: [
              companyStatus({
                isTest: true,
                postingMode: 'TEST_ONLY',
                lease: null,
                lastHeartbeat: {
                  agentId: AGENT_ID,
                  at: '2026-11-12T08:59:00.000Z',
                  tallyReachable: false,
                  companyMatch: false,
                  tallyVersion: null,
                  journalPending: 0,
                  error: 'Connection refused',
                },
                freshness: { asOf: null, stale: true, staleAfterHours: 24 },
              }),
            ],
          },
        },
      }),
    });
    renderApp('/tally');
    const card = await screen.findByRole('article', { name: 'Acme Meats' });
    expect(within(card).getByText('Stale')).toBeInTheDocument();
    expect(within(card).getByText('Test company')).toBeInTheDocument();
    expect(within(card).getByText('Posting: test only')).toBeInTheDocument();
    expect(
      within(card).getByText('Tally data has not finished its first import yet.'),
    ).toBeInTheDocument();
    expect(within(card).getByText(/older than 24 hours/)).toBeInTheDocument();
    expect(within(card).getByText('No agent holds the connection.')).toBeInTheDocument();
    expect(within(card).getByText('Tally not reachable')).toBeInTheDocument();
    expect(within(card).getByText('Wrong company open in Tally')).toBeInTheDocument();
    expect(within(card).getByRole('alert')).toHaveTextContent('Last error: Connection refused');
  });

  it('says so when there is no company, no heartbeat, and refreshes on demand', async () => {
    const u = userEvent.setup();
    let hits = 0;
    mockApi({
      'GET /tally/status': () => {
        hits += 1;
        return {
          body: {
            data: {
              companies: hits === 1 ? [] : [companyStatus({ lastHeartbeat: null, lease: null })],
            },
          },
        };
      },
    });
    renderApp('/tally');
    expect(await screen.findByText('No Tally company is set up yet.')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('No heartbeat received yet.')).toBeInTheDocument();
  });

  it('shows the error when status cannot be loaded', async () => {
    mockApi({ 'GET /tally/status': () => ({ status: 500, body: errorBody('INTERNAL', 'boom') }) });
    renderApp('/tally');
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
  });

  it('links to the pages the user may open', async () => {
    resetAuth();
    signInAs(['dashboard.view']);
    mockApi({ 'GET /tally/status': () => ({ body: { data: { companies: [] } } }) });
    renderApp('/tally');
    await screen.findByText('No Tally company is set up yet.');
    expect(screen.queryByRole('link', { name: 'Tally ledgers' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Tally companies and agents' }),
    ).not.toBeInTheDocument();
  });
});

describe('tally companies and agents', () => {
  const base: Record<string, MockHandler> = {
    'GET /tally/companies': () => ({ body: { data: [company()] } }),
    'GET /tally/agents': () => ({
      body: {
        data: [
          agent(),
          agent({
            id: OLD_AGENT_ID,
            machineName: 'OLD-PC',
            status: 'REVOKED',
            isLeaseHolder: false,
            lastSeenAt: null,
          }),
        ],
      },
    }),
  };

  it('shows the registration code once, with a copy button, and never again', async () => {
    const u = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const calls = mockApi({
      ...base,
      [`POST /tally/companies/${COMPANY_ID}/registration-code`]: () => ({
        status: 201,
        body: {
          data: {
            companyId: COMPANY_ID,
            code: 'WXYZ-2345-ABCD',
            expiresAt: '2026-11-12T12:00:00.000Z',
          },
        },
      }),
    });
    const { client } = renderApp('/tally/companies');
    const card = await screen.findByRole('listitem', { name: 'Acme Meats' });
    await u.click(within(card).getByRole('button', { name: 'Issue registration code' }));

    const region = await within(card).findByRole('region', { name: 'Registration code' });
    expect(within(region).getByTestId('registration-code')).toHaveTextContent('WXYZ-2345-ABCD');
    expect(region).toHaveTextContent('shown only once');
    expect(within(card).queryByRole('button', { name: 'Issue registration code' })).toBeNull();

    await u.click(within(region).getByRole('button', { name: 'Copy code' }));
    expect(writeText).toHaveBeenCalledWith('WXYZ-2345-ABCD');

    // Not in the query cache and not in any storage.
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain('WXYZ-2345-ABCD');
    expect(JSON.stringify(window.localStorage)).not.toContain('WXYZ-2345-ABCD');
    expect(JSON.stringify(window.sessionStorage)).not.toContain('WXYZ-2345-ABCD');

    await u.click(within(region).getByRole('button', { name: 'Done, hide code' }));
    expect(screen.queryByText('WXYZ-2345-ABCD')).not.toBeInTheDocument();
    expect(calls.filter((c) => c.path.endsWith('/registration-code'))).toHaveLength(1);
    expect(calls.filter((c) => c.path === '/tally/companies' && c.method === 'GET')).toHaveLength(
      1,
    );
  });

  it('tells the admin when the code cannot be copied', async () => {
    const u = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
      configurable: true,
    });
    mockApi({
      ...base,
      [`POST /tally/companies/${COMPANY_ID}/registration-code`]: () => ({
        status: 201,
        body: {
          data: {
            companyId: COMPANY_ID,
            code: 'WXYZ-2345-ABCD',
            expiresAt: '2026-11-12T12:00:00.000Z',
          },
        },
      }),
    });
    renderApp('/tally/companies');
    await u.click(await screen.findByRole('button', { name: 'Issue registration code' }));
    await u.click(await screen.findByRole('button', { name: 'Copy code' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not copy');
  });

  it('shows a failed code request without leaving a stale code', async () => {
    const u = userEvent.setup();
    mockApi({
      ...base,
      [`POST /tally/companies/${COMPANY_ID}/registration-code`]: () => ({
        status: 403,
        body: errorBody('FORBIDDEN', 'no'),
      }),
    });
    renderApp('/tally/companies');
    await u.click(await screen.findByRole('button', { name: 'Issue registration code' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You do not have permission');
    expect(screen.queryByTestId('registration-code')).not.toBeInTheDocument();
  });

  it('creates a company with the entered identity', async () => {
    const u = userEvent.setup();
    const calls = mockApi({
      ...base,
      'POST /tally/companies': () => ({ status: 201, body: { data: company() } }),
    });
    renderApp('/tally/companies');
    const form = await screen.findByRole('form', { name: 'Add a company' });
    const submit = within(form).getByRole('button', { name: 'Create company' });
    expect(submit).toBeDisabled();

    await u.type(within(form).getByLabelText('Display name'), ' Acme Meats ');
    await u.type(within(form).getByLabelText('Name in Tally'), 'Acme Meats Pvt Ltd');
    await u.type(within(form).getByLabelText('Books begin'), '2026-04-01');
    await u.click(within(form).getByLabelText('This is a test company'));
    expect(submit).toBeEnabled();
    await u.click(submit);

    expect(await within(form).findByText('Company created.')).toBeInTheDocument();
    const post = calls.find((c) => c.method === 'POST' && c.path === '/tally/companies');
    expect(post?.body).toEqual({
      displayName: 'Acme Meats',
      tallyName: 'Acme Meats Pvt Ltd',
      companyNumber: '',
      booksFrom: '2026-04-01',
      tallyGuid: null,
      isTest: true,
    });
    expect(post?.headers['X-CSRF-Token']).toBe('csrf-test');
    expect(within(form).getByLabelText('Display name')).toHaveValue('');
  });

  it('revokes an active agent after a confirmation, and offers nothing for a revoked one', async () => {
    const u = userEvent.setup();
    let revoked = false;
    const calls = mockApi({
      ...base,
      'GET /tally/agents': () => ({
        body: {
          data: [
            agent({ status: revoked ? 'REVOKED' : 'ACTIVE', isLeaseHolder: !revoked }),
            agent({
              id: OLD_AGENT_ID,
              machineName: 'OLD-PC',
              status: 'REVOKED',
              isLeaseHolder: false,
            }),
          ],
        },
      }),
      [`POST /tally/agents/${AGENT_ID}/revoke`]: () => {
        revoked = true;
        return { body: { data: { id: AGENT_ID, status: 'REVOKED' } } };
      },
    });
    renderApp('/tally/companies');
    const active = await screen.findByRole('listitem', { name: 'TALLY-PC' });
    const old = screen.getByRole('listitem', { name: 'OLD-PC' });
    expect(within(active).getByText('Holds the connection')).toBeInTheDocument();
    expect(within(old).queryByRole('button', { name: 'Revoke agent' })).toBeNull();

    await u.click(within(active).getByRole('button', { name: 'Revoke agent' }));
    expect(calls.filter((c) => c.path.endsWith('/revoke'))).toHaveLength(0);
    await u.click(within(active).getByRole('button', { name: 'Revoke now' }));

    await waitFor(() => {
      expect(calls.filter((c) => c.path === `/tally/agents/${AGENT_ID}/revoke`)).toHaveLength(1);
    });
    await waitFor(() => {
      expect(
        within(screen.getByRole('listitem', { name: 'TALLY-PC' })).queryByRole('button', {
          name: 'Revoke agent',
        }),
      ).toBeNull();
    });
    expect(
      within(screen.getByRole('listitem', { name: 'TALLY-PC' })).getByText('Revoked'),
    ).toBeInTheDocument();
  });

  it('says so when there are no companies or agents', async () => {
    mockApi({ 'GET /tally/companies': none, 'GET /tally/agents': none });
    renderApp('/tally/companies');
    expect(await screen.findByText('No companies yet.')).toBeInTheDocument();
    expect(await screen.findByText('No agents registered.')).toBeInTheDocument();
  });
});

describe('tally ledgers', () => {
  it('lists ledgers with source label and as-of, filters, and loads more', async () => {
    const u = userEvent.setup();
    const calls = mockApi({
      'GET /tally/ledgers': (request) => {
        const params = new URLSearchParams(request.search);
        if (params.get('cursor') === 'cursor-1') {
          return { body: { data: [ledger({ id: 'l3', name: 'Third Ledger', isParty: false })] } };
        }
        return {
          body: {
            data: [
              ledger(),
              ledger({
                id: 'l2',
                name: 'Old Debtor',
                archivedInTally: true,
                parentGroup: null,
                gstin: null,
                openingBalance: null,
              }),
            ],
            meta: { nextCursor: 'cursor-1' },
          },
        };
      },
    });
    renderApp('/tally/ledgers');
    expect(await screen.findByText('Sharma Traders')).toBeInTheDocument();
    expect(screen.getByText('Group Sundry Debtors')).toBeInTheDocument();
    expect(screen.getByText('GSTIN 27ABCDE1234F1Z5')).toBeInTheDocument();
    expect(screen.getByText(/Opening balance/)).toHaveTextContent('1,250.50');
    expect(screen.getAllByText('Source: Tally')).toHaveLength(2);
    expect(screen.getAllByText(/as of/)).toHaveLength(2);
    expect(screen.getByText('Archived')).toBeInTheDocument();
    expect(screen.getByText('Read-only copy of Tally. Changes are made in Tally.')).toBeVisible();

    await u.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Third Ledger')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();

    await u.type(screen.getByLabelText('Search ledgers'), 'sharma');
    await u.selectOptions(screen.getByLabelText('Kind'), 'true');
    await u.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => {
      const last = calls[calls.length - 1];
      expect(new URLSearchParams(last?.search).get('q')).toBe('sharma');
      expect(new URLSearchParams(last?.search).get('isParty')).toBe('true');
      expect(new URLSearchParams(last?.search).get('cursor')).toBeNull();
    });
  });

  it('says so when there are no ledgers', async () => {
    mockApi({ 'GET /tally/ledgers': none });
    renderApp('/tally/ledgers');
    expect(await screen.findByText('No ledgers found.')).toBeInTheDocument();
  });
});

describe('tally vouchers', () => {
  it('lists vouchers with flags, source label and as-of, and filters', async () => {
    const u = userEvent.setup();
    const calls = mockApi({
      'GET /tally/vouchers': () => ({
        body: {
          data: [
            voucher(),
            voucher({
              id: 'v2',
              guid: 'guid-v2',
              voucherNumber: 'S-102',
              isCancelled: true,
              isDeletedInTally: true,
            }),
          ],
        },
      }),
    });
    renderApp('/tally/vouchers');
    expect(await screen.findByText(/S-101/)).toBeInTheDocument();
    expect(screen.getAllByText('Source: Tally')).toHaveLength(2);
    expect(screen.getAllByText('₹5,000.00')).toHaveLength(2);
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    expect(screen.getByText('Deleted in Tally')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /S-101/ })).toHaveAttribute(
      'href',
      '/tally/vouchers/guid-v1',
    );

    await u.type(screen.getByLabelText('Search vouchers'), 'S-10');
    await u.selectOptions(screen.getByLabelText('Voucher type'), 'SALES');
    await u.type(screen.getByLabelText('From'), '2026-11-01');
    await u.type(screen.getByLabelText('To'), '2026-11-30');
    await u.click(screen.getByLabelText('Show vouchers deleted in Tally'));
    await u.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => {
      const last = calls[calls.length - 1];
      const params = new URLSearchParams(last?.search);
      expect(params.get('q')).toBe('S-10');
      expect(params.get('baseType')).toBe('SALES');
      expect(params.get('from')).toBe('2026-11-01');
      expect(params.get('to')).toBe('2026-11-30');
      expect(params.get('includeDeleted')).toBe('true');
    });
  });

  it('opens a voucher with its ledger and stock lines', async () => {
    mockApi({
      'GET /tally/vouchers/guid-v1': () => ({
        body: {
          data: {
            ...voucher({ reference: 'PO-9', narration: 'Weekly supply' }),
            ledgerLines: [
              {
                lineNo: 1,
                ledgerName: 'Sharma Traders',
                ledgerGuid: null,
                amount: '5000.00',
                isParty: true,
                costCentres: [],
              },
              {
                lineNo: 2,
                ledgerName: 'Sales - Meat',
                ledgerGuid: null,
                amount: '-5000.00',
                isParty: false,
                costCentres: [],
              },
            ],
            inventoryLines: [
              {
                lineNo: 1,
                stockItemName: 'Buffalo Meat',
                stockItemGuid: null,
                qty: '25.000',
                uom: 'kg',
                rate: '200.0000',
                amount: '5000.00',
                batchName: null,
                godown: null,
              },
            ],
          },
        },
      }),
    });
    renderApp('/tally/vouchers/guid-v1');
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Sales No. S-101');
    expect(screen.getByText('Reference PO-9')).toBeInTheDocument();
    expect(screen.getByText('Weekly supply')).toBeInTheDocument();
    expect(screen.getByText('Source: Tally')).toBeInTheDocument();
    expect(screen.getByText('Sales - Meat')).toBeInTheDocument();
    expect(screen.getByText('Buffalo Meat')).toBeInTheDocument();
    expect(screen.getByText('25.000 kg @ 200.0000')).toBeInTheDocument();
  });

  it('shows not found for an unknown voucher', async () => {
    mockApi({
      'GET /tally/vouchers/missing': () => ({ status: 404, body: errorBody('NOT_FOUND', 'x') }),
    });
    renderApp('/tally/vouchers/missing');
    expect(await screen.findByRole('alert')).toHaveTextContent('Not found.');
  });

  it('says so when there are no vouchers', async () => {
    mockApi({ 'GET /tally/vouchers': none });
    renderApp('/tally/vouchers');
    expect(await screen.findByText('No vouchers found.')).toBeInTheDocument();
  });
});
