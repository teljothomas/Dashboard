import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AuditQuery,
  CreateRoleRequest,
  CreateUserRequest,
  ListUsersQuery,
  ResetCompleteRequest,
  UpdateRoleRequest,
  UpdateUserRequest,
  Uuid,
} from '@tradex/contracts';
import { AppError } from '../../errors.js';
import { authorize, publicRoute } from '../../plugins/authorize.js';
import { rateLimited, rateLimitHook, SlidingWindowLimiter } from '../../plugins/rateLimit.js';
import { actorOf, requireContext } from '../../plugins/requestContext.js';
import {
  completePasswordReset,
  createUser,
  getUser,
  issueResetCode,
  listUsers,
  unlockUser,
  updateUser,
  type Caller,
} from './adminUsers.js';
import {
  listUserDevices,
  listUserSessions,
  revokeAllUserSessions,
  revokeDevice,
  revokeSessionById,
} from './adminSessions.js';
import { listAudit } from './auditView.js';
import { createRole, getRole, listRoles, updateRole } from './roles.js';
import { normalizeUsername } from './users.js';

/** Reset completion: 20 requests per 15 minutes per IP, 5 wrong codes per 15 minutes per username. */
const RESET_REQUESTS_PER_IP = 20;
const RESET_FAILURES_PER_USERNAME = 5;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

const IdParams = z.object({ id: Uuid });

/**
 * These permissions are only meaningful with an unlimited ALL grant: the scope resolver names no
 * owner and no division, so an OWN, DIVISION or division-limited grant answers 404 (fail closed).
 */
const unlimited = () => ({});
const manageUsers = () => authorize('users.manage', { scope: unlimited });
const manageRoles = () => authorize('roles.manage', { scope: unlimited });
const viewAudit = () => authorize('audit.view', { scope: unlimited });

function noStore(reply: FastifyReply): void {
  void reply.header('Cache-Control', 'no-store');
}

function callerOf(request: FastifyRequest): Caller {
  const ctx = requireContext(request);
  return { ctx, actor: actorOf(request, ctx) };
}

/**
 * User, role, session, device and audit administration plus the public reset completion
 * (INTERFACES section 2 identity rows). Services in adminUsers.ts, roles.ts, adminSessions.ts and
 * auditView.ts hold the rules; routes parse input, declare authorization and shape the envelope.
 */
