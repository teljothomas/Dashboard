import { randomBytes } from 'node:crypto';
import { sql, type RawBuilder } from 'kysely';
import type { SessionInfo } from '@tradex/contracts';
import type { Database } from '../../db/index.js';
import { AppError } from '../../errors.js';
import * as audit from '../core/audit.js';
import type { ActorContext, Tx } from '../core/context.js';
import {
  checkPasswordPolicy,
  hashPassword,
  needsRehash,
  PASSWORD_PROBLEM_MESSAGE,
  verifyPassword,
} from './password.js';
import {
  createSession,
  csrfTokenFor,
  ensureDevice,
  loadGrants,
  revokeSession,
  revokeUserSessions,
} from './sessions.js';
import { normalizeUsername } from './users.js';

/** SECURITY section 2: 5 failures / 15 min per username, 20 / 15 min per IP. */
export const LOGIN_WINDOW_MINUTES = 15;
export const LOGIN_MAX_FAILURES_PER_USERNAME = 5;
export const LOGIN_MAX_FAILURES_PER_IP = 20;

export const INVALID_CREDENTIALS_MESSAGE = 'Invalid username or password.';

export interface LoginInput {
  username: string;
  password: string;
  deviceId: string;
  ip: string | null;
  userAgent: string | null;
  requestId: string | undefined;
  /** Session the request already carried, revoked on successful login (no session reuse). */
  previousSessionId: string | null;
  csrfSecret: string;
}

export interface LoginResult {
  /** Raw session token: goes into the cookie only, never into a body or a log. */
  token: string;
  info: SessionInfo;
}

let dummyHash: Promise<string> | undefined;
/** Verified against when the username is unknown, so both paths cost one Argon2 verification. */
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  return dummyHash;
}

function rateLimitedError(retryAfterSeconds: number): AppError {
  return new AppError('RATE_LIMITED', 'Too many failed attempts. Try again later.', {
    retryAfterSeconds,
  });
}

/** Username failures only count after the user's latest successful login. */
function sinceLastSuccess(username: string): RawBuilder<boolean> {
  return sql<boolean>`at > coalesce((select max(at) from login_attempt where username = ${username} and success), '-infinity'::timestamptz)`;
}

/**
 * Seconds until the oldest of the last `max` failures leaves the window, or 0 when fewer than
 * `max` failures are in the window (not blocked).
 */
async function blockedFor(
  tx: Tx,
  column: 'username' | 'ip',
  value: string,
  max: number,
): Promise<number> {
  const rows = await tx
    .selectFrom('login_attempt')
    .select(
      sql<number>`greatest(1, ceil(extract(epoch from (at + make_interval(mins => ${LOGIN_WINDOW_MINUTES}) - now()))))::int`.as(
        'wait',
      ),
    )
    .where(column, '=', value)
    .where('success', '=', false)
    .where(sql<boolean>`at > now() - make_interval(mins => ${LOGIN_WINDOW_MINUTES})`)
    .$if(column === 'username', (qb) => qb.where(sinceLastSuccess(value)))
    .orderBy('at', 'desc')
    .orderBy('id', 'desc')
    .limit(max)
    .execute();
  return rows.length >= max ? (rows[rows.length - 1] as { wait: number }).wait : 0;
}

/**
 * Check the lockout limits and record this attempt as a failure in one serialised step, so
 * parallel guesses cannot all slip under the limit. A successful login flips its own row later.
 * Throws RATE_LIMITED (nothing recorded) when the username or the IP is over its limit.
 */
