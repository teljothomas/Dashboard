import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Uuid } from '@tradex/contracts';
import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import { ABSOLUTE_EXPIRY_DAYS, resolveSession } from '../modules/identity/sessions.js';

/** Cookie name: `__Host-` prefix needs Secure, so it is production only (localhost dev is plain HTTP). */
export function sessionCookieName(config: Pick<AppConfig, 'NODE_ENV'>): string {
  return config.NODE_ENV === 'production' ? '__Host-tradex_sid' : 'tradex_sid';
}

/** Value of cookie `name` in a Cookie header, or null. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** httpOnly, SameSite=Lax, Path=/, Secure in production; no Domain (host-only). */
export function sessionCookie(config: Pick<AppConfig, 'NODE_ENV'>, token: string): string {
  const maxAge = ABSOLUTE_EXPIRY_DAYS * 24 * 60 * 60;
  return [
    `${sessionCookieName(config)}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${String(maxAge)}`,
    ...(config.NODE_ENV === 'production' ? ['Secure'] : []),
  ].join('; ');
}

export function clearedSessionCookie(config: Pick<AppConfig, 'NODE_ENV'>): string {
  return [
    `${sessionCookieName(config)}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    ...(config.NODE_ENV === 'production' ? ['Secure'] : []),
  ].join('; ');
}

/** The raw session token a request carries, if any (used by login to retire an old session). */
export function requestSessionToken(
  request: FastifyRequest,
  config: Pick<AppConfig, 'NODE_ENV'>,
): string | null {
  return readCookie(request.headers.cookie, sessionCookieName(config));
}

const API_PREFIX = '/api/v1/';
/** Routes a user who must change the password may still call. */
const PASSWORD_CHANGE_ALLOWED = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/reset/complete',
  '/api/v1/auth/me',
  '/api/v1/auth/logout',
  '/api/v1/auth/change-password',
]);

function pathOf(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/**
 * Session plugin: `onRequest` reads the session cookie, resolves it against the database and
 * sets `request.ctx`. An absent, malformed, unknown, revoked or expired cookie leaves `ctx` null,
 * so routes answer 401 through `requireContext`. A user who must change the password can only
 * reach the auth routes until they do.
 */
export function registerSession(app: FastifyInstance, config: AppConfig): void {
  const cookieName = sessionCookieName(config);
  app.addHook('onRequest', async (request) => {
    const token = readCookie(request.headers.cookie, cookieName);
    if (token === null) return;
    const header = request.headers['x-device-id'];
    const device = typeof header === 'string' ? Uuid.safeParse(header) : null;
    const ctx = await resolveSession(
      app.db,
      token,
      device?.success ? device.data : null,
      config.SESSION_SECRET,
    );
    if (ctx === null) return;
    request.ctx = ctx;
    const path = pathOf(request.url);
    if (
      ctx.mustChangePassword &&
      path.startsWith(API_PREFIX) &&
      !PASSWORD_CHANGE_ALLOWED.has(path)
    ) {
      throw new AppError('FORBIDDEN', 'Password change required.', {
        reason: 'PASSWORD_CHANGE_REQUIRED',
      });
    }
  });
}