export function registerAdminRoutes(app: FastifyInstance): void {
  const resetIpLimiter = new SlidingWindowLimiter(RESET_REQUESTS_PER_IP, FIFTEEN_MINUTES_MS);
  const resetFailures = new SlidingWindowLimiter(RESET_FAILURES_PER_USERNAME, FIFTEEN_MINUTES_MS);

  app.register(
    (api, _opts, done) => {
      // ---- password reset completion (public) --------------------------------------------
      api.post(
        '/auth/reset/complete',
        {
          config: { csrfExempt: true, auth: publicRoute() },
          preHandler: rateLimitHook(resetIpLimiter, (request) => request.ip),
        },
        async (request, reply) => {
          const body = ResetCompleteRequest.parse(request.body);
          const key = normalizeUsername(body.username).slice(0, 128);
          // Reserve the attempt before checking, so parallel guesses cannot all slip through.
          const wait = resetFailures.consume(key);
          if (wait > 0) throw rateLimited(wait);
          try {
            await completePasswordReset(app.db, {
              username: body.username,
              code: body.code,
              newPassword: body.newPassword,
              ip: request.ip,
              requestId: request.id,
            });
          } catch (error) {
            // Only a wrong code counts; a policy or server error gives the attempt back.
            if (!(error instanceof AppError && error.details?.reason === 'RESET_CODE_INVALID')) {
              resetFailures.refund(key);
            }
            throw error;
          }
          resetFailures.reset(key);
          noStore(reply);
          return { data: { ok: true } };
        },
      );

      // ---- users -------------------------------------------------------------------------
      api.get('/users', { config: { auth: manageUsers() } }, async (request, reply) => {
        const query = ListUsersQuery.parse(request.query);
        const page = await listUsers(app.db, query);
        noStore(reply);
        return {
          data: page.items,
          ...(page.nextCursor === null ? {} : { meta: { nextCursor: page.nextCursor } }),
        };
      });

      api.post('/users', { config: { auth: manageUsers() } }, async (request, reply) => {
        const body = CreateUserRequest.parse(request.body);
        const user = await createUser(app.db, callerOf(request), body);
        noStore(reply);
        return reply.code(201).send({ data: user });
      });

      api.get('/users/:id', { config: { auth: manageUsers() } }, async (request, reply) => {
        const { id } = IdParams.parse(request.params);
        noStore(reply);
        return { data: await getUser(app.db, id) };
      });

      api.patch('/users/:id', { config: { auth: manageUsers() } }, async (request, reply) => {
        const { id } = IdParams.parse(request.params);
        const body = UpdateUserRequest.parse(request.body);
        const user = await updateUser(app.db, callerOf(request), id, body);
        noStore(reply);
        return { data: user };
      });

      api.post('/users/:id/unlock', { config: { auth: manageUsers() } }, async (request, reply) => {
        const { id } = IdParams.parse(request.params);
        await unlockUser(app.db, callerOf(request), id);
        noStore(reply);
        return { data: { ok: true } };
      });

      api.post(
        '/users/:id/reset-code',
        { config: { auth: manageUsers() } },
        async (request, reply) => {
          const { id } = IdParams.parse(request.params);
          const issued = await issueResetCode(app.db, callerOf(request), id);
          noStore(reply);
          return { data: issued };
        },
      );

      api.get(
        '/users/:id/sessions',
        { config: { auth: manageUsers() } },
        async (request, reply) => {
          const { id } = IdParams.parse(request.params);
          noStore(reply);
          return { data: await listUserSessions(app.db, id) };
        },
      );

      api.delete(
        '/users/:id/sessions',
        { config: { auth: manageUsers() } },
        async (request, reply) => {
          const { id } = IdParams.parse(request.params);
          const revoked = await revokeAllUserSessions(app.db, callerOf(request), id);
          noStore(reply);
          return { data: { revoked } };
        },
      );

      api.get('/users/:id/devices', { config: { auth: manageUsers() } }, async (request, reply) => {
        const { id } = IdParams.parse(request.params);
        noStore(reply);
        return { data: await listUserDevices(app.db, id) };
      });

      api.delete('/sessions/:id', { config: { auth: manageUsers() } }, async (request, reply) => {
        const { id } = IdParams.parse(request.params);
        const revoked = await revokeSessionById(app.db, callerOf(request), id);
        noStore(reply);
        return { data: { revoked } };
      });

      api.post(
        '/devices/:id/revoke',
        { config: { auth: manageUsers() } },
        async (request, reply) => {
          const { id } = IdParams.parse(request.params);
          const result = await revokeDevice(app.db, callerOf(request), id);
          noStore(reply);
          return { data: result };
        },
      );

      // ---- roles -------------------------------------------------------------------------
      api.get('/roles', { config: { auth: manageRoles() } }, async (_request, reply) => {
        noStore(reply);
        return { data: await listRoles(app.db) };
      });

      api.post('/roles', { config: { auth: manageRoles() } }, async (request, reply) => {
        const body = CreateRoleRequest.parse(request.body);
        const role = await createRole(app.db, callerOf(request), body);
        return reply.code(201).send({ data: role });
      });

      api.get('/roles/:id', { config: { auth: manageRoles() } }, async (request, reply) => {
        const { id } = IdParams.parse(request.params);
        noStore(reply);
        return { data: await getRole(app.db, id) };
      });

      api.patch('/roles/:id', { config: { auth: manageRoles() } }, async (request) => {
        const { id } = IdParams.parse(request.params);
        const body = UpdateRoleRequest.parse(request.body);
        return { data: await updateRole(app.db, callerOf(request), id, body) };
      });

      // ---- audit view --------------------------------------------------------------------
      api.get('/audit', { config: { auth: viewAudit() } }, async (request, reply) => {
        const query = AuditQuery.parse(request.query);
        const page = await listAudit(app.db, query);
        noStore(reply);
        return {
          data: page.items,
          ...(page.nextCursor === null ? {} : { meta: { nextCursor: page.nextCursor } }),
        };
      });

      done();
    },
    { prefix: '/api/v1' },
  );
}
