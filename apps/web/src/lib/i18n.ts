/** Minimal key-based strings. English only (OD-041); keys let a second language be added later. */
const en = {
  'app.name': 'TradeX ERP',
  'nav.home': 'Home',
  'nav.trips': 'Trips',
  'nav.expenses': 'Expenses',
  'nav.approvals': 'Approvals',
  'nav.more': 'More',
  'nav.label': 'Main navigation',
  'page.home.title': 'Home',
  'page.trips.title': 'Trips',
  'page.expenses.title': 'Expenses',
  'page.approvals.title': 'Approvals',
  'page.more.title': 'More',
  'page.placeholder.body': 'This section is built in a later phase.',
  'page.notFound.title': 'Page not found',
  'sync.offline':
    'You are offline. Changes are saved on this phone only and upload when you are back online.',
  'sync.syncing': 'Syncing {count} items…',
  'sync.attention': '{count} items need attention',
} as const;

export type MessageKey = keyof typeof en;

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  let text: string = en[key];
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}
