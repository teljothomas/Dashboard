import { sql, type Expression, type SqlBool } from 'kysely';
import type { PermissionGrantDto } from '@tradex/contracts';
import { AppError } from '../errors.js';
import type { RequestContext } from '../plugins/requestContext.js';

/**
 * Row scope rules (INTERFACES section 3, ADR-052):
 *
 * - `ALL`: every record.
 * - `OWN`: records the caller owns (`created_by = user`, or the owning column the module names).
 * - `DIVISION`: records whose division equals the role assignment's division.
 *
 * `user_role.division_id` is a limiter (DATA_MODEL section 2): NULL means no limiter. A non-null
 * limiter narrows every scope of that assignment to the one division, so an ALL grant limited to
 * MEAT sees MEAT only. `DIVISION` with no division on the assignment covers nothing (fail closed).
 * A limited grant needs the record's division to be known: an unknown division never matches.
 */

/** What a grant is tested against. Omitted or null means "unknown" and never matches a limit. */
export interface ScopeTarget {
  ownerId?: string | null;
  divisionId?: string | null;
}

/** Owner column and division column of the table being listed, as `table.column` references. */
export interface ScopeColumns {
  ownerColumn?: string;
  divisionColumn?: string;
}

/** Role code that may approve its own records (INTERFACES section 3: no self-approval except OWNER). */
export const OWNER_ROLE = 'OWNER';

/** Does one grant cover the target? Pure; the SQL form is `scopeWhere`. */
export function grantCovers(
  grant: PermissionGrantDto,
  userId: string,
  target: ScopeTarget,
): boolean {
  if (grant.divisionId !== null && target.divisionId !== grant.divisionId) return false;
  switch (grant.scope) {
    case 'ALL':
      return true;
    case 'DIVISION':
      return grant.divisionId !== null;
    case 'OWN':
      return target.ownerId !== undefined && target.ownerId !== null && target.ownerId === userId;
  }
}

export function hasPermission(ctx: RequestContext, permission: string): boolean {
  return ctx.permissions.includes(permission);
}

function grantsFor(ctx: RequestContext, permission: string): PermissionGrantDto[] {
  return ctx.grants.filter((grant) => grant.permission === permission);
}

/** True when the caller holds `permission` with a scope that covers the target. */
export function inScope(ctx: RequestContext, permission: string, target: ScopeTarget): boolean {
  return grantsFor(ctx, permission).some((grant) => grantCovers(grant, ctx.userId, target));
}

/** FORBIDDEN when the caller lacks the permission altogether. */
export function assertPermission(ctx: RequestContext, permission: string): void {
  if (!hasPermission(ctx, permission)) {
    throw new AppError('FORBIDDEN', 'Permission denied', { permission });
  }
}

/**
 * FORBIDDEN without the permission; NOT_FOUND when the permission exists but no grant covers the
 * record (out-of-scope records look absent, SECURITY section 3). Services call this for writes and
 * single-record reads whose target is only known after loading the record.
 */
export function assertInScope(ctx: RequestContext, permission: string, target: ScopeTarget): void {
  assertPermission(ctx, permission);
  if (!inScope(ctx, permission, target)) {
    throw new AppError('NOT_FOUND', 'Not found');
  }
}

/**
 * Self-approval guard: the approver must not be the user who created the record. OWNER is exempt.
 * `createdBy` null (system-created) is never self.
 */
export function assertNotSelf(ctx: RequestContext, createdBy: string | null): void {
  if (createdBy === null || createdBy !== ctx.userId) return;
  if (ctx.roles.includes(OWNER_ROLE)) return;
  throw new AppError('FORBIDDEN', 'You cannot approve your own record', {
    reason: 'SELF_APPROVAL',
  });
}

/**
 * Kysely predicate for lists and reads: the rows the caller may see under `permission`. One shared
 * helper, never ad-hoc scope SQL (SECURITY section 3). Use as `.where(scopeWhere(ctx, 'x.view', cols))`.
 * No grant, or no grant that can be expressed with the given columns, yields `false`.
 */
export function scopeWhere(
  ctx: RequestContext,
  permission: string,
  columns: ScopeColumns,
): Expression<SqlBool> {
  const alternatives: Expression<SqlBool>[] = [];
  for (const grant of grantsFor(ctx, permission)) {
    const parts: Expression<SqlBool>[] = [];
    if (grant.divisionId !== null) {
      if (columns.divisionColumn === undefined) continue;
      parts.push(sql<SqlBool>`${sql.ref(columns.divisionColumn)} = ${grant.divisionId}`);
    }
    if (grant.scope === 'DIVISION' && grant.divisionId === null) continue;
    if (grant.scope === 'OWN') {
      if (columns.ownerColumn === undefined) continue;
      parts.push(sql<SqlBool>`${sql.ref(columns.ownerColumn)} = ${ctx.userId}`);
    }
    alternatives.push(
      parts.length === 0 ? sql<SqlBool>`true` : sql<SqlBool>`(${sql.join(parts, sql` and `)})`,
    );
  }
  if (alternatives.length === 0) return sql<SqlBool>`false`;
  return sql<SqlBool>`(${sql.join(alternatives, sql` or `)})`;
}
