// Single import point so UI code never depends on decimal.js directly (ADR-010).
export { Money, MoneyError, sumMoney } from '@tradex/domain';

import { Money } from '@tradex/domain';

/** Format an API money string for display, e.g. "1234567.5" becomes "₹12,34,567.50". */
export function formatMoney(value: string): string {
  return Money.parse(value).format();
}
