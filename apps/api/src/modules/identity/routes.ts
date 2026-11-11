import type { FastifyInstance, FastifyReply } from 'fastify';
import { ChangePasswordRequest, LoginRequest } from '@tradex/contracts';
import type { AppConfig } from '../../config.js';
import { AppError } from '../../errors.js';
import { rateLimited, rateLimitHook, SlidingWindowLimiter } from '../../plugins/rateLimit.js';
import { clearedSessionCookie, sessionCookie } from '../../plugins/session.js';
import { actorOf, requireContext } from '../../plugins/requestContext.js';
import { changePassword, loadSessionInfo, login, logout } from './auth.js';

/** Coarse per-IP cap on login requests (CPU protection); failure lockout is separate (auth.ts). */
const LOGIN_REQUESTS_PER_MINUTE = 30;
/** Wrong current passwords on change-password: 5 per 15 minutes per user. */
const CHANGE_PASSWORD_FAILURES = 5;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

function noStore(reply: FastifyReply): void {
  void reply.header('Cache-Control', 'no-store');
}

/**
 * Identity routes under `/api/v1/auth` (INTERFACES section 2). Reset and user management come
 * in WP-04.4. Limiters live per app instance.
 */
export function registerIdentityRoutes(app: FastifyInstance, config: AppConfig): void {
  const loginLimiter = new SlidingWindowLimiter(LOGIN_REQUESTS_PER_MINUTE, 60_000);
  const changePasswordFailures = new SlidingWindowLimiter(
    CHANGE_PASSWORD_FAILURES,
    FIFTEEN_MINUTES_MS,
  );

  app.register(
    (api, _opts, done) => {
      api.post(
        '/auth/login',
        {
          config: { csrfExempt: true },
          preHandler: rateLimitHook(loginLimiter, (request) => request.ip),
        },
        async (request, reply) => {
          const body = LoginRequest.parse(request.body);
          const result = await login(app.db, {
            username: body.username,
            password: body.password,
            deviceId: body.deviceId,
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
            requestId: request.id,
            previousSessionId: request.ctx?.sessionId ?? null,
            csrfSecret: config.SESSION_SECRET,
          });
          noStore(reply);
          void reply.header('Set-Cookie', sessionCookie(config, result.token));
          return { data: result.info };
        },
      );

      api.post('/auth/logout', async (request, reply) => {
        const ctx = requireContext(request);
        if (ctx.sessionId !== null) {
          await logout(app.db, ctx.sessionId, actorOf(request, ctx));
        }
        noStore(reply);
        void reply.header('Set-Cookie', clearedSessionCookie(config));
        return { data: { ok: true } };
      });

      api.get('/auth/me', async (request, reply) => {
        const ctx = requireContext(request);
        noStore(reply);
        return { data: await loadSessionInfo(app.db, ctx.userId, ctx.csrfToken ?? '') };
      });

      api.post('/auth/change-password', async (request, reply) => {
        const ctx = requireContext(request);
        const body = ChangePasswordRequest.parse(request.body);
        // Reserve the attempt before verifying so parallel guesses cannot all pass the check.
        const wait = changePasswordFailures.consume(ctx.userId);
        if (wait > 0) throw rateLimited(wait);
        try {
          await changePassword(app.db, {
            userId: ctx.userId,
            sessionId: ctx.sessionId,
            currentPassword: body.currentPassword,
            newPassword: body.newPassword,
            ctx: actorOf(request, ctx),
          });
        } catch (error) {
          // Only a wrong current password counts; policy or server errors give the attempt back.
          if (!(
            error instanceof AppError && error.details?.reason === 'CURRENT_PASSWORD_INCORRECT'
          )) {
            changePasswordFailures.refund(ctx.userId);
          }
          throw error;
        }
        changePasswordFailures.reset(ctx.userId);
        noStore(reply);
        return { data: { ok: true } };
      });

      done();
    },
    { prefix: '/api/v1' },
  );
}
