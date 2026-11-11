import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PermissionGrantDto } from '@tradex/contracts';
import { AppError } from '../errors.js';
import type { ActorContext } from '../modules/core/context.js';

/** Who is calling, as established by the session plugin (WP-04.2). */
export interface RequestContext {
  userId: string;
  deviceId: string | null;
  /** Distinct permission codes the user holds (any scope). */
  permissions: readonly string[];
  /** Role codes assigned to the user. */
  roles: readonly string[];
  /** One entry per (assignment, permission): code, scope and the assignment's division limiter. */
  grants: readonly PermissionGrantDto[];
  /** Null for providers that do not use sessions (tests). */
  sessionId: string | null;
  /** Session-bound CSRF token, null for providers that do not use sessions. */
  csrfToken: string | null;
  mustChangePassword: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Null until a provider authenticates the request. Routes use `requireContext`. */
    ctx: RequestContext | null;
  }
}

/**
 * A provider registers hooks that set `request.ctx` (an `onRequest` hook that validates the
 * session). Production uses the session plugin (`plugins/session.ts`); tests may pass a
 * header-based provider from `apps/api/test/` instead.
 */
export type RequestContextProvider = (app: FastifyInstance) => void;

export function registerRequestContext(
  app: FastifyInstance,
  provider?: RequestContextProvider,
): void {
  app.decorateRequest('ctx', null);
  provider?.(app);
}

/** The caller's context, or `UNAUTHENTICATED` (401) when the request carries none. */
export function requireContext(request: FastifyRequest): RequestContext {
  if (!request.ctx) {
    throw new AppError('UNAUTHENTICATED', 'Authentication required');
  }
  return request.ctx;
}

/** Actor fields for audit rows, from the request context plus transport details. */
export function actorOf(request: FastifyRequest, ctx: RequestContext): ActorContext {
  return {
    userId: ctx.userId,
    deviceId: ctx.deviceId ?? undefined,
    requestId: request.id,
    ip: request.ip,
  };
}
