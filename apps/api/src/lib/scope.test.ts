import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { describe, expect, it } from 'vitest';
import type { PermissionGrantDto } from '@tradex/contracts';
import { AppError } from '../errors.js';
import type { RequestContext } from '../plugins/requestContext.js';
import {
  type ScopeColumns,
  assertInScope,
  assertNotSelf,
  assertPermission,
  grantCovers,
  inScope,
  scopeWhere,
} from './scope.js';

const USER = '019a0000-0000-7000-8000-000000000001';
const OTHER = '019a0000-0000-7000-8000-000000000002';
const MEAT = '019a0000-0000-7000-8000-0000000000a1';
const LOGISTICS = '019a0000-0000-7000-8000-0000000000a2';

function ctxOf(grants: PermissionGrantDto[], roles: string[] = []): RequestContext {
  return {
    userId: USER,
    deviceId: null,
    permissions: [...new Set(grants.map((g) => g.permission))],
    roles,
    grants,
    sessionId: null,
    csrfToken: null,
    mustChangePassword: false,
  };
}

const grant = (
  scope: PermissionGrantDto['scope'],
  divisionId: string | null = null,
  permission = 'expense.view',
): PermissionGrantDto => ({ permission, scope, divisionId });

function errorOf(fn: () => void): AppError {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected an AppError');
}

describe('grantCovers', () => {
  it('ALL without limiter covers everything, including unknown owner and division', () => {
    expect(grantCovers(grant('ALL'), USER, {})).toBe(true);
    expect(grantCovers(grant('ALL'), USER, { ownerId: OTHER, divisionId: LOGISTICS })).toBe(true);
  });

  it('OWN covers records owned by the caller only', () => {
    expect(grantCovers(grant('OWN'), USER, { ownerId: USER })).toBe(true);
    expect(grantCovers(grant('OWN'), USER, { ownerId: OTHER })).toBe(false);
    expect(grantCovers(grant('OWN'), USER, {})).toBe(false);
    expect(grantCovers(grant('OWN'), USER, { ownerId: null })).toBe(false);
  });

  it('DIVISION covers the assignment division only; no division means nothing', () => {
    expect(grantCovers(grant('DIVISION', MEAT), USER, { divisionId: MEAT })).toBe(true);
    expect(grantCovers(grant('DIVISION', MEAT), USER, { divisionId: LOGISTICS })).toBe(false);
    expect(grantCovers(grant('DIVISION', MEAT), USER, {})).toBe(false);
    expect(grantCovers(grant('DIVISION'), USER, { divisionId: MEAT })).toBe(false);
  });

  it('a division limiter narrows ALL and OWN too', () => {
    expect(grantCovers(grant('ALL', MEAT), USER, { divisionId: MEAT })).toBe(true);
    expect(grantCovers(grant('ALL', MEAT), USER, { divisionId: LOGISTICS })).toBe(false);
    expect(grantCovers(grant('ALL', MEAT), USER, {})).toBe(false);
    expect(grantCovers(grant('OWN', MEAT), USER, { ownerId: USER, divisionId: MEAT })).toBe(true);
    expect(grantCovers(grant('OWN', MEAT), USER, { ownerId: USER, divisionId: LOGISTICS })).toBe(
      false,
    );
    expect(grantCovers(grant('OWN', MEAT), USER, { ownerId: OTHER, divisionId: MEAT })).toBe(false);
  });
});

