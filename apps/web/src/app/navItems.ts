import type { MessageKey } from '../lib/i18n';

export interface NavItem {
  to: string;
  labelKey: MessageKey;
  /** Shown (and the route reachable) only when the user holds at least one of these. Empty = everyone. */
  anyOf: readonly string[];
}

/**
 * At most 5 items (mobile bottom bar). Permission-aware: the filter is a UI hint, the API
 * authorizes every request. Administration lives under More.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', labelKey: 'nav.home', anyOf: [] },
  { to: '/trips', labelKey: 'nav.trips', anyOf: ['trip.view', 'trip.create'] },
  { to: '/expenses', labelKey: 'nav.expenses', anyOf: ['expense.view', 'expense.create'] },
  {
    to: '/approvals',
    labelKey: 'nav.approvals',
    anyOf: ['expense.approve', 'advance.approve', 'wages.approve', 'inventory.writeoff.approve'],
  },
  { to: '/more', labelKey: 'nav.more', anyOf: [] },
];

export function navItemFor(to: string): NavItem {
  const item = NAV_ITEMS.find((candidate) => candidate.to === to);
  if (item === undefined) {
    throw new Error(`Unknown nav item ${to}`);
  }
  return item;
}
