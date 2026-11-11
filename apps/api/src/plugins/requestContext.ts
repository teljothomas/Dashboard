import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../errors.js';
import type { ActorContext } from '../modules/core/context.js';

/** Who is calling, as established by the auth layer (Phase 04, WP-04.3). */
export interface RequestContext {
  userId: string;
  deviceId: string | null;
  permissions: readonly string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Null until a provider authenticates the request. Routes use `requireContext`. */
    ctx: RequestContext | null;
  }
}

/**
 * A provider registers hooks that set `request.ctx` (an `onRequest` hook that validates the
 * session). Production `buildApp` passes none until WP-04.3, so every route that calls
 * `requireContext` answers 401. Tests pass a test-only provider from `apps/api/test/`.
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
