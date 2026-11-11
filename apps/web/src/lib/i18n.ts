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
  'sync.paused': 'Your session expired. Sign in again to continue syncing.',
  'sync.lowStorage':
    'This phone is almost out of storage. Free some space to keep working offline.',
  'syncStatus.LOCAL_ONLY.label': 'On this phone',
  'syncStatus.LOCAL_ONLY.explain': 'Saved on this phone only. It will upload when you are online.',
  'syncStatus.SYNCED.label': 'Synced',
  'syncStatus.SYNCED.explain': 'Saved on the server.',
  'syncStatus.AWAITING_APPROVAL.label': 'Awaiting approval',
  'syncStatus.AWAITING_APPROVAL.explain': 'Uploaded. Waiting for an approver.',
  'syncStatus.AWAITING_TALLY.label': 'Awaiting Tally',
  'syncStatus.AWAITING_TALLY.explain': 'Approved. The office PC will post it to Tally.',
  'syncStatus.POSTED_TO_TALLY.label': 'Posted to Tally',
  'syncStatus.POSTED_TO_TALLY.explain': 'Posted and verified in Tally.',
  'syncStatus.FAILED.label': 'Failed',
  'syncStatus.FAILED.explain':
    'The server rejected this. Open it, fix the problem and send it again.',
  'syncStatus.REQUIRES_RECONCILIATION.label': 'Needs review',
  'syncStatus.REQUIRES_RECONCILIATION.explain':
    'This record changed elsewhere or is locked. An approver has to review it.',
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
