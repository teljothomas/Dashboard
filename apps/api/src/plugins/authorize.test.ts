import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ErrorEnvelope, type PermissionGrantDto } from '@tradex/contracts';
import { buildApp } from '../app.js';
import { assertNotSelf } from '../lib/scope.js';
import { testConfig } from '../test-config.js';
import { createDummyDatabase } from '../../test/dummyDb.js';
import { headerContextProvider } from '../../test/requestContext.js';
import { authorize, publicRoute, sessionOnly } from './authorize.js';
import { requireContext } from './requestContext.js';

const USER = '019a0000-0000-7000-8000-000000000001';
const OTHER = '019a0000-0000-7000-8000-000000000002';
const MEAT = '019a0000-0000-7000-8000-0000000000a1';
const LOGISTICS = '019a0000-0000-7000-8000-0000000000a2';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** App with the header provider and a few routes covering each declaration kind. */
function makeApp(): FastifyInstance {
  const instance = buildApp(testConfig, {
    db: createDummyDatabase(),
    requestContext: headerContextProvider,
  });
  instance.get('/_t/open', { config: { auth: publicRoute() } }, () => ({ ok: true }));
  instance.get('/_t/session', { config: { auth: sessionOnly() } }, () => ({ ok: true }));
  instance.get('/_t/users', { config: { auth: authorize('users.manage') } }, () => ({ ok: true }));
  instance.get(
    '/_t/expense/:owner/:division',
    {
      config: {
        auth: authorize('expense.view', {
          scope: (request) => {
            const params = request.params as { owner: string; division: string };
            return { ownerId: params.owner, divisionId: params.division };
          },
        }),
      },
    },
    () => ({ ok: true }),
  );
  instance.post(
    '/_t/approve/:creator',
    { config: { auth: authorize('expense.approve') } },
    (request) => {
      const { creator } = request.params as { creator: string };
      assertNotSelf(requireContext(request), creator);
      return { ok: true };
    },
  );
  instance.post(
    '/_t/body-scope',
    {
      config: {
        auth: authorize('expense.create', {
          scope: (request) => ({ divisionId: (request.body as { division: string }).division }),
        }),
      },
    },
    () => ({ ok: true }),
  );
  app = instance;
  return instance;
}

const as = (grants: PermissionGrantDto[], roles = ''): Record<string, string> => ({
  'x-test-user': USER,
  'x-test-grants': JSON.stringify(grants),
  ...(roles ? { 'x-test-roles': roles } : {}),
});
const grant = (
  permission: string,
  scope: PermissionGrantDto['scope'] = 'ALL',
  divisionId: string | null = null,
): PermissionGrantDto => ({ permission, scope, divisionId });

describe('route declarations', () => {
  it('registering a route without config.auth throws', async () => {
    const instance = buildApp(testConfig, {
      db: createDummyDatabase(),
      requestContext: headerContextProvider,
    });
    app = instance;
    // Root-level routes register synchronously, so the missing declaration throws right here.
    expect(() => instance.get('/_t/undeclared', () => ({ ok: true }))).toThrow(
      /\/_t\/undeclared has no auth declaration/,
    );
    await Promise.resolve();
  });

  it('an unknown permission code in a declaration throws at definition time', () => {
    expect(() => authorize('expense.aprove')).toThrow(/Unknown permission/);
  });

  it('records every route in the inventory', async () => {
    const instance = makeApp();
    await instance.ready();
    const entry = instance.routeInventory.find((r) => r.url === '/_t/users' && r.method === 'GET');
    expect(entry?.auth).toMatchObject({ kind: 'permission', permission: 'users.manage' });
  });
});

