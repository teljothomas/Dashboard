import type { Page, Route } from '@playwright/test';

/**
 * In-browser stand-in for the API (Playwright `page.route`). The e2e run serves the built web app
 * only; the real API needs a database. It enforces what the browser must do: cookie-less session
 * state here, but the CSRF header on every mutation and the generic 401 shape.
 */

export const OWNER_ID = '01930000-0000-7000-8000-0000000000a1';
export const CSRF = 'csrf-e2e-token';
export const PASSWORD = 'correct horse battery';

export const OWNER = {
  user: {
    id: OWNER_ID,
    username: 'owner1',
    displayName: 'Olivia Owner',
    mustChangePassword: false,
  },
  roles: ['OWNER'],
  permissions: [
    'users.manage',
    'roles.manage',
    'audit.view',
    'trip.view',
    'expense.view',
    'dashboard.view',
    'tally.connector.manage',
    'tally.data.view',
  ].map((permission) => ({ permission, scope: 'ALL', divisionId: null })),
  csrfToken: CSRF,
};

export const TALLY_COMPANY_ID = '01930000-0000-7000-8000-0000000000c1';
export const REGISTRATION_CODE = 'WXYZ-2345-ABCD';

const TALLY_STATUS = {
  companyId: TALLY_COMPANY_ID,
  displayName: 'Acme Meats',
  tallyName: 'Acme Meats Pvt Ltd With A Fairly Long Registered Company Name',
  isTest: true,
  postingMode: 'DISABLED',
  lease: {
    holderAgentId: '01930000-0000-7000-8000-0000000000e1',
    holderMachineName: 'TALLY-PC',
    epoch: 4,
    expiresAt: '2030-01-01T00:05:00.000Z',
    active: true,
  },
  lastHeartbeat: {
    agentId: '01930000-0000-7000-8000-0000000000e1',
    at: '2030-01-01T00:00:00.000Z',
    tallyReachable: true,
    companyMatch: true,
    tallyVersion: 'TallyPrime 7.0',
    journalPending: 0,
    error: null,
  },
  watermarks: [
    {
      stream: 'VOUCHERS',
      lastAlterId: 5400,
      lastSuccessAt: '2030-01-01T00:00:00.000Z',
      lastFullReconAt: null,
    },
  ],
  freshness: { asOf: '2030-01-01T00:00:00.000Z', stale: true, staleAfterHours: 24 },
};

const TALLY_COMPANY = {
  id: TALLY_COMPANY_ID,
  displayName: 'Acme Meats',
  tallyName: 'Acme Meats Pvt Ltd With A Fairly Long Registered Company Name',
  companyNumber: '',
  booksFrom: '2026-04-01',
  tallyGuid: null,
  fingerprint: 'fp',
  isTest: true,
  postingMode: 'DISABLED',
  createdAt: '2026-11-01T08:00:00.000Z',
  version: 1,
};

const TALLY_AGENT = {
  id: '01930000-0000-7000-8000-0000000000e1',
  companyId: TALLY_COMPANY_ID,
  machineName: 'TALLY-PC',
  agentVersion: '0.1.0',
  status: 'ACTIVE',
  registeredAt: '2026-11-02T08:00:00.000Z',
  lastSeenAt: '2030-01-01T00:00:00.000Z',
  lastStatus: null,
  isLeaseHolder: true,
};

const TALLY_LEDGER = {
  source: 'TALLY',
  asOf: '2030-01-01T00:00:00.000Z',
  id: 'l1',
  companyId: TALLY_COMPANY_ID,
  guid: 'guid-l1',
  name: 'Sharma Traders And Sons Wholesale Meat Suppliers Limited',
  parentGroup: 'Sundry Debtors',
  isParty: true,
  gstin: '27ABCDE1234F1Z5',
  openingBalance: '1250.50',
  archivedInTally: false,
};

const TALLY_VOUCHER = {
  source: 'TALLY',
  asOf: '2030-01-01T00:00:00.000Z',
  id: 'v1',
  companyId: TALLY_COMPANY_ID,
  guid: 'guid-v1',
  voucherTypeName: 'Sales',
  baseType: 'SALES',
  voucherNumber: 'S-101',
  voucherDate: '2026-11-10',
  reference: null,
  partyLedgerName: 'Sharma Traders And Sons Wholesale Meat Suppliers Limited',
  narration: null,
  amount: '5000.00',
  isCancelled: false,
  isDeletedInTally: false,
  erpEventId: null,
  alterId: 77,
};

