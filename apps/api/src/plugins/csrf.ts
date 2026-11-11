import type { FastifyInstance } from 'fastify';
import { AppError } from '../errors.js';
import { safeEqual } from '../modules/identity/sessions.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Routes that must work without the CSRF header (login, signed connector calls). */
    csrfExempt?: boolean;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** The connector authenticates with signatures, not cookies (INTERFACES section 5). */
const EXEMPT_PREFIXES = ['/connector/'];

/**
 * Double-submit CSRF check (SECURITY section 4, ADR-050). Every non-GET request that carries a
 * session must send `X-CSRF-Token` equal to the session-bound token returned by login and
 * `/auth/me`. Runs after the session hook. Requests without a session are not checked (they
 * cannot act as a user: the route answers 401). Failure is 403 before any body is read.
 */
export function registerCsrf(app: FastifyInstance): void {
  app.addHook('onRequest', (request, _reply, done) => {
    if (SAFE_METHODS.has(request.method)) return done();
    const expected = request.ctx?.csrfToken;
    if (expected === null || expected === undefined) return done();
    if (request.routeOptions.config.csrfExempt === true) return done();
    if (EXEMPT_PREFIXES.some((prefix) => request.url.startsWith(prefix))) return done();
    const sent = request.headers['x-csrf-token'];
    if (typeof sent === 'string' && safeEqual(sent, expected)) return done();
    done(new AppError('FORBIDDEN', 'CSRF token missing or invalid.', { reason: 'CSRF' }));
  });
}
