import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PERMISSIONS } from '../modules/identity/catalogue.js';
import { AppError } from '../errors.js';
import { assertInScope, hasPermission, type ScopeTarget } from '../lib/scope.js';
import { requireContext } from './requestContext.js';

/**
 * Per-route authorization declaration (SECURITY section 3). Every route must carry one in
 * `config.auth`; registering a route without it throws, so a new endpoint cannot ship open by
 * accident. Three kinds:
 *
 * - `authorize('perm', { scope })`: needs a session and the permission (401 / 403). The optional
 *   `scope` resolver names the record's owner and division from the request; when it is given the
 *   caller must hold a grant that covers it, else 404 (out-of-scope records look absent).
 * - `sessionOnly()`: any authenticated user. For routes where the owning module decides access
 *   per record (attachments, sync) or that every user needs (`/auth/me`).
 * - `publicRoute()`: no session. Only login, reset, health and the connector (the inventory test
 *   pins the exact list).
 */
export type ScopeResolver = (request: FastifyRequest) => ScopeTarget | Promise<ScopeTarget>;

export type RouteAuth =
  | { kind: 'public' }
  | { kind: 'session' }
  | { kind: 'permission'; permission: string; scope?: ScopeResolver };

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Required on every route; see `plugins/authorize.ts`. */
    auth?: RouteAuth;
  }
}

const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set(PERMISSIONS);

export function authorize(permission: string, options: { scope?: ScopeResolver } = {}): RouteAuth {
  if (!KNOWN_PERMISSIONS.has(permission)) {
    throw new Error(`Unknown permission in route declaration: ${permission}`);
  }
  return {
    kind: 'permission',
    permission,
    ...(options.scope ? { scope: options.scope } : {}),
  };
}

export function sessionOnly(): RouteAuth {
  return { kind: 'session' };
}

export function publicRoute(): RouteAuth {
  return { kind: 'public' };
}

/** One registered route with its declaration, for the inventory test. */
export interface RouteInventoryEntry {
  method: string;
  url: string;
  auth: RouteAuth;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Every route registered so far (HEAD twins of GET routes included). */
    routeInventory: RouteInventoryEntry[];
  }
}

/**
 * Registers the declaration check and the enforcement hooks. Call it after the request-context
 * provider and CSRF (the `onRequest` hooks run in registration order) and before any route.
 *
 * - `onRoute`: throws for a route with no declaration, and records the inventory.
 * - `onRequest`: 401 without a session, 403 without the permission. Judged by the matched route,
 *   never the raw URL (the router percent-decodes). Unmatched requests (404) have no route.
 * - `preHandler`: the scope resolver, after the body is parsed so it may read it. Failing it is 404.
 */
export function registerAuthorize(app: FastifyInstance): void {
  app.decorate('routeInventory', [] as RouteInventoryEntry[]);

  app.addHook('onRoute', (route) => {
    const auth = route.config?.auth;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (auth === undefined) {
      throw new Error(
        `Route ${methods.join('|')} ${route.url} has no auth declaration (config.auth: authorize(), sessionOnly() or publicRoute())`,
      );
    }
    for (const method of methods) {
      app.routeInventory.push({ method, url: route.url, auth });
    }
  });

  app.addHook('onRequest', (request, _reply, done) => {
    const auth = request.routeOptions.config.auth;
    if (auth === undefined || auth.kind === 'public') return done();
    if (!request.ctx) return done(new AppError('UNAUTHENTICATED', 'Authentication required'));
    if (auth.kind === 'permission' && !hasPermission(request.ctx, auth.permission)) {
      return done(new AppError('FORBIDDEN', 'Permission denied', { permission: auth.permission }));
    }
    done();
  });

  app.addHook('preHandler', async (request) => {
    const auth = request.routeOptions.config.auth;
    if (auth?.kind !== 'permission' || auth.scope === undefined) return;
    const ctx = requireContext(request);
    assertInScope(ctx, auth.permission, await auth.scope(request));
  });
}
