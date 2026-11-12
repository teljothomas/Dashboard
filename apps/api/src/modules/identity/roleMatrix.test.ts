import { describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLE_CODES, defaultGrants, type Scope } from './catalogue.js';

/**
 * TS-S01 baseline (WP-04.6): the default role matrix is pinned. A change to who holds what is a
 * security change, so it must show up as a reviewed diff of the snapshot, never pass silently.
 */

function grouped(role: (typeof ROLE_CODES)[number]): Record<Scope, string[]> {
  const out: Record<Scope, string[]> = { ALL: [], DIVISION: [], OWN: [] };
  for (const { permission, scope } of defaultGrants(role)) out[scope].push(permission);
  for (const scope of Object.keys(out) as Scope[]) out[scope].sort();
  return out;
}

describe('default role matrix (TS-S01)', () => {
  it('matches the reviewed snapshot for every system role', () => {
    const snapshot = Object.fromEntries(ROLE_CODES.map((code) => [code, grouped(code)]));
    expect(snapshot).toMatchSnapshot();
  });

  it('DRIVER lacks report.financial.view and every other financial or admin permission', () => {
    const held = new Set(defaultGrants('DRIVER').map((g) => g.permission));
    for (const forbidden of [
      'report.financial.view',
      'report.operational.view',
      'finance.view',
      'finance.edit',
      'users.manage',
      'roles.manage',
      'settings.manage',
      'audit.view',
      'tally.data.view',
      'tally.posting.manage',
      'expense.approve',
      'advance.approve',
      'wages.approve',
    ]) {
      expect(held.has(forbidden as (typeof PERMISSIONS)[number]), forbidden).toBe(false);
    }
  });

  it('DRIVER holds only OWN scope', () => {
    expect(new Set(defaultGrants('DRIVER').map((g) => g.scope))).toEqual(new Set(['OWN']));
  });

  it('only OWNER and ACCOUNTANT hold report.financial.view; only OWNER holds everything', () => {
    const holders = ROLE_CODES.filter((code) =>
      defaultGrants(code).some((g) => g.permission === 'report.financial.view'),
    );
    expect(holders).toEqual(['OWNER', 'ACCOUNTANT']);
    const owner = new Set(defaultGrants('OWNER').map((g) => g.permission));
    expect(owner.size).toBe(PERMISSIONS.length);
    for (const code of ROLE_CODES.filter((c) => c !== 'OWNER')) {
      expect(defaultGrants(code).length, code).toBeLessThan(PERMISSIONS.length);
    }
  });

  it('only OWNER and ADMIN hold users.manage and roles.manage', () => {
    for (const permission of ['users.manage', 'roles.manage'] as const) {
      const holders = ROLE_CODES.filter((code) =>
        defaultGrants(code).some((g) => g.permission === permission),
      );
      expect(holders, permission).toEqual(['OWNER', 'ADMIN']);
    }
  });
});