describe('route-level authorization', () => {
  it('public route needs no session', async () => {
    const res = await makeApp().inject({ method: 'GET', url: '/_t/open' });
    expect(res.statusCode).toBe(200);
  });

  it('session-only: 401 without a session, 200 with any session', async () => {
    const instance = makeApp();
    expect((await instance.inject({ method: 'GET', url: '/_t/session' })).statusCode).toBe(401);
    const res = await instance.inject({
      method: 'GET',
      url: '/_t/session',
      headers: as([]),
    });
    expect(res.statusCode).toBe(200);
  });

  it('permission route: 401 without session, 403 without permission, 200 with it', async () => {
    const instance = makeApp();
    const none = await instance.inject({ method: 'GET', url: '/_t/users' });
    expect(none.statusCode).toBe(401);
    expect(ErrorEnvelope.parse(none.json()).error.code).toBe('UNAUTHENTICATED');

    const denied = await instance.inject({
      method: 'GET',
      url: '/_t/users',
      headers: as([grant('roles.manage')]),
    });
    expect(denied.statusCode).toBe(403);
    expect(ErrorEnvelope.parse(denied.json()).error.code).toBe('FORBIDDEN');

    const ok = await instance.inject({
      method: 'GET',
      url: '/_t/users',
      headers: as([grant('users.manage')]),
    });
    expect(ok.statusCode).toBe(200);
  });

  it('percent-encoded path still reaches the matched route and its declaration', async () => {
    const res = await makeApp().inject({ method: 'GET', url: '/_t/%75sers' });
    expect(res.statusCode).toBe(401);
  });

  it('an unmatched path is a plain 404, not a 401', async () => {
    const res = await makeApp().inject({ method: 'GET', url: '/_t/nope' });
    expect(res.statusCode).toBe(404);
  });
});

describe('scope resolver', () => {
  const url = (owner: string, division: string): string => `/_t/expense/${owner}/${division}`;

  it('OWN: own record 200, someone else 404', async () => {
    const instance = makeApp();
    const headers = as([grant('expense.view', 'OWN')]);
    expect(
      (await instance.inject({ method: 'GET', url: url(USER, MEAT), headers })).statusCode,
    ).toBe(200);
    const other = await instance.inject({ method: 'GET', url: url(OTHER, MEAT), headers });
    expect(other.statusCode).toBe(404);
    expect(ErrorEnvelope.parse(other.json()).error.code).toBe('NOT_FOUND');
  });

  it('DIVISION: own division 200, other division 404', async () => {
    const instance = makeApp();
    const headers = as([grant('expense.view', 'DIVISION', MEAT)]);
    expect(
      (await instance.inject({ method: 'GET', url: url(OTHER, MEAT), headers })).statusCode,
    ).toBe(200);
    expect(
      (await instance.inject({ method: 'GET', url: url(OTHER, LOGISTICS), headers })).statusCode,
    ).toBe(404);
  });

  it('ALL covers every record; no permission is 403 before scope is consulted', async () => {
    const instance = makeApp();
    const all = as([grant('expense.view', 'ALL')]);
    expect(
      (await instance.inject({ method: 'GET', url: url(OTHER, LOGISTICS), headers: all }))
        .statusCode,
    ).toBe(200);
    const none = as([grant('expense.create', 'ALL')]);
    expect(
      (await instance.inject({ method: 'GET', url: url(USER, MEAT), headers: none })).statusCode,
    ).toBe(403);
  });

  it('resolver may read the parsed body', async () => {
    const instance = makeApp();
    const headers = as([grant('expense.create', 'DIVISION', MEAT)]);
    const inside = await instance.inject({
      method: 'POST',
      url: '/_t/body-scope',
      headers,
      payload: { division: MEAT },
    });
    expect(inside.statusCode).toBe(200);
    const outside = await instance.inject({
      method: 'POST',
      url: '/_t/body-scope',
      headers,
      payload: { division: LOGISTICS },
    });
    expect(outside.statusCode).toBe(404);
  });
});

describe('self-approval guard in a route', () => {
  it('blocks own record, allows others, exempts OWNER', async () => {
    const instance = makeApp();
    const approver = as([grant('expense.approve')], 'ACCOUNTANT');
    const own = await instance.inject({
      method: 'POST',
      url: `/_t/approve/${USER}`,
      headers: approver,
    });
    expect(own.statusCode).toBe(403);
    expect(ErrorEnvelope.parse(own.json()).error.details).toEqual({ reason: 'SELF_APPROVAL' });
    expect(
      (await instance.inject({ method: 'POST', url: `/_t/approve/${OTHER}`, headers: approver }))
        .statusCode,
    ).toBe(200);
    const owner = as([grant('expense.approve')], 'OWNER');
    expect(
      (await instance.inject({ method: 'POST', url: `/_t/approve/${USER}`, headers: owner }))
        .statusCode,
    ).toBe(200);
  });
});
