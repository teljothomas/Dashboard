import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { PERMISSIONS } from '../src/modules/identity/index.js';
import type { RouteInventoryEntry } from '../src/plugins/authorize.js';
import { testConfig } from '../src/test-config.js';
import { createDummyDatabase } from './dummyDb.js';

/**
 * Route inventory (SECURITY section 3, WP-04.3). Every route the production app registers must
 * declare how it is authorized. The lists below are the only exceptions: adding a public or
 * session-only route means editing this file on purpose, which is the review point.
 */
const PUBLIC_ALLOWLIST: readonly (string | RegExp)[] = [
  '/health',
  '/api/v1/auth/login',
  '/api/v1/auth/reset/complete',
  /^\/connector\//,
];

/** Any authenticated user; the owning module decides per record (INTERFACES section 2). */
const SESSION_ONLY_ALLOWLIST: readonly string[] = [
  'GET /api/v1/attachments/:id',
  'GET /api/v1/auth/me',
  'GET /api/v1/sync/conflicts',
  'GET /api/v1/sync/pull',
  'POST /api/v1/attachments',
  'POST /api/v1/auth/change-password',
  'POST /api/v1/auth/logout',
  'POST /api/v1/sync/conflicts/:id/resolve',
  'POST /api/v1/sync/push',
];

const UUID = '019a0000-0000-7000-8000-000000000001';

let app: FastifyInstance;
let routes: RouteInventoryEntry[];

/** HEAD twins of GET routes carry the same declaration; judge each route once. */
const label = (entry: RouteInventoryEntry): string => `${entry.method} ${entry.url}`;

beforeAll(async () => {
  // Production wiring: session plugin, CSRF, identity routes. The dummy database is never reached
  // because every probe below carries no (or a malformed) session cookie.
  app = buildApp(testConfig, { db: createDummyDatabase() });
  await app.ready();
  routes = app.routeInventory.filter((entry) => entry.method !== 'HEAD');
});

afterAll(async () => {
  await app.close();
});

describe('route inventory', () => {
  it('finds the routes', () => {
    expect(routes.length).toBeGreaterThan(8);
  });

  it('public routes are on the explicit allowlist', () => {
    const publicRoutes = routes.filter((r) => r.auth.kind === 'public').map((r) => r.url);
    const unexpected = publicRoutes.filter(
      (url) =>
        !PUBLIC_ALLOWLIST.some((rule) =>
          typeof rule === 'string' ? rule === url : rule.test(url),
        ),
    );
    expect(unexpected).toEqual([]);
    expect(publicRoutes).toContain('/health');
    expect(publicRoutes).toContain('/api/v1/auth/login');
  });

  it('session-only routes are exactly the reviewed list', () => {
    const actual = routes
      .filter((r) => r.auth.kind === 'session')
      .map(label)
      .sort();
    expect(actual).toEqual([...SESSION_ONLY_ALLOWLIST].sort());
  });

  it('permission routes name a catalogue permission', () => {
    const permissionRoutes = routes.filter((r) => r.auth.kind === 'permission');
    for (const entry of permissionRoutes) {
      const permission = entry.auth.kind === 'permission' ? entry.auth.permission : '';
      expect(PERMISSIONS as readonly string[], label(entry)).toContain(permission);
    }
  });

  it('every non-public route answers 401 without a session and with a bogus cookie', async () => {
    const protectedRoutes = routes.filter((r) => r.auth.kind !== 'public');
    expect(protectedRoutes.length).toBeGreaterThan(0);
    for (const entry of protectedRoutes) {
      const url = entry.url.replace(/:[A-Za-z]+/g, UUID);
      for (const headers of [{}, { cookie: 'tradex_sid=not-a-real-token' }]) {
        const res = await app.inject({ method: entry.method as 'GET', url, headers });
        expect(res.statusCode, `${label(entry)} with ${JSON.stringify(headers)}`).toBe(401);
      }
    }
  });

  it('a route without a declaration cannot be registered', async () => {
    const instance = buildApp(testConfig, { db: createDummyDatabase() });
    expect(() => instance.get('/api/v1/future-route', () => ({ ok: true }))).toThrow(
      /has no auth declaration/,
    );
    await instance.close();
  });
});
