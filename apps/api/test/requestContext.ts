import type { RequestContextProvider } from '../src/plugins/requestContext.js';

/**
 * Test-only request-context provider (never imported by `src/`). Authenticates from headers:
 * `x-test-user` (required for a context), `x-test-device`, `x-test-permissions` (comma list).
 * Requests without `x-test-user` stay unauthenticated.
 */
export const headerContextProvider: RequestContextProvider = (app) => {
  app.addHook('onRequest', (request, _reply, done) => {
    const user = request.headers['x-test-user'];
    if (typeof user === 'string' && user.length > 0) {
      const device = request.headers['x-test-device'];
      const perms = request.headers['x-test-permissions'];
      request.ctx = {
        userId: user,
        deviceId: typeof device === 'string' && device.length > 0 ? device : null,
        permissions: typeof perms === 'string' && perms.length > 0 ? perms.split(',') : [],
      };
    }
    done();
  });
};
