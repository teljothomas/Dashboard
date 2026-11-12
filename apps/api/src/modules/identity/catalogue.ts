/**
 * Permission catalogue and default role matrix (INTERFACES section 3). Single source of truth for
 * the seed and for the `Permission` type used by `authorize()` (WP-04.3).
 */

export const PERMISSIONS = [
  'users.manage',
  'roles.manage',
  'settings.manage',
  'audit.view',
  'tally.connector.manage',
  'tally.data.view',
  'tally.mapping.edit',
  'tally.mapping.approve',
  'tally.posting.manage',
  'party.view',
  'party.edit',
  'inventory.view',
  'inventory.edit',
  'inventory.writeoff.approve',
  'factory.view',
  'factory.edit',
  'labour.view',
  'labour.edit',
  'attendance.record',
  'wages.calculate',
  'wages.approve',
  'driver.view',
  'driver.edit',
  'fleet.view',
  'fleet.edit',
  'finance.view',
  'finance.edit',
  'trip.view',
  'trip.create',
  'trip.edit',
  'trip.close',
  'expense.create',
  'expense.view',
  'expense.approve',
  'advance.create',
  'advance.approve',
  'advance.settle',
  'recon.view',
  'recon.edit',
  'report.operational.view',
  'report.financial.view',
  'dashboard.view',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Elevated permissions (REV-04 finding 1): administration, financial reporting and every approval.
 * Only an OWNER may put one into a custom role, assign a role that holds one, or manage a user who
 * holds one. Without this rule an ADMIN (users.manage + roles.manage) could mint itself, or a
 * colleague whose password it controls, every power of the system except OWNER.
 */
/**
 * Deny by default (security review of REV-04 fix): only the permissions named here are standard,
 * i.e. an ADMIN may put them into a custom role. Every other permission, including any added to
 * `PERMISSIONS` later and not listed here, is elevated and OWNER-only. Finance, reconciliation,
 * Tally data and mapping, advance settlement, operational reports and every approval are therefore
 * elevated.
 */
const STANDARD_PERMISSIONS: readonly Permission[] = [
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
];

export const ELEVATED_PERMISSIONS: readonly Permission[] = PERMISSIONS.filter(
  (code) => !STANDARD_PERMISSIONS.includes(code),
);

const ELEVATED_SET: ReadonlySet<string> = new Set(ELEVATED_PERMISSIONS);

export function isElevatedPermission(code: string): boolean {
  return ELEVATED_SET.has(code);
}

export const SCOPES = ['OWN', 'DIVISION', 'ALL'] as const;
export type Scope = (typeof SCOPES)[number];

export const ROLE_CODES = [
  'OWNER',
  'ADMIN',
  'ACCOUNTANT',
  'FACTORY_MANAGER',
  'SUPERVISOR',
  'DRIVER',
] as const;
export type RoleCode = (typeof ROLE_CODES)[number];

export interface SystemRole {
  /** Fixed uuid v7 values so every environment agrees on the system role ids. */
  id: string;
  code: RoleCode;
  name: string;
}

export const SYSTEM_ROLES: readonly SystemRole[] = [
  { id: '01930000-0000-7000-8000-0000000000b1', code: 'OWNER', name: 'Owner' },
  { id: '01930000-0000-7000-8000-0000000000b2', code: 'ADMIN', name: 'Administrator' },
  { id: '01930000-0000-7000-8000-0000000000b3', code: 'ACCOUNTANT', name: 'Accountant' },
  { id: '01930000-0000-7000-8000-0000000000b4', code: 'FACTORY_MANAGER', name: 'Factory manager' },
  { id: '01930000-0000-7000-8000-0000000000b5', code: 'SUPERVISOR', name: 'Supervisor' },
  { id: '01930000-0000-7000-8000-0000000000b6', code: 'DRIVER', name: 'Driver' },
];

/** A grant rule: an exact code, `prefix.*` (code starts with `prefix.`) or `*.suffix`. */
type Pattern = string;

interface Grant {
  patterns: readonly Pattern[];
  scope: Scope;
}

/**
 * Default matrix, transcribed from INTERFACES section 3. When two grants of one role match the same
 * permission the first one listed wins (put the narrower scope first). SUPERVISOR: expense.view is
 * OWN, the rest DIVISION (the table gives OWN for expense.view and DIVISION for the role's other
 * grants). Approval thresholds are not part of the matrix (`approval_policy`, OD-042).
 */
const MATRIX: Record<RoleCode, readonly Grant[]> = {
  OWNER: [{ patterns: ['*'], scope: 'ALL' }],
  ADMIN: [
    {
      patterns: [
        'users.manage',
        'roles.manage',
        'settings.manage',
        'audit.view',
        'tally.connector.manage',
        'tally.data.view',
        'dashboard.view',
      ],
      scope: 'ALL',
    },
  ],
  ACCOUNTANT: [
    {
      patterns: [
        'tally.*',
        'party.*',
        'expense.view',
        'expense.approve',
        'advance.approve',
        'advance.settle',
        'wages.approve',
        'finance.*',
        'recon.*',
        'report.*',
        'dashboard.view',
        '*.view',
      ],
      scope: 'ALL',
    },
  ],
  FACTORY_MANAGER: [
    {
      patterns: [
        'inventory.*',
        'factory.*',
        'labour.*',
        'attendance.record',
        'wages.calculate',
        'expense.create',
        'expense.view',
        'expense.approve',
        'advance.create',
        'report.operational.view',
        'dashboard.view',
      ],
      scope: 'DIVISION',
    },
  ],
  SUPERVISOR: [
    { patterns: ['expense.view'], scope: 'OWN' },
    {
      patterns: [
        'attendance.record',
        'factory.edit',
        'inventory.edit',
        'trip.create',
        'trip.edit',
        'fleet.view',
        'expense.create',
        'advance.create',
      ],
      scope: 'DIVISION',
    },
  ],
  DRIVER: [
    {
      patterns: [
        'trip.view',
        'trip.edit',
        'expense.create',
        'expense.view',
        'advance.create',
        'driver.view',
      ],
      scope: 'OWN',
    },
  ],
};

function matches(pattern: Pattern, code: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return code.startsWith(pattern.slice(0, -1));
  if (pattern.startsWith('*.')) return code.endsWith(pattern.slice(1));
  return pattern === code;
}

/** Expand the default matrix to concrete (permission, scope) pairs for one role. */
export function defaultGrants(role: RoleCode): { permission: Permission; scope: Scope }[] {
  const out = new Map<Permission, Scope>();
  for (const grant of MATRIX[role]) {
    for (const pattern of grant.patterns) {
      const hits = PERMISSIONS.filter((code) => matches(pattern, code));
      if (hits.length === 0) {
        // A typo in the matrix must fail loudly, not silently grant nothing.
        throw new Error(`role matrix pattern matches no permission: ${role} ${pattern}`);
      }
      for (const code of hits) {
        if (!out.has(code)) out.set(code, grant.scope);
      }
    }
  }
  return [...out].map(([permission, scope]) => ({ permission, scope }));
}
