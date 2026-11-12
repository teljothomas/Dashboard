import { describe, expect, it } from 'vitest';
import { ELEVATED_PERMISSIONS, PERMISSIONS, isElevatedPermission } from './catalogue.js';

describe('elevated permission registry (deny by default)', () => {
  it('treats finance, reconciliation, Tally data and mapping, settlement and reports as elevated', () => {
    for (const code of [
      'finance.view',
      'finance.edit',
      'recon.edit',
      'advance.settle',
      'tally.mapping.edit',
      'tally.data.view',
      'report.operational.view',
      'report.financial.view',
      'users.manage',
      'roles.manage',
      'audit.view',
    ]) {
      expect(isElevatedPermission(code), code).toBe(true);
    }
  });

  it('never classifies an approval permission as standard', () => {
    for (const code of PERMISSIONS.filter((c) => c.endsWith('.approve'))) {
      expect(ELEVATED_PERMISSIONS, code).toContain(code);
    }
  });

  it('treats an unknown permission code as not elevated only because it is not grantable at all', () => {
    expect(isElevatedPermission('not.a.permission')).toBe(false);
    expect(PERMISSIONS).not.toContain('not.a.permission');
  });

  it('keeps the standard set to the operational permissions', () => {
    const standard = PERMISSIONS.filter((code) => !isElevatedPermission(code));
    expect(standard).toEqual([
      'party.view',
      'party.edit',
      'inventory.view',
      'inventory.edit',
      'factory.view',
      'factory.edit',
      'labour.view',
      'labour.edit',
      'attendance.record',
      'wages.calculate',
      'driver.view',
      'driver.edit',
      'fleet.view',
      'fleet.edit',
      'trip.view',
      'trip.create',
      'trip.edit',
      'trip.close',
      'expense.create',
      'expense.view',
      'advance.create',
      'recon.view',
      'dashboard.view',
    ]);
  });
});
