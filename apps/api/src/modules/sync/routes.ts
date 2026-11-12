import {
  ConflictListQuery,
  PullQuery,
  PushRequest,
  ResolveConflictRequest,
  Uuid,
} from '@tradex/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { sessionOnly } from '../../plugins/authorize.js';
import { actorOf, requireContext } from '../../plugins/requestContext.js';
import { listConflicts, resolveConflict } from './conflicts.js';
import { pull } from './pull.js';
import { processPush } from './push.js';
import type { SyncCaller } from './types.js';

const IdParam = z.object({ id: Uuid });

/**
 * Any authenticated user may sync. What each entity type exposes is decided per record by its
 * registered handler (permissions and scope in `scopeFilter`, `approverPermission` for conflicts).
 */
const SYNC_AUTH = { config: { auth: sessionOnly() } };

function callerOf(request: FastifyRequest, deviceId: string | null): SyncCaller {
  const ctx = requireContext(request);
  return {
    userId: ctx.userId,
    deviceId,
    permissions: ctx.permissions,
    actor: { ...actorOf(request, ctx), deviceId: deviceId ?? undefined },
  };
}

/**
 * Device sync endpoints (INTERFACES sections 2 and 4). All require an authenticated request
 * context (the auth seam, Phase 04). Success bodies use the `{ data, meta? }` envelope.
 */
export function registerSyncRoutes(app: FastifyInstance): void {
  app.register(
    (api, _opts, done) => {
      api.post('/sync/push', SYNC_AUTH, async (request) => {
        const ctx = requireContext(request);
        const body = PushRequest.parse(request.body);
        // The device recorded in client_mutation, conflicts and audit must be the one the session
        // is bound to, never a value the body merely claims. The body field only has to agree.
        if (ctx.deviceId === null) {
          throw new AppError('FORBIDDEN', 'Session is not bound to a device');
        }
        if (ctx.deviceId !== body.deviceId) {
          throw new AppError('FORBIDDEN', 'Device does not match the session');
        }
        const results = await processPush(app.db, callerOf(request, ctx.deviceId), body);
        return { data: { results } };
      });

      api.get('/sync/pull', SYNC_AUTH, async (request) => {
        const ctx = requireContext(request);
        const query = PullQuery.parse(request.query);
        const data = await pull(app.db, callerOf(request, ctx.deviceId), query);
        return { data };
      });

      api.get('/sync/conflicts', SYNC_AUTH, async (request) => {
        const ctx = requireContext(request);
        const query = ConflictListQuery.parse(request.query);
        const { items, nextCursor } = await listConflicts(
          app.db,
          callerOf(request, ctx.deviceId),
          query,
        );
        return { data: items, ...(nextCursor ? { meta: { nextCursor } } : {}) };
      });

      api.post('/sync/conflicts/:id/resolve', SYNC_AUTH, async (request) => {
        const ctx = requireContext(request);
        const params = IdParam.safeParse(request.params);
        if (!params.success) {
          throw new AppError('NOT_FOUND', 'Conflict not found');
        }
        const body = ResolveConflictRequest.parse(request.body);
        const data = await resolveConflict(
          app.db,
          callerOf(request, ctx.deviceId),
          params.data.id,
          body,
        );
        return { data };
      });

      done();
    },
    { prefix: '/api/v1' },
  );
}
