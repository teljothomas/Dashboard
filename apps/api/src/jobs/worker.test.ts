import { describe, expect, it } from 'vitest';
import { JobRegistry } from './registry.js';
import { backoffMs } from './worker.js';

describe('backoffMs', () => {
  it('doubles from the base each attempt', () => {
    expect(backoffMs(1, 5000, 3_600_000)).toBe(5000);
    expect(backoffMs(2, 5000, 3_600_000)).toBe(10_000);
    expect(backoffMs(3, 5000, 3_600_000)).toBe(20_000);
  });

  it('is capped at the maximum', () => {
    expect(backoffMs(20, 5000, 60_000)).toBe(60_000);
  });

  it('treats attempt 0 like the first attempt', () => {
    expect(backoffMs(0, 1000, 60_000)).toBe(1000);
  });
});

describe('JobRegistry', () => {
  it('registers handlers by kind and rejects duplicates', () => {
    const registry = new JobRegistry();
    const handler = (): Promise<void> => Promise.resolve();
    registry.register('a', handler).register('b', handler);
    expect(registry.kinds()).toEqual(['a', 'b']);
    expect(registry.get('a')).toBe(handler);
    expect(registry.get('missing')).toBeUndefined();
    expect(() => registry.register('a', handler)).toThrow(/already registered/);
  });
});
