import { createHash, randomInt } from 'node:crypto';
import { sql, type Updateable } from 'kysely';
import type {
  CreateUserRequest,
  ListUsersQuery,
  ResetCodeResponse,
  RoleAssignmentDto,
  RoleAssignmentInput,
  UpdateUserRequest,
  UserDto,
} from '@tradex/contracts';
import { uuidv7 } from '@tradex/domain';
import type { Database, DB } from '../../db/index.js';
import { AppError } from '../../errors.js';
import type { RequestContext } from '../../plugins/requestContext.js';
import * as audit from '../core/audit.js';
import type { ActorContext, Tx } from '../core/context.js';
import {
  checkPasswordPolicy,
  hashPassword,
  PASSWORD_PROBLEM_MESSAGE,
  type PasswordProblem,
} from './password.js';
import { revokeUserSessions, safeEqual } from './sessions.js';
import {
  normalizeUsername,
  OWNER_BOOTSTRAP_LOCK,
  OWNER_ROLE_CODE,
  USERNAME_MESSAGE,
  USERNAME_PATTERN,
} from './users.js';

/**
 * User administration (WP-04.4, INTERFACES section 2 identity rows). Every function takes the
 * caller's request context for the guards below and the audit actor. Guards, all server side:
 *
 * - Only an OWNER may assign or remove the OWNER role, or touch (edit, disable, unlock, reset,
 *   force-logout) a user who holds it.
 * - Nobody changes their own status or roles, or issues a reset code for themselves.
 * - The last active OWNER cannot be disabled or lose the role (serialised with an advisory lock).
 * - Passwords and reset codes never reach the audit log or a response, except the one-time code.
 */

export interface Caller {
  ctx: RequestContext;
  actor: ActorContext;
}

/** Reset code: 8 characters, no look-alikes (0/O, 1/I/L). 31^8 is about 39.6 bits; 30 minutes, once. */
const RESET_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const RESET_CODE_LENGTH = 8;
export const RESET_CODE_TTL_MINUTES = 30;

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

export function generateResetCode(): string {
  let code = '';
  for (let i = 0; i < RESET_CODE_LENGTH; i += 1) {
    code += RESET_CODE_ALPHABET[randomInt(RESET_CODE_ALPHABET.length)];
  }
  return code;
}

/** Upper-case and drop spaces and hyphens, so a code typed as "abcd-efgh" still matches. */
export function normalizeResetCode(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase();
}

/** Bound to the user so one code can never complete another user's reset. */
export function hashResetCode(userId: string, code: string): string {
  return createHash('sha256').update(`reset-v1:${userId}:${code}`).digest('hex');
}

const isOwner = (ctx: RequestContext): boolean => ctx.roles.includes(OWNER_ROLE_CODE);

function ownerOnly(): AppError {
  return new AppError('FORBIDDEN', 'Only an owner can manage the OWNER role or owner accounts.', {
    reason: 'OWNER_ONLY',
  });
}

function selfModification(): AppError {
  return new AppError('FORBIDDEN', 'You cannot change your own status or roles.', {
    reason: 'SELF_MODIFICATION',
  });
}

function passwordError(problem: PasswordProblem): AppError {
  return new AppError('VALIDATION_FAILED', PASSWORD_PROBLEM_MESSAGE[problem], { reason: problem });
}

export async function loadAssignments(
  db: Tx,
  userIds: string[],
): Promise<Map<string, RoleAssignmentDto[]>> {
  const map = new Map<string, RoleAssignmentDto[]>();
  if (userIds.length === 0) return map;
  const rows = await db
    .selectFrom('user_role as ur')
    .innerJoin('role as r', 'r.id', 'ur.role_id')
    .select(['ur.user_id', 'ur.role_id', 'ur.division_id', 'r.code', 'r.name'])
    .where('ur.user_id', 'in', userIds)
    .orderBy('r.code')
    .orderBy('ur.id')
    .execute();
  for (const row of rows) {
    const list = map.get(row.user_id) ?? [];
    list.push({
      roleId: row.role_id,
      roleCode: row.code,
      roleName: row.name,
      divisionId: row.division_id,
    });
    map.set(row.user_id, list);
  }
  return map;
}

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  phone: string | null;
  status: string;
  must_change_password: boolean;
  last_login_at: Date | null;
  created_at: Date;
}