describe('inScope and assertInScope', () => {
  const ctx = ctxOf([grant('OWN'), grant('DIVISION', MEAT)]);

  it('any covering grant is enough', () => {
    expect(inScope(ctx, 'expense.view', { ownerId: USER })).toBe(true);
    expect(inScope(ctx, 'expense.view', { ownerId: OTHER, divisionId: MEAT })).toBe(true);
    expect(inScope(ctx, 'expense.view', { ownerId: OTHER, divisionId: LOGISTICS })).toBe(false);
  });

  it('other permissions do not leak into the check', () => {
    expect(inScope(ctx, 'expense.approve', { ownerId: USER })).toBe(false);
  });

  it('FORBIDDEN without the permission, NOT_FOUND when out of scope, silent when in scope', () => {
    expect(errorOf(() => assertInScope(ctx, 'expense.approve', {})).code).toBe('FORBIDDEN');
    expect(errorOf(() => assertInScope(ctx, 'expense.view', { ownerId: OTHER })).code).toBe(
      'NOT_FOUND',
    );
    expect(() => assertInScope(ctx, 'expense.view', { ownerId: USER })).not.toThrow();
  });

  it('assertPermission is FORBIDDEN without any grant', () => {
    expect(errorOf(() => assertPermission(ctx, 'users.manage')).code).toBe('FORBIDDEN');
    expect(() => assertPermission(ctx, 'expense.view')).not.toThrow();
  });
});

describe('assertNotSelf', () => {
  it('blocks approving your own record', () => {
    const error = errorOf(() => assertNotSelf(ctxOf([], ['ACCOUNTANT']), USER));
    expect(error.code).toBe('FORBIDDEN');
    expect(error.details).toEqual({ reason: 'SELF_APPROVAL' });
  });

  it('allows other creators, system-created records and OWNER', () => {
    expect(() => assertNotSelf(ctxOf([], ['ACCOUNTANT']), OTHER)).not.toThrow();
    expect(() => assertNotSelf(ctxOf([], ['ACCOUNTANT']), null)).not.toThrow();
    expect(() => assertNotSelf(ctxOf([], ['OWNER']), USER)).not.toThrow();
  });

  it('ADMIN does not exempt', () => {
    expect(errorOf(() => assertNotSelf(ctxOf([], ['ADMIN', 'ACCOUNTANT']), USER)).code).toBe(
      'FORBIDDEN',
    );
  });
});

describe('scopeWhere', () => {
  const db = new Kysely<{ expense: { id: string; created_by: string; division_id: string } }>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const columns = { ownerColumn: 'expense.created_by', divisionColumn: 'expense.division_id' };

  function compiled(
    ctx: RequestContext,
    cols: ScopeColumns = columns,
  ): { sql: string; parameters: unknown[] } {
    const query = db
      .selectFrom('expense')
      .select('id')
      .where(scopeWhere(ctx, 'expense.view', cols))
      .compile();
    return { sql: query.sql, parameters: [...query.parameters] };
  }

  it('no grant gives false', () => {
    expect(compiled(ctxOf([])).sql).toContain('where false');
  });

  it('ALL gives true', () => {
    expect(compiled(ctxOf([grant('ALL')])).sql).toContain('where (true)');
  });

  it('OWN binds the user id, never interpolates it', () => {
    const { sql, parameters } = compiled(ctxOf([grant('OWN')]));
    expect(sql).toContain('"expense"."created_by" = $1');
    expect(parameters).toEqual([USER]);
    expect(sql).not.toContain(USER);
  });

  it('DIVISION binds the division; alternatives are ORed, parts ANDed', () => {
    const { sql, parameters } = compiled(ctxOf([grant('DIVISION', MEAT), grant('OWN', LOGISTICS)]));
    expect(sql).toContain('"expense"."division_id" = $1');
    expect(sql).toContain('"expense"."division_id" = $2 and "expense"."created_by" = $3');
    expect(sql).toContain(' or ');
    expect(parameters).toEqual([MEAT, LOGISTICS, USER]);
  });

  it('DIVISION without a division on the assignment gives false', () => {
    expect(compiled(ctxOf([grant('DIVISION')])).sql).toContain('where false');
  });

  it('a grant that needs a column the table lacks is dropped (fail closed)', () => {
    expect(
      compiled(ctxOf([grant('OWN')]), { divisionColumn: 'expense.division_id' }).sql,
    ).toContain('where false');
    expect(
      compiled(ctxOf([grant('ALL', MEAT)]), { ownerColumn: 'expense.created_by' }).sql,
    ).toContain('where false');
  });

  it('ignores grants of other permissions', () => {
    expect(compiled(ctxOf([grant('ALL', null, 'expense.approve')])).sql).toContain('where false');
  });
});
