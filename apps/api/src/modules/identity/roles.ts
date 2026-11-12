import type { CreateRoleRequest, RoleDto, UpdateRoleRequest } from '@tradex/contracts';
import { uuidv7 } from '@tradex/domain';
import type { Database } from '../../db/index.js';
import { AppError } from '../../errors.js';
import * as audit from '../core/audit.js';
import type { Tx } from '../core/context.js';
import { PERMISSIONS } from './catalogue.js';
import { assertGrantablePermissions, type Caller } from './adminUsers.js';

/**
 * Role administration (WP-04.4). System roles are immutable through the API (name and permissions
 * included; the database trigger additionally protects their code and deletion). Custom roles are
 * created and replaced as a whole permission set. A permission change takes effect on the next
 * request of every holder, because grants are loaded per request.
 */

const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set(PERMISSIONS);

interface RoleRow {
  id: string;
  code: string;
  name: string;
  is_system: boolean;
}

function toDto(row: RoleRow, permissions: RoleDto['permissions']): RoleDto {
  return { id: row.id, code: row.code, name: row.name, isSystem: row.is_system, permissions };
}

async function loadPermissions(
  db: Tx,
  roleIds: string[],
): Promise<Map<string, RoleDto['permissions']>> {
  const map = new Map<string, RoleDto['permissions']>();
  if (roleIds.length === 0) return map;
  const rows = await db
    .selectFrom('role_permission')
    .select(['role_id', 'permission_code', 'scope'])
    .where('role_id', 'in', roleIds)
    .orderBy('permission_code')
    .execute();
  for (const row of rows) {
    const list = map.get(row.role_id) ?? [];
    list.push({
      permission: row.permission_code,
      scope: row.scope as RoleDto['permissions'][number]['scope'],
    });
    map.set(row.role_id, list);
  }
  return map;
}

export async function listRoles(db: Tx): Promise<RoleDto[]> {
  const rows = await db
    .selectFrom('role')
    .select(['id', 'code', 'name', 'is_system'])
    .orderBy('is_system', 'desc')
    .orderBy('code')
    .execute();
  const permissions = await loadPermissions(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toDto(row, permissions.get(row.id) ?? []));
}

export async function getRole(db: Tx, id: string): Promise<RoleDto> {
  const row = await db
    .selectFrom('role')
    .select(['id', 'code', 'name', 'is_system'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) throw new AppError('NOT_FOUND', 'Not found');
  const permissions = await loadPermissions(db, [id]);
  return toDto(row, permissions.get(id) ?? []);
}

/** Known catalogue codes, each at most once, sorted for a stable audit diff. */
function checkPermissions(input: RoleDto['permissions']): RoleDto['permissions'] {
  const seen = new Set<string>();
  for (const item of input) {
    if (!KNOWN_PERMISSIONS.has(item.permission)) {
      throw new AppError('VALIDATION_FAILED', `Unknown permission: ${item.permission}`, {
        reason: 'UNKNOWN_PERMISSION',
      });
    }
    if (seen.has(item.permission)) {
      throw new AppError('VALIDATION_FAILED', `Permission listed twice: ${item.permission}`, {
        reason: 'DUPLICATE_PERMISSION',
      });
    }
    seen.add(item.permission);
  }
  return [...input].sort((a, b) => a.permission.localeCompare(b.permission));
}

export async function createRole(
  db: Database,
  caller: Caller,
  input: CreateRoleRequest,
): Promise<RoleDto> {
  const permissions = checkPermissions(input.permissions);
  assertGrantablePermissions(caller, permissions);
  const id = await db.transaction().execute(async (tx) => {
    const roleId = uuidv7();
    const inserted = await tx
      .insertInto('role')
      .values({
        id: roleId,
        code: input.code,
        name: input.name,
        is_system: false,
        created_by: caller.ctx.userId,
        updated_by: caller.ctx.userId,
      })
      .onConflict((oc) => oc.column('code').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!inserted) {
      throw new AppError('VALIDATION_FAILED', 'That role code is already in use.', {
        reason: 'ROLE_CODE_TAKEN',
      });
    }
    if (permissions.length > 0) {
      await tx
        .insertInto('role_permission')
        .values(
          permissions.map((item) => ({
            role_id: roleId,
            permission_code: item.permission,
            scope: item.scope,
          })),
        )
        .execute();
    }
    await audit.record(tx, {
      action: 'role.create',
      entityType: 'role',
      entityId: roleId,
      before: null,
      after: { code: input.code, name: input.name, permissions },
      ctx: caller.actor,
    });
    return roleId;
  });
  return getRole(db, id);
}

export async function updateRole(
  db: Database,
  caller: Caller,
  id: string,
  input: UpdateRoleRequest,
): Promise<RoleDto> {
  const permissions =
    input.permissions === undefined ? undefined : checkPermissions(input.permissions);
  if (permissions !== undefined) assertGrantablePermissions(caller, permissions);
  await db.transaction().execute(async (tx) => {
    const role = await tx
      .selectFrom('role')
      .select(['id', 'code', 'name', 'is_system'])
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!role) throw new AppError('NOT_FOUND', 'Not found');
    if (role.is_system) {
      throw new AppError('FORBIDDEN', 'System roles cannot be changed.', {
        reason: 'SYSTEM_ROLE_IMMUTABLE',
      });
    }
    const before = (await loadPermissions(tx, [id])).get(id) ?? [];
    // A non-owner may neither add an elevated permission nor edit a role that already holds one
    // (renaming included): holders of that role would otherwise answer to a non-owner.
    assertGrantablePermissions(caller, before);
    const beforeState = { name: role.name, permissions: before };
    const afterState = {
      name: input.name ?? role.name,
      permissions: permissions ?? before,
    };

    await tx
      .updateTable('role')
      .set({ name: afterState.name, updated_by: caller.ctx.userId })
      .where('id', '=', id)
      .execute();
    if (permissions !== undefined) {
      await tx.deleteFrom('role_permission').where('role_id', '=', id).execute();
      if (permissions.length > 0) {
        await tx
          .insertInto('role_permission')
          .values(
            permissions.map((item) => ({
              role_id: id,
              permission_code: item.permission,
              scope: item.scope,
            })),
          )
          .execute();
      }
    }
    await audit.record(tx, {
      action: 'role.update',
      entityType: 'role',
      entityId: id,
      before: beforeState,
      after: afterState,
      ctx: caller.actor,
    });
  });
  return getRole(db, id);
}
