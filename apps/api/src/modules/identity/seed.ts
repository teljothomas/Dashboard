import type { Tx } from '../core/index.js';
import { defaultGrants, PERMISSIONS, SYSTEM_ROLES } from './catalogue.js';

export interface SeedResult {
  permissions: number;
  roles: number;
  rolePermissions: number;
}

/**
 * Seed the permission catalogue, the six system roles and the default role matrix. Insert only
 * (ON CONFLICT DO NOTHING): running it again adds what is missing and never changes the scope of an
 * existing grant. A default grant an administrator removed is added back, so run it on install and
 * when the catalogue grows, not on every start. Returns how many rows were inserted (all zero on a
 * repeat run). Run it inside a transaction.
 */
export async function seedIdentity(tx: Tx): Promise<SeedResult> {
  const permissions = await tx
    .insertInto('permission')
    .values(PERMISSIONS.map((code) => ({ code })))
    .onConflict((oc) => oc.column('code').doNothing())
    .returning('code')
    .execute();

  const roles = await tx
    .insertInto('role')
    .values(SYSTEM_ROLES.map((r) => ({ id: r.id, code: r.code, name: r.name, is_system: true })))
    .onConflict((oc) => oc.column('code').doNothing())
    .returning('id')
    .execute();

  const grants = SYSTEM_ROLES.flatMap((r) =>
    defaultGrants(r.code).map((g) => ({
      role_id: r.id,
      permission_code: g.permission,
      scope: g.scope,
    })),
  );
  // Only grant to roles that exist under the fixed id (a role created by hand with a system code
  // but another id is left alone).
  const existing = await tx
    .selectFrom('role')
    .select(['id'])
    .where(
      'id',
      'in',
      SYSTEM_ROLES.map((r) => r.id),
    )
    .execute();
  const known = new Set(existing.map((r) => r.id));
  const rolePermissions = await tx
    .insertInto('role_permission')
    .values(grants.filter((g) => known.has(g.role_id)))
    .onConflict((oc) => oc.columns(['role_id', 'permission_code']).doNothing())
    .returning('role_id')
    .execute();

  return {
    permissions: permissions.length,
    roles: roles.length,
    rolePermissions: rolePermissions.length,
  };
}