const USER_COLUMNS = [
  'id',
  'username',
  'display_name',
  'phone',
  'status',
  'must_change_password',
  'last_login_at',
  'created_at',
] as const;

function toUserDto(row: UserRow, roles: RoleAssignmentDto[]): UserDto {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    phone: row.phone,
    status: row.status as UserDto['status'],
    mustChangePassword: row.must_change_password,
    lastLoginAt: row.last_login_at === null ? null : row.last_login_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    roles,
  };
}

/** The user as the API shows it, or NOT_FOUND. */
export async function getUser(db: Tx, id: string): Promise<UserDto> {
  const row = await db
    .selectFrom('app_user')
    .select([...USER_COLUMNS])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) throw new AppError('NOT_FOUND', 'Not found');
  const roles = await loadAssignments(db, [id]);
  return toUserDto(row, roles.get(id) ?? []);
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export async function listUsers(
  db: Tx,
  query: ListUsersQuery,
): Promise<{ items: UserDto[]; nextCursor: string | null }> {
  let qb = db
    .selectFrom('app_user')
    .select([...USER_COLUMNS])
    .orderBy('id')
    .limit(query.limit + 1);
  if (query.status !== undefined) qb = qb.where('status', '=', query.status);
  if (query.after !== undefined) qb = qb.where('id', '>', query.after);
  if (query.q !== undefined) {
    const pattern = `%${escapeLike(query.q.toLowerCase())}%`;
    qb = qb.where((eb) =>
      eb.or([
        eb('username', 'like', pattern),
        eb(sql<string>`lower(display_name)`, 'like', pattern),
      ]),
    );
  }
  const rows = await qb.execute();
  const page = rows.slice(0, query.limit);
  const roles = await loadAssignments(
    db,
    page.map((row) => row.id),
  );
  return {
    items: page.map((row) => toUserDto(row, roles.get(row.id) ?? [])),
    nextCursor: rows.length > query.limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

/** Lock the user row and return it with its role codes. NOT_FOUND when missing. */
async function lockTarget(
  tx: Tx,
  id: string,
): Promise<{
  id: string;
  username: string;
  status: string;
  failed_logins: number;
  roleCodes: string[];
}> {
  const row = await tx
    .selectFrom('app_user')
    .select(['id', 'username', 'status', 'failed_logins'])
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw new AppError('NOT_FOUND', 'Not found');
  const roles = await loadAssignments(tx, [id]);
  return { ...row, roleCodes: (roles.get(id) ?? []).map((role) => role.roleCode) };
}

/** Owner accounts are managed by owners only. */
export function assertManageable(caller: Caller, targetRoleCodes: readonly string[]): void {
  if (targetRoleCodes.includes(OWNER_ROLE_CODE) && !isOwner(caller.ctx)) throw ownerOnly();
}

async function lockOwners(tx: Tx): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(${OWNER_BOOTSTRAP_LOCK})`.execute(tx);
}

/** At least one other ACTIVE owner must remain. Call after `lockOwners`. */
async function assertOwnerRemains(tx: Tx, excludingUserId: string): Promise<void> {
  const row = await tx
    .selectFrom('user_role as ur')
    .innerJoin('role as r', 'r.id', 'ur.role_id')
    .innerJoin('app_user as u', 'u.id', 'ur.user_id')
    .select(sql<number>`count(distinct u.id)::int`.as('n'))
    .where('r.code', '=', OWNER_ROLE_CODE)
    .where('u.status', '=', 'ACTIVE')
    .where('u.id', '!=', excludingUserId)
    .executeTakeFirstOrThrow();
  if (row.n < 1) {
    throw new AppError(
      'INVALID_TRANSITION',
      'The last active owner cannot be disabled or lose the OWNER role.',
      { reason: 'LAST_OWNER' },
    );
  }
}

interface ResolvedAssignment {
  roleId: string;
  roleCode: string;
  divisionId: string | null;
}

const assignmentKey = (roleId: string, divisionId: string | null): string =>
  `${roleId}:${divisionId ?? ''}`;

/** Check role and division ids exist, drop duplicates, and apply the OWNER rule. */
async function resolveAssignments(
  tx: Tx,
  caller: Caller,
  input: readonly RoleAssignmentInput[],
): Promise<ResolvedAssignment[]> {
  const unique = new Map<string, RoleAssignmentInput>();
  for (const item of input) unique.set(assignmentKey(item.roleId, item.divisionId), item);
  const items = [...unique.values()];
  if (items.length === 0) return [];

  const roleIds = [...new Set(items.map((item) => item.roleId))];
  const roles = await tx
    .selectFrom('role')
    .select(['id', 'code'])
    .where('id', 'in', roleIds)
    .execute();
  const codeById = new Map(roles.map((role) => [role.id, role.code]));
  const missingRole = roleIds.find((id) => !codeById.has(id));
  if (missingRole !== undefined) {
    throw new AppError('VALIDATION_FAILED', 'Unknown role.', { reason: 'UNKNOWN_ROLE' });
  }

  const divisionIds = [
    ...new Set(items.map((item) => item.divisionId).filter((id): id is string => id !== null)),
  ];
  if (divisionIds.length > 0) {
    const found = await tx
      .selectFrom('division')
      .select('id')
      .where('id', 'in', divisionIds)
      .execute();
    if (found.length !== divisionIds.length) {
      throw new AppError('VALIDATION_FAILED', 'Unknown division.', { reason: 'UNKNOWN_DIVISION' });
    }
  }

  const resolved = items.map((item) => ({
    roleId: item.roleId,
    roleCode: codeById.get(item.roleId) as string,
    divisionId: item.divisionId,
  }));
  if (resolved.some((item) => item.roleCode === OWNER_ROLE_CODE) && !isOwner(caller.ctx)) {
    throw ownerOnly();
  }
  return resolved;
}

const auditRoles = (list: readonly { roleCode: string; divisionId: string | null }[]) =>
  list.map((item) => ({ role: item.roleCode, division_id: item.divisionId }));

/**
 * Create a user with an administrator-chosen temporary password (policy checked,
 * must_change_password = true) and an optional role set.
 */
export async function createUser(
  db: Database,
  caller: Caller,
  input: CreateUserRequest,
): Promise<UserDto> {
  const username = normalizeUsername(input.username);
  if (!USERNAME_PATTERN.test(username)) throw new AppError('VALIDATION_FAILED', USERNAME_MESSAGE);
  const problem = checkPasswordPolicy(input.password);
  if (problem !== null) throw passwordError(problem);
  const passwordHash = await hashPassword(input.password);
  const phone = input.phone ?? null;

  const id = await db.transaction().execute(async (tx) => {
    const assignments = await resolveAssignments(tx, caller, input.roles);
    const newId = uuidv7();
    const inserted = await tx
      .insertInto('app_user')
      .values({
        id: newId,
        username,
        display_name: input.displayName,
        phone,
        password_hash: passwordHash,
        status: 'ACTIVE',
        must_change_password: true,
        created_by: caller.ctx.userId,
        updated_by: caller.ctx.userId,
      })
      .onConflict((oc) => oc.column('username').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!inserted) {
      throw new AppError('VALIDATION_FAILED', 'That username is already in use.', {
        reason: 'USERNAME_TAKEN',
      });
    }
    if (assignments.length > 0) {
      await tx
        .insertInto('user_role')
        .values(
          assignments.map((item) => ({
            id: uuidv7(),
            user_id: newId,
            role_id: item.roleId,
            division_id: item.divisionId,
            created_by: caller.ctx.userId,
          })),
        )
        .execute();
    }
    await audit.record(tx, {
      action: 'user.create',
      entityType: 'app_user',
      entityId: newId,
      before: null,
      after: {
        username,
        display_name: input.displayName,
        phone,
        status: 'ACTIVE',
        roles: auditRoles(assignments),
      },
      ctx: caller.actor,
    });
    return newId;
  });
  return getUser(db, id);
}

/**
 * Edit a user: display name, phone, status (ACTIVE or DISABLED) and the role set (replaced when
 * given). Disabling revokes every session. Role changes take effect on the next request.
 */
export async function updateUser(
  db: Database,
  caller: Caller,
  id: string,
  input: UpdateUserRequest,
): Promise<UserDto> {
  if (id === caller.ctx.userId && (input.status !== undefined || input.roles !== undefined)) {
    throw selfModification();
  }
  await db.transaction().execute(async (tx) => {
    // Owner-touching changes are serialised so two owners cannot demote each other at once.
    if (input.status !== undefined || input.roles !== undefined) await lockOwners(tx);
    const target = await lockTarget(tx, id);
    assertManageable(caller, target.roleCodes);

    const current = await tx
      .selectFrom('app_user')
      .select(['display_name', 'phone', 'status'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

    const patch: Updateable<DB['app_user']> = { updated_by: caller.ctx.userId };
    if (input.displayName !== undefined) patch.display_name = input.displayName;
    if (input.phone !== undefined) patch.phone = input.phone;
    const profileChanged =
      (input.displayName !== undefined && input.displayName !== current.display_name) ||
      (input.phone !== undefined && input.phone !== current.phone);

    let statusChange: 'disable' | 'enable' | null = null;
    if (input.status !== undefined && input.status !== current.status) {
      statusChange = input.status === 'DISABLED' ? 'disable' : 'enable';
      if (statusChange === 'disable' && target.roleCodes.includes(OWNER_ROLE_CODE)) {
        await assertOwnerRemains(tx, id);
      }
      patch.status = input.status;
    }

    let roleChange: { before: ResolvedAssignment[]; after: ResolvedAssignment[] } | null = null;
    if (input.roles !== undefined) {
      const after = await resolveAssignments(tx, caller, input.roles);
      const existing = await tx
        .selectFrom('user_role as ur')
        .innerJoin('role as r', 'r.id', 'ur.role_id')
        .select(['ur.id', 'ur.role_id', 'ur.division_id', 'r.code'])
        .where('ur.user_id', '=', id)
        .execute();
      const afterKeys = new Set(after.map((item) => assignmentKey(item.roleId, item.divisionId)));
      const beforeKeys = new Set(
        existing.map((row) => assignmentKey(row.role_id, row.division_id)),
      );
      const removed = existing.filter(
        (row) => !afterKeys.has(assignmentKey(row.role_id, row.division_id)),
      );
      const added = after.filter(
        (item) => !beforeKeys.has(assignmentKey(item.roleId, item.divisionId)),
      );
      if (removed.length > 0 || added.length > 0) {
        const losesOwner =
          removed.some((row) => row.code === OWNER_ROLE_CODE) &&
          !after.some((item) => item.roleCode === OWNER_ROLE_CODE);
        if (losesOwner && target.status === 'ACTIVE' && statusChange !== 'disable') {
          await assertOwnerRemains(tx, id);
        }
        if (removed.length > 0) {
          await tx
            .deleteFrom('user_role')
            .where(
              'id',
              'in',
              removed.map((row) => row.id),
            )
            .execute();
        }
        if (added.length > 0) {
          await tx
            .insertInto('user_role')
            .values(
              added.map((item) => ({
                id: uuidv7(),
                user_id: id,
                role_id: item.roleId,
                division_id: item.divisionId,
                created_by: caller.ctx.userId,
              })),
            )
            .execute();
        }
        roleChange = {
          before: existing.map((row) => ({
            roleId: row.role_id,
            roleCode: row.code,
            divisionId: row.division_id,
          })),
          after,
        };
      }
    }

    await tx.updateTable('app_user').set(patch).where('id', '=', id).execute();

    if (profileChanged) {
      await audit.record(tx, {
        action: 'user.update',
        entityType: 'app_user',
        entityId: id,
        before: { display_name: current.display_name, phone: current.phone },
        after: {
          display_name: input.displayName ?? current.display_name,
          phone: input.phone === undefined ? current.phone : input.phone,
        },
        ctx: caller.actor,
      });
    }
    if (statusChange !== null) {
      const revoked = statusChange === 'disable' ? await revokeUserSessions(tx, id, null) : 0;
      await audit.record(tx, {
        action: statusChange === 'disable' ? 'user.disable' : 'user.enable',
        entityType: 'app_user',
        entityId: id,
        before: { status: current.status },
        after: {
          status: input.status,
          ...(statusChange === 'disable' ? { sessions_revoked: revoked } : {}),
        },
        ctx: caller.actor,
      });
    }
    if (roleChange !== null) {
      await audit.record(tx, {
        action: 'user.roles.change',
        entityType: 'app_user',
        entityId: id,
        before: { roles: auditRoles(roleChange.before) },
        after: { roles: auditRoles(roleChange.after) },
        ctx: caller.actor,
      });
    }
  });
  return getUser(db, id);
}

/**
 * Admin unlock. The lockout is derived from recent failed login_attempt rows, so a successful
 * attempt row is inserted to supersede them (the failures stay for forensics).
 */
export async function unlockUser(db: Database, caller: Caller, id: string): Promise<void> {
  await db.transaction().execute(async (tx) => {
    const target = await lockTarget(tx, id);
    assertManageable(caller, target.roleCodes);
    await tx
      .insertInto('login_attempt')
      .values({ username: target.username, ip: null, success: true })
      .execute();
    await tx
      .updateTable('app_user')
      .set({ failed_logins: 0, locked_until: null, updated_by: caller.ctx.userId })
      .where('id', '=', id)
      .execute();
    await audit.record(tx, {
      action: 'user.unlock',
      entityType: 'app_user',
      entityId: id,
      before: null,
      after: { previous_failed_logins: target.failed_logins },
      ctx: caller.actor,
    });
  });
}

/**
 * Issue a one-time reset code for an ACTIVE user (never for yourself: use change-password). Earlier
 * unused codes of the user stop working. Only the hash is stored; the code is returned once.
 */
export async function issueResetCode(
  db: Database,
  caller: Caller,
  id: string,
): Promise<ResetCodeResponse> {
  if (id === caller.ctx.userId) {
    throw new AppError('FORBIDDEN', 'Use change password for your own account.', {
      reason: 'SELF_MODIFICATION',
    });
  }
  const code = generateResetCode();
  const codeHash = hashResetCode(id, code);
  const issued = await db.transaction().execute(async (tx) => {
    const target = await lockTarget(tx, id);
    assertManageable(caller, target.roleCodes);
    if (target.status !== 'ACTIVE') {
      throw new AppError('INVALID_TRANSITION', 'The user is not active.', {
        reason: 'USER_NOT_ACTIVE',
      });
    }
    await tx
      .updateTable('password_reset')
      .set({ expires_at: sql`now()` })
      .where('user_id', '=', id)
      .where('used_at', 'is', null)
      .where(sql<boolean>`expires_at > now()`)
      .execute();
    const resetId = uuidv7();
    const row = await tx
      .insertInto('password_reset')
      .values({
        id: resetId,
        user_id: id,
        code_hash: codeHash,
        expires_at: sql`now() + make_interval(mins => ${RESET_CODE_TTL_MINUTES})`,
        issued_by: caller.ctx.userId,
      })
      .returning('expires_at')
      .executeTakeFirstOrThrow();
    await audit.record(tx, {
      action: 'user.reset_code.issue',
      entityType: 'app_user',
      entityId: id,
      before: null,
      after: { reset_id: resetId, expires_at: row.expires_at },
      ctx: caller.actor,
    });
    return row;
  });
  return { code, expiresAt: issued.expires_at.toISOString() };
}

export const RESET_CODE_INVALID_MESSAGE = 'The reset code is invalid or has expired.';

export interface CompleteResetInput {
  username: string;
  code: string;
  newPassword: string;
  ip: string | null;
  requestId: string | undefined;
}

/**
 * Complete a reset with the admin-issued code (public route). Every failure for the caller looks the
 * same (VALIDATION_FAILED, reason RESET_CODE_INVALID): unknown user, disabled user, no live code,
 * wrong code. The password policy is checked first so a policy error says nothing about the user.
 * Success: code consumed (single use, claimed with a conditional update), password replaced,
 * must_change_password cleared (the user just chose it), every session revoked, lockout superseded.
 */
export async function completePasswordReset(
  db: Database,
  input: CompleteResetInput,
): Promise<void> {
  const problem = checkPasswordPolicy(input.newPassword);
  if (problem !== null) throw passwordError(problem);

  const username = normalizeUsername(input.username);
  const code = normalizeResetCode(input.code);
  const user = await db
    .selectFrom('app_user')
    .select(['id', 'status'])
    .where('username', '=', username)
    .executeTakeFirst();
  const reset =
    user && user.status === 'ACTIVE'
      ? await db
          .selectFrom('password_reset')
          .select(['id', 'code_hash'])
          .where('user_id', '=', user.id)
          .where('used_at', 'is', null)
          .where(sql<boolean>`expires_at > now()`)
          .orderBy('created_at', 'desc')
          .orderBy('id', 'desc')
          .limit(1)
          .executeTakeFirst()
      : undefined;

  // Always compare, so a missing user or code costs the same as a wrong one.
  const expected = reset?.code_hash ?? '0'.repeat(64);
  const matches = safeEqual(hashResetCode(user?.id ?? ZERO_UUID, code), expected);
  const invalid = (): AppError =>
    new AppError('VALIDATION_FAILED', RESET_CODE_INVALID_MESSAGE, { reason: 'RESET_CODE_INVALID' });
  const actor: ActorContext = {
    ...(user ? { userId: user.id } : {}),
    requestId: input.requestId,
    ip: input.ip ?? undefined,
  };

  if (!user || !reset || !matches) {
    if (user) {
      // Unknown usernames are never written to the audit log (see auth.ts login failures).
      const reason =
        user.status !== 'ACTIVE' ? 'USER_NOT_ACTIVE' : !reset ? 'NO_LIVE_CODE' : 'BAD_CODE';
      await db.transaction().execute((tx) =>
        audit.record(tx, {
          action: 'auth.password_reset.failed',
          entityType: 'app_user',
          entityId: user.id,
          before: null,
          after: { reason },
          ctx: { ...actor, userId: undefined },
        }),
      );
    }
    throw invalid();
  }

  const newHash = await hashPassword(input.newPassword);
  await db.transaction().execute(async (tx) => {
    const claimed = await tx
      .updateTable('password_reset')
      .set({ used_at: sql`now()` })
      .where('id', '=', reset.id)
      .where('used_at', 'is', null)
      .where(sql<boolean>`expires_at > now()`)
      .executeTakeFirst();
    if (Number(claimed.numUpdatedRows) !== 1) throw invalid();
    await tx
      .updateTable('app_user')
      .set({
        password_hash: newHash,
        must_change_password: false,
        failed_logins: 0,
        locked_until: null,
        updated_by: user.id,
      })
      .where('id', '=', user.id)
      .execute();
    const revoked = await revokeUserSessions(tx, user.id, null);
    await tx.insertInto('login_attempt').values({ username, ip: null, success: true }).execute();
    await audit.record(tx, {
      action: 'auth.password_reset.complete',
      entityType: 'app_user',
      entityId: user.id,
      before: null,
      after: { reset_id: reset.id, sessions_revoked: revoked },
      ctx: actor,
    });
  });
}