export interface FakeApi {
  readonly requests: string[];
  /** How many registration codes the fake has issued. */
  registrationCodesIssued: () => number;
  readonly csrfFailures: string[];
  signedIn: () => boolean;
  /** The next sign-in answers with this user instead of the owner. */
  setNextUser: (user: typeof OWNER) => void;
}

function json(route: Route, status: number, body: unknown): Promise<void> {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

function unauthenticated(route: Route): Promise<void> {
  return json(route, 401, {
    error: { code: 'UNAUTHENTICATED', message: 'Authentication required', requestId: 'e2e' },
  });
}

export async function installFakeApi(
  page: Page,
  options: { signedIn?: boolean } = {},
): Promise<FakeApi> {
  let signedIn = options.signedIn ?? false;
  let current = OWNER;
  const requests: string[] = [];
  const csrfFailures: string[] = [];
  let registrationCodesIssued = 0;

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1', '');
    const key = `${request.method()} ${path}`;
    requests.push(key);

    if (request.method() !== 'GET' && key !== 'POST /auth/login') {
      if (request.headers()['x-csrf-token'] !== CSRF) {
        csrfFailures.push(key);
        return json(route, 403, {
          error: { code: 'FORBIDDEN', message: 'CSRF token missing', requestId: 'e2e' },
        });
      }
    }

    switch (key) {
      case 'GET /auth/me':
        return signedIn ? json(route, 200, { data: current }) : unauthenticated(route);
      case 'POST /auth/login': {
        const body = request.postDataJSON() as { password?: string; deviceId?: string };
        if (body.password !== PASSWORD || typeof body.deviceId !== 'string') {
          return unauthenticated(route);
        }
        signedIn = true;
        return json(route, 200, { data: current });
      }
      case 'POST /auth/logout':
        signedIn = false;
        return json(route, 200, { data: { ok: true } });
      case 'GET /sync/pull':
        return json(route, 200, { changes: [], nextCursor: 0, hasMore: false });
      case 'GET /users':
        return json(route, 200, {
          data: [
            {
              id: '01930000-0000-7000-8000-0000000000a2',
              username: 'a-rather-long-username-for-a-narrow-screen',
              displayName: 'Dan Driver With A Fairly Long Display Name',
              phone: null,
              status: 'ACTIVE',
              mustChangePassword: false,
              lastLoginAt: null,
              createdAt: '2026-11-01T08:00:00.000Z',
              roles: [],
            },
          ],
        });
      case 'GET /roles':
        return json(route, 200, {
          data: [
            {
              id: '01930000-0000-7000-8000-0000000000b1',
              code: 'OWNER',
              name: 'Owner',
              isSystem: true,
              permissions: [
                { permission: 'users.manage', scope: 'ALL' },
                { permission: 'trip.view', scope: 'ALL' },
              ],
            },
          ],
        });
      case 'GET /tally/status':
        return json(route, 200, { data: { companies: [TALLY_STATUS] } });
      case 'GET /tally/companies':
        return json(route, 200, { data: [TALLY_COMPANY] });
      case 'GET /tally/agents':
        return json(route, 200, { data: [TALLY_AGENT] });
      case `POST /tally/companies/${TALLY_COMPANY_ID}/registration-code`:
        registrationCodesIssued += 1;
        return json(route, 201, {
          data: {
            companyId: TALLY_COMPANY_ID,
            code: REGISTRATION_CODE,
            expiresAt: '2030-01-01T00:15:00.000Z',
          },
        });
      case 'GET /tally/ledgers':
        return json(route, 200, { data: [TALLY_LEDGER] });
      case 'GET /tally/vouchers':
        return json(route, 200, { data: [TALLY_VOUCHER] });
      default:
        return json(route, 404, {
          error: { code: 'NOT_FOUND', message: `No fake for ${key}`, requestId: 'e2e' },
        });
    }
  });

  return {
    requests,
    csrfFailures,
    registrationCodesIssued: () => registrationCodesIssued,
    signedIn: () => signedIn,
    setNextUser: (user) => {
      current = user;
    },
  };
}
