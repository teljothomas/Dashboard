import type { RequestContextProvider } from '../src/plugins/requestContext.js';

/**
 * Test-only request-context provider (never imported by `src/`). Authenticates from headers:
 * `x-test-user` (required for a context), `x-test-device`, `x-test-permissions` (comma list).
 * Requests without `x-test-user` stay unauthenticated. No session, so no CSRF check applies.
 */
export const headerContextProvider: RequestContextProvider = (app) => {
  app.addHook('onRequest', (request, _reply, done) => {
    const user = request.headers['x-test-user'];
    if (typeof user === 'string' && user.length > 0) {
      const device = request.headers['x-test-device'];
      const perms = request.headers['x-test-permissions'];
      const permissions = typeof perms === 'string' && perms.length > 0 ? perms.split(',') : [];
      request.ctx = {
        userId: user,
        deviceId: typeof device === 'string' && device.length > 0 ? device : null,
        permissions,
        roles: [],
        grants: permissions.map((permission) => ({ permission, scope: 'ALL', divisionId: null })),
        sessionId: null,
        csrfToken: null,
        mustChangePassword: false,
      };
    }
    done();
  });
};
