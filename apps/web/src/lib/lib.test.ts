import { describe, expect, it, vi } from 'vitest';
import { t } from './i18n';
import { Money, formatMoney, sumMoney } from './money';
import { createStore } from './store';

describe('money re-export', () => {
  it('formats en-IN rupees through the domain package', () => {
    expect(formatMoney('1234567.5')).toBe('₹12,34,567.50');
    expect(sumMoney([Money.parse('0.1'), Money.parse('0.2')]).toString()).toBe('0.30');
  });

  it('rejects non-decimal strings', () => {
    expect(() => formatMoney('12.345')).toThrow();
  });
});

describe('i18n', () => {
  it('returns English strings and substitutes params', () => {
    expect(t('nav.home')).toBe('Home');
    expect(t('sync.syncing', { count: 4 })).toBe('Syncing 4 items…');
  });
});

describe('store', () => {
  it('notifies subscribers on set and stops after unsubscribe', () => {
    const store = createStore({ n: 0 });
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.set({ n: 1 });
    expect(store.get().n).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    store.set({ n: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
