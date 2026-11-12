import { sql } from 'kysely';
import type { DeviceDto, SessionDto } from '@tradex/contracts';
import type { Database } from '../../db/index.js';
import { AppError } from '../../errors.js';
import * as audit from '../core/audit.js';
import type { Tx } from '../core/context.js';
import { assertManageable, type Caller } from './adminUsers.js';
import { revokeSession, revokeUserSessions } from './sessions.js';

/**
 * Session and device administration (WP-04.4): list, force logout, revoke a device. All of it
 * needs users.manage; owner accounts (and sessions or devices they use) need an OWNER caller.
 */

async function requireUser(db: Tx, id: string): Promise<void> {
  const row = await db.selectFrom('app_user').select('id').where('id', '=', id).executeTakeFirst();
  if (!row) throw new AppError('NOT_FOUND', 'Not found');
}

/** Live sessions only: not revoked, inside both expiries. */
export async function listUserSessions(db: Tx, userId: string): Promise<SessionDto[]> {
  await requireUser(db, userId);
  const rows = await db
    .selectFrom('session')
    .select([
      'id',
      'user_id',
      'device_id',
      'created_at',
      'last_seen_at',
      'expires_at',
      'user_agent',
      'ip',
    ])
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .where(sql<boolean>`expires_at > now()`)
    .where(sql<boolean>`absolute_expires_at > now()`)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    deviceId: row.device_id,
    createdAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    userAgent: row.user_agent,
    ip: row.ip,
  }));
}

export async function listUserDevices(db: Tx, userId: string): Promise<DeviceDto[]> {
  await requireUser(db, userId);
  const rows = await db
    .selectFrom('device')
    .selectAll()
    .where('user_id', '=', userId)
    .orderBy('first_seen_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    label: row.label,
    platform: row.platform,
    firstSeenAt: row.first_seen_at.toISOString(),
    lastSyncAt: row.last_sync_at === null ? null : row.last_sync_at.toISOString(),
    revokedAt: row.revoked_at === null ? null : row.revoked_at.toISOString(),
  }));
}

/** Force-logout one session. Returns false when it was already revoked. */
export async function revokeSessionById(
  db: Database,
  caller: Caller,
  sessionId: string,
): Promise<boolean> {
  return db.transaction().execute(async (tx) => {
    const session = await tx
      .selectFrom('session')
      .select(['id', 'user_id'])
      .where('id', '=', sessionId)
      .executeTakeFirst();
    if (!session) throw new AppError('NOT_FOUND', 'Not found');
    await assertManageable(tx, caller, [session.user_id]);
    const revoked = await revokeSession(tx, sessionId);
    if (revoked) {
      await audit.record(tx, {
        action: 'session.revoke',
        entityType: 'session',
        entityId: sessionId,
        before: null,
        after: { user_id: session.user_id },
        ctx: caller.actor,
      });
    }
    return revoked;
  });
}

/** Force-logout every live session of the user. Returns how many were revoked. */
export async function revokeAllUserSessions(
  db: Database,
  caller: Caller,
  userId: string,
): Promise<number> {
  return db.transaction().execute(async (tx) => {
    await requireUser(tx, userId);
    await assertManageable(tx, caller, [userId]);
    const count = await revokeUserSessions(tx, userId, null);
    await audit.record(tx, {
      action: 'user.sessions.revoke',
      entityType: 'app_user',
      entityId: userId,
      before: null,
      after: { sessions_revoked: count },
      ctx: caller.actor,
    });
    return count;
  });
}

/**
 * Revoke a device: it can no longer log in or use a session, and every live session on it ends.
 * Idempotent (a second call only sweeps leftover sessions). The device's owner and the users of
 * its sessions must all be manageable by the caller.
 */
export async function revokeDevice(
  db: Database,
  caller: Caller,
  deviceId: string,
): Promise<{ sessionsRevoked: number }> {
  return db.transaction().execute(async (tx) => {
    const device = await tx
      .selectFrom('device')
      .select(['id', 'user_id', 'revoked_at'])
      .where('id', '=', deviceId)
      .forUpdate()
      .executeTakeFirst();
    if (!device) throw new AppError('NOT_FOUND', 'Not found');

    const sessions = await tx
      .selectFrom('session')
      .select(['id', 'user_id'])
      .where('device_id', '=', deviceId)
      .where('revoked_at', 'is', null)
      .execute();
    const affected = [...new Set([device.user_id, ...sessions.map((row) => row.user_id)])];
    await assertManageable(tx, caller, affected);

    if (device.revoked_at === null) {
      await tx
        .updateTable('device')
        .set({ revoked_at: sql`now()` })
        .where('id', '=', deviceId)
        .execute();
    }
    let sessionsRevoked = 0;
    for (const session of sessions) {
      if (await revokeSession(tx, session.id)) sessionsRevoked += 1;
    }
    if (device.revoked_at === null || sessionsRevoked > 0) {
      await audit.record(tx, {
        action: 'device.revoke',
        entityType: 'device',
        entityId: deviceId,
        before: { revoked: device.revoked_at !== null },
        after: { revoked: true, user_id: device.user_id, sessions_revoked: sessionsRevoked },
        ctx: caller.actor,
      });
    }
    return { sessionsRevoked };
  });
}
