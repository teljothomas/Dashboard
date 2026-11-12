import type { PermissionGrantDto } from '@tradex/contracts';
import type { RequestContextProvider } from '../src/plugins/requestContext.js';

/**
 * Test-only request-context provider (never imported by `src/`). Authenticates from headers:
 * `x-test-user` (required for a context), `x-test-device`, `x-test-permissions` (comma list, each
 * granted with scope ALL), `x-test-grants` (JSON array of `{permission, scope, divisionId}`, used
 * instead when present) and `x-test-roles` (comma list). Requests without `x-test-user` stay
 * unauthenticated. No session, so no CSRF check applies.
 */
export const headerContextProvider: RequestContextProvider = (app) => {
  app.addHook('onRequest', (request, _reply, done) => {
    const user = request.headers['x-test-user'];
    if (typeof user === 'string' && user.length > 0) {
      const device = request.headers['x-test-device'];
      const perms = request.headers['x-test-permissions'];
      const rawGrants = request.headers['x-test-grants'];
      const roles = request.headers['x-test-roles'];
      const grants: PermissionGrantDto[] =
        typeof rawGrants === 'string' && rawGrants.length > 0
          ? (JSON.parse(rawGrants) as PermissionGrantDto[])
          : (typeof perms === 'string' && perms.length > 0 ? perms.split(',') : []).map(
              (permission) => ({ permission, scope: 'ALL' as const, divisionId: null }),
            );
      request.ctx = {
        userId: user,
        deviceId: typeof device === 'string' && device.length > 0 ? device : null,
        permissions: [...new Set(grants.map((grant) => grant.permission))],
        roles: typeof roles === 'string' && roles.length > 0 ? roles.split(',') : [],
        grants,
        sessionId: null,
        csrfToken: null,
        mustChangePassword: false,
      };
    }
    done();
  });
};
