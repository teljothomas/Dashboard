import type { MessageKey } from '../lib/i18n';

export interface NavItem {
  to: string;
  labelKey: MessageKey;
}

/** At most 5 items (mobile bottom bar). Role-driven filtering arrives with Phase 04 permissions. */
export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', labelKey: 'nav.home' },
  { to: '/trips', labelKey: 'nav.trips' },
  { to: '/expenses', labelKey: 'nav.expenses' },
  { to: '/approvals', labelKey: 'nav.approvals' },
  { to: '/more', labelKey: 'nav.more' },
];