async function reserveAttempt(
  db: Database,
  username: string,
  ip: string | null,
): Promise<{ attemptId: string; usernameFailures: number }> {
  const key = username.slice(0, 128);
  return db.transaction().execute(async (tx) => {
    // Always username lock first, then IP lock, so two requests can never deadlock.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`login:user:${key}`}, 0))`.execute(
      tx,
    );
    if (ip !== null) {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`login:ip:${ip}`}, 0))`.execute(tx);
    }
    const userWait = await blockedFor(tx, 'username', key, LOGIN_MAX_FAILURES_PER_USERNAME);
    if (userWait > 0) throw rateLimitedError(userWait);
    if (ip !== null) {
      const ipWait = await blockedFor(tx, 'ip', ip, LOGIN_MAX_FAILURES_PER_IP);
      if (ipWait > 0) throw rateLimitedError(ipWait);
    }
    const inserted = await tx
      .insertInto('login_attempt')
      .values({ username: key, ip, success: false })
      .returning('id')
      .executeTakeFirstOrThrow();
    const count = await tx
      .selectFrom('login_attempt')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('username', '=', key)
      .where('success', '=', false)
      .where(sql<boolean>`at > now() - make_interval(mins => ${LOGIN_WINDOW_MINUTES})`)
      .where(sinceLastSuccess(key))
      .executeTakeFirstOrThrow();
    return { attemptId: inserted.id, usernameFailures: count.n };
  });
}

/**
 * Password login. Every failure (unknown user, wrong password, disabled user, revoked device)
 * answers the same 401, costs one Argon2 verification, and is recorded in login_attempt and the
 * audit log. Throws RATE_LIMITED (429 + Retry-After) over the lockout limits.
 */
export async function login(db: Database, input: LoginInput): Promise<LoginResult> {
  const username = normalizeUsername(input.username);
  const { attemptId, usernameFailures } = await reserveAttempt(db, username, input.ip);

  const user = await db
    .selectFrom('app_user')
    .select(['id', 'username', 'display_name', 'password_hash', 'status', 'must_change_password'])
    .where('username', '=', username)
    .executeTakeFirst();

  const verified = await verifyPassword(
    user?.password_hash ?? (await getDummyHash()),
    input.password,
  );
  const ctx: ActorContext = {
    ...(user ? { userId: user.id } : {}),
    deviceId: input.deviceId,
    requestId: input.requestId,
    ip: input.ip ?? undefined,
  };

  let failure: string | null = null;
  if (!user) failure = 'UNKNOWN_USER';
  else if (!verified) failure = 'BAD_PASSWORD';
  else if (user.status !== 'ACTIVE') failure = 'USER_NOT_ACTIVE';

  if (user && failure === null) {
    const rehash = needsRehash(user.password_hash) ? await hashPassword(input.password) : null;
    const done = await db.transaction().execute(async (tx) => {
      if (!(await ensureDevice(tx, input.deviceId, user.id))) return null;
      await tx
        .updateTable('login_attempt')
        .set({ success: true })
        .where('id', '=', attemptId)
        .execute();
      await tx
        .updateTable('app_user')
        .set({ failed_logins: 0, last_login_at: sql`now()` })
        .where('id', '=', user.id)
        .execute();
      if (rehash !== null) {
        await tx
          .updateTable('app_user')
          .set({ password_hash: rehash })
          .where('id', '=', user.id)
          .where('password_hash', '=', user.password_hash)
          .execute();
      }
      if (input.previousSessionId !== null) await revokeSession(tx, input.previousSessionId);
      const session = await createSession(tx, {
        userId: user.id,
        deviceId: input.deviceId,
        userAgent: input.userAgent,
        ip: input.ip,
      });
      await audit.record(tx, {
        action: 'auth.login',
        entityType: 'app_user',
        entityId: user.id,
        before: null,
        after: { session_id: session.id, device_id: input.deviceId, rehashed: rehash !== null },
        ctx,
      });
      return session;
    });
    if (done !== null) {
      const { roles, grants } = await loadGrants(db, user.id);
      return {
        token: done.token,
        info: {
          user: {
            id: user.id,
            username: user.username,
            displayName: user.display_name,
            mustChangePassword: user.must_change_password,
          },
          roles,
          permissions: grants,
          csrfToken: csrfTokenFor(input.csrfSecret, done.tokenHash),
        },
      };
    }
    failure = 'DEVICE_REVOKED';
  }

  const locked = usernameFailures >= LOGIN_MAX_FAILURES_PER_USERNAME;
  await db.transaction().execute(async (tx) => {
    if (user) {
      await tx
        .updateTable('app_user')
        .set({ failed_logins: usernameFailures })
        .where('id', '=', user.id)
        .execute();
    }
    await audit.record(tx, {
      action: 'auth.login.failed',
      entityType: 'app_user',
      // Unknown usernames are never written to the audit log: a mistyped password in the
      // username field would end up there. login_attempt keeps the attempted name (SECURITY 2).
      entityId: user?.id ?? 'unknown',
      before: null,
      after: { reason: failure, locked },
      ctx,
    });
  });
  throw new AppError('UNAUTHENTICATED', INVALID_CREDENTIALS_MESSAGE);
}

/** Revoke the caller's session and audit it. Idempotent. */
export async function logout(db: Database, sessionId: string, ctx: ActorContext): Promise<void> {
  await db.transaction().execute(async (tx) => {
    const revoked = await revokeSession(tx, sessionId);
    if (revoked && ctx.userId !== undefined) {
      await audit.record(tx, {
        action: 'auth.logout',
        entityType: 'app_user',
        entityId: ctx.userId,
        before: null,
        after: { session_id: sessionId },
        ctx,
      });
    }
  });
}

export interface ChangePasswordInput {
  userId: string;
  /** The caller's own session: it survives, every other one is revoked. */
  sessionId: string | null;
  currentPassword: string;
  newPassword: string;
  ctx: ActorContext;
}

/**
 * Change the caller's own password. Verifies the current one, applies the password policy,
 * clears must_change_password, revokes all other sessions of the user and audits (no secrets).
 */
export async function changePassword(db: Database, input: ChangePasswordInput): Promise<void> {
  const user = await db
    .selectFrom('app_user')
    .select(['password_hash'])
    .where('id', '=', input.userId)
    .executeTakeFirstOrThrow();

  if (!(await verifyPassword(user.password_hash, input.currentPassword))) {
    await db.transaction().execute((tx) =>
      audit.record(tx, {
        action: 'auth.password_change.failed',
        entityType: 'app_user',
        entityId: input.userId,
        before: null,
        after: { reason: 'CURRENT_PASSWORD_INCORRECT' },
        ctx: input.ctx,
      }),
    );
    throw new AppError('VALIDATION_FAILED', 'Current password is incorrect.', {
      reason: 'CURRENT_PASSWORD_INCORRECT',
    });
  }
  const problem = checkPasswordPolicy(input.newPassword);
  if (problem !== null) {
    throw new AppError('VALIDATION_FAILED', PASSWORD_PROBLEM_MESSAGE[problem], { reason: problem });
  }
  if (input.newPassword === input.currentPassword) {
    throw new AppError('VALIDATION_FAILED', 'New password must differ from the current one.', {
      reason: 'SAME_AS_CURRENT',
    });
  }
  const newHash = await hashPassword(input.newPassword);

  await db.transaction().execute(async (tx) => {
    await tx
      .updateTable('app_user')
      .set({
        password_hash: newHash,
        must_change_password: false,
        failed_logins: 0,
        locked_until: null,
        updated_by: input.userId,
      })
      .where('id', '=', input.userId)
      .execute();
    const revoked = await revokeUserSessions(tx, input.userId, input.sessionId);
    await audit.record(tx, {
      action: 'auth.password_change',
      entityType: 'app_user',
      entityId: input.userId,
      before: null,
      after: { other_sessions_revoked: revoked },
      ctx: input.ctx,
    });
  });
}

/** Fresh session info for `GET /auth/me`. */
export async function loadSessionInfo(
  db: Database,
  userId: string,
  csrfToken: string,
): Promise<SessionInfo> {
  const user = await db
    .selectFrom('app_user')
    .select(['id', 'username', 'display_name', 'must_change_password'])
    .where('id', '=', userId)
    .executeTakeFirstOrThrow();
  const { roles, grants } = await loadGrants(db, userId);
  return {
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      mustChangePassword: user.must_change_password,
    },
    roles,
    permissions: grants,
    csrfToken,
  };
}
