import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import type { PermissionGrantDto } from '@tradex/contracts';
import { uuidv7 } from '@tradex/domain';
import type { Database } from '../../db/index.js';
import type { RequestContext } from '../../plugins/requestContext.js';
import type { Tx } from '../core/context.js';

/** ADR-050: 14 days idle (sliding), 30 days absolute. */
export const IDLE_EXPIRY_DAYS = 14;
export const ABSOLUTE_EXPIRY_DAYS = 30;
/** `last_seen_at` / sliding expiry are rewritten at most this often (limits write load). */
export const TOUCH_INTERVAL_MINUTES = 5;
/** 32 random bytes as base64url. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isWellFormedToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

/** The database stores only this digest, never the token (ADR-050). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

/**
 * Double-submit CSRF token: HMAC of the session's token hash under SESSION_SECRET. Bound to the
 * session, needs no storage, and cannot be forged without the secret (SECURITY section 4).
 */
export function csrfTokenFor(secret: string, tokenHash: string): string {
  return createHmac('sha256', secret).update(`csrf-v1:${tokenHash}`).digest('base64url');
}

/** Constant-time string comparison (digests are hashed first so lengths never leak). */
export function safeEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db);
}

export interface NewSession {
  id: string;
  token: string;
  tokenHash: string;
}

export interface CreateSessionInput {
  userId: string;
  deviceId: string | null;
  userAgent: string | null;
  ip: string | null;
}

/** Insert a session row (expiry computed by the database clock) and return the raw token once. */
export async function createSession(tx: Tx, input: CreateSessionInput): Promise<NewSession> {
  const { token, tokenHash } = newSessionToken();
  const id = uuidv7();
  await tx
    .insertInto('session')
    .values({
      id,
      token_hash: tokenHash,
      user_id: input.userId,
      device_id: input.deviceId,
      expires_at: sql`now() + make_interval(days => ${IDLE_EXPIRY_DAYS})`,
      absolute_expires_at: sql`now() + make_interval(days => ${ABSOLUTE_EXPIRY_DAYS})`,
      user_agent: input.userAgent === null ? null : input.userAgent.slice(0, 512),
      ip: input.ip,
    })
    .execute();
  return { id, token, tokenHash };
}

/** Revoke one session. Returns true when a live session was revoked. */
export async function revokeSession(tx: Tx, sessionId: string): Promise<boolean> {
  const result = await tx
    .updateTable('session')
    .set({ revoked_at: sql`now()` })
    .where('id', '=', sessionId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

/** Revoke every live session of the user except `keepSessionId` (null keeps none). Returns the count. */
export async function revokeUserSessions(
  tx: Tx,
  userId: string,
  keepSessionId: string | null,
): Promise<number> {
  let query = tx
    .updateTable('session')
    .set({ revoked_at: sql`now()` })
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null);
  if (keepSessionId !== null) query = query.where('id', '!=', keepSessionId);
  const result = await query.executeTakeFirst();
  return Number(result.numUpdatedRows);
}

export interface Grants {
  roles: string[];
  permissions: string[];
  grants: PermissionGrantDto[];
}

/** Roles and permission grants of a user (one grant per assignment x permission). */
export async function loadGrants(db: Database | Tx, userId: string): Promise<Grants> {
  const rows = await db
    .selectFrom('user_role as ur')
    .innerJoin('role as r', 'r.id', 'ur.role_id')
    .leftJoin('role_permission as rp', 'rp.role_id', 'ur.role_id')
    .select(['r.code as role', 'ur.division_id', 'rp.permission_code', 'rp.scope'])
    .where('ur.user_id', '=', userId)
    .orderBy('r.code')
    .orderBy('rp.permission_code')
    .execute();
  const roles = new Set<string>();
  const permissions = new Set<string>();
  const grants: PermissionGrantDto[] = [];
  for (const row of rows) {
    roles.add(row.role);
    if (row.permission_code !== null && row.scope !== null) {
      permissions.add(row.permission_code);
      grants.push({
        permission: row.permission_code,
        scope: row.scope as PermissionGrantDto['scope'],
        divisionId: row.division_id,
      });
    }
  }
  return { roles: [...roles], permissions: [...permissions], grants };
}

/**
 * Make sure a `device` row exists for `deviceId` (owner = `userId` on first sight). Returns false
 * when the device was revoked by an admin. A device keeps its first owner when another user later
 * logs in on the same phone.
 */
export async function ensureDevice(
  db: Database | Tx,
  deviceId: string,
  userId: string,
): Promise<boolean> {
  const existing = await db
    .selectFrom('device')
    .select('revoked_at')
    .where('id', '=', deviceId)
    .executeTakeFirst();
  if (existing) return existing.revoked_at === null;
  await db
    .insertInto('device')
    .values({ id: deviceId, user_id: userId })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  return true;
}

/**
 * Resolve a session token to a request context, or null when the token is unknown, revoked,
 * expired (idle or absolute), the user is not ACTIVE, or the device was revoked. Slides the idle
 * expiry (at most every TOUCH_INTERVAL_MINUTES). Registers the device on first use.
 */
export async function resolveSession(
  db: Database,
  token: string,
  headerDeviceId: string | null,
  csrfSecret: string,
): Promise<RequestContext | null> {
  if (!isWellFormedToken(token)) return null;
  const tokenHash = hashToken(token);
  const row = await db
    .selectFrom('session as s')
    .innerJoin('app_user as u', 'u.id', 's.user_id')
    .select([
      's.id',
      's.user_id',
      's.device_id',
      'u.must_change_password',
      sql<boolean>`s.last_seen_at < now() - make_interval(mins => ${TOUCH_INTERVAL_MINUTES})`.as(
        'stale',
      ),
    ])
    .where('s.token_hash', '=', tokenHash)
    .where('s.revoked_at', 'is', null)
    .where(sql<boolean>`s.expires_at > now()`)
    .where(sql<boolean>`s.absolute_expires_at > now()`)
    .where('u.status', '=', 'ACTIVE')
    .executeTakeFirst();
  if (!row) return null;

  const deviceId = headerDeviceId ?? row.device_id;
  if (deviceId !== null && !(await ensureDevice(db, deviceId, row.user_id))) return null;

  if (row.stale) {
    await db
      .updateTable('session')
      .set({
        last_seen_at: sql`now()`,
        expires_at: sql`least(now() + make_interval(days => ${IDLE_EXPIRY_DAYS}), absolute_expires_at)`,
      })
      .where('id', '=', row.id)
      .execute();
  }

  const { roles, permissions, grants } = await loadGrants(db, row.user_id);
  return {
    userId: row.user_id,
    deviceId,
    permissions,
    roles,
    grants,
    sessionId: row.id,
    csrfToken: csrfTokenFor(csrfSecret, tokenHash),
    mustChangePassword: row.must_change_password,
  };
}
