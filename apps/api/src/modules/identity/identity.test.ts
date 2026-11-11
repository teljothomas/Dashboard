import { describe, expect, it } from 'vitest';
import {
  defaultGrants,
  PERMISSIONS,
  ROLE_CODES,
  SYSTEM_ROLES,
  type Permission,
} from './catalogue.js';
import {
  ARGON2_PARAMS,
  checkPasswordPolicy,
  hashPassword,
  needsRehash,
  verifyPassword,
} from './password.js';

function grantMap(role: (typeof ROLE_CODES)[number]): Map<Permission, string> {
  return new Map(defaultGrants(role).map((g) => [g.permission, g.scope]));
}

describe('permission catalogue', () => {
  it('has unique codes that match the database CHECK pattern', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
    for (const code of PERMISSIONS) expect(code).toMatch(/^[a-z]+(\.[a-z]+){1,2}$/);
  });

  it('defines the six system roles with unique fixed ids', () => {
    expect(SYSTEM_ROLES.map((r) => r.code)).toEqual([...ROLE_CODES]);
    expect(new Set(SYSTEM_ROLES.map((r) => r.id)).size).toBe(6);
  });
});

describe('default role matrix (INTERFACES section 3)', () => {
  it('gives OWNER every permission at ALL scope', () => {
    const owner = grantMap('OWNER');
    expect(owner.size).toBe(PERMISSIONS.length);
    expect([...owner.values()].every((s) => s === 'ALL')).toBe(true);
  });

  it('gives ADMIN user and settings administration but no financial approvals', () => {
    const admin = grantMap('ADMIN');
    expect([...admin.keys()].sort()).toEqual(
      [
        'audit.view',
        'dashboard.view',
        'roles.manage',
        'settings.manage',
        'tally.connector.manage',
        'tally.data.view',
        'users.manage',
      ].sort(),
    );
    for (const p of [
      'expense.approve',
      'advance.approve',
      'wages.approve',
      'report.financial.view',
    ]) {
      expect(admin.has(p as Permission)).toBe(false);
    }
  });

  it('gives ACCOUNTANT tally, finance, reports and every view, but no user management', () => {
    const acc = grantMap('ACCOUNTANT');
    for (const p of [
      'tally.posting.manage',
      'tally.mapping.approve',
      'finance.edit',
      'recon.edit',
      'report.financial.view',
      'expense.approve',
      'advance.settle',
      'wages.approve',
      'trip.view',
    ] as Permission[]) {
      expect(acc.get(p)).toBe('ALL');
    }
    expect(acc.has('users.manage')).toBe(false);
    expect(acc.has('roles.manage')).toBe(false);
    expect(acc.has('expense.create')).toBe(false);
  });

  it('scopes FACTORY_MANAGER to DIVISION and withholds financial reports', () => {
    const fm = grantMap('FACTORY_MANAGER');
    expect([...fm.values()].every((s) => s === 'DIVISION')).toBe(true);
    expect(fm.has('expense.approve')).toBe(true);
    expect(fm.has('inventory.writeoff.approve')).toBe(true);
    expect(fm.has('report.financial.view')).toBe(false);
    expect(fm.has('tally.data.view')).toBe(false);
  });

  it('limits SUPERVISOR: expense.view OWN, the rest DIVISION, no approvals', () => {
    const sup = grantMap('SUPERVISOR');
    expect(sup.get('expense.view')).toBe('OWN');
    expect(sup.get('trip.create')).toBe('DIVISION');
    expect(sup.get('attendance.record')).toBe('DIVISION');
    for (const p of PERMISSIONS) {
      if (p.endsWith('.approve')) expect(sup.has(p)).toBe(false);
    }
  });

  it('limits DRIVER to OWN scope and keeps financial and Tally data away', () => {
    const drv = grantMap('DRIVER');
    expect([...drv.keys()].sort()).toEqual(
      [
        'advance.create',
        'driver.view',
        'expense.create',
        'expense.view',
        'trip.edit',
        'trip.view',
      ].sort(),
    );
    expect([...drv.values()].every((s) => s === 'OWN')).toBe(true);
  });
});

describe('password policy', () => {
  it('rejects short, over-long and common passwords', () => {
    expect(checkPasswordPolicy('short')).toBe('TOO_SHORT');
    expect(checkPasswordPolicy('x'.repeat(257))).toBe('TOO_LONG');
    expect(checkPasswordPolicy('Password123')).toBe('COMMON');
    expect(checkPasswordPolicy('QWERTYUIOP')).toBe('COMMON');
  });

  it('accepts a long passphrase without composition rules', () => {
    expect(checkPasswordPolicy('correct horse battery staple')).toBeNull();
    expect(checkPasswordPolicy('abcdefghijklmnopqrstuvwxyz'.slice(0, 10) + 'zq')).toBeNull();
  });
});

describe('argon2id hashing', () => {
  it('hashes with the ADR-051 parameters, verifies, and rejects a wrong password', async () => {
    const hash = await hashPassword('a fine passphrase 42');
    expect(hash).toMatch(
      new RegExp(
        `^\\$argon2id\\$v=19\\$m=${String(ARGON2_PARAMS.memoryCost)},t=${String(ARGON2_PARAMS.timeCost)},p=${String(ARGON2_PARAMS.parallelism)}\\$`,
      ),
    );
    expect(await verifyPassword(hash, 'a fine passphrase 42')).toBe(true);
    expect(await verifyPassword(hash, 'a fine passphrase 43')).toBe(false);
    expect(needsRehash(hash)).toBe(false);
  });

  it('treats a malformed hash as a mismatch and flags weak or foreign hashes for rehash', async () => {
    expect(await verifyPassword('not-a-hash', 'whatever password')).toBe(false);
    expect(needsRehash('$argon2id$v=19$m=4096,t=2,p=1$c2FsdA$aGFzaA')).toBe(true);
    expect(needsRehash('$argon2id$v=19$m=19456,t=1,p=1$c2FsdA$aGFzaA')).toBe(true);
    expect(needsRehash('$2b$10$abcdefghijklmnopqrstuv')).toBe(true);
  });
});
