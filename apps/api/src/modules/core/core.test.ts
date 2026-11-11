import { describe, expect, it } from 'vitest';
import { AppError } from '../../errors.js';
import { shallowDiff } from './audit.js';
import { fiscalYearOf } from './numbers.js';
import { SETTING_SCHEMAS } from './settings.js';

describe('shallowDiff', () => {
  it('keeps only changed top-level keys with old and new values', () => {
    const diff = shallowDiff({ a: 1, b: 'x', c: true }, { a: 1, b: 'y', c: true });
    expect(diff).toEqual({ before: { b: 'x' }, after: { b: 'y' } });
  });

  it('records added and removed keys on the side that has them', () => {
    const diff = shallowDiff({ gone: 1, same: 2 }, { added: 3, same: 2 });
    expect(diff).toEqual({ before: { gone: 1 }, after: { added: 3 } });
  });

  it('compares nested values deeply but does not recurse into keys', () => {
    const diff = shallowDiff({ n: { x: 1, y: 2 } }, { n: { x: 1, y: 3 } });
    expect(diff).toEqual({ before: { n: { x: 1, y: 2 } }, after: { n: { x: 1, y: 3 } } });
    expect(shallowDiff({ n: { x: 1 } }, { n: { x: 1 } })).toEqual({ before: {}, after: {} });
  });

  it('keeps each side whole when one side is missing', () => {
    expect(shallowDiff(null, { a: 1 })).toEqual({ before: null, after: { a: 1 } });
    expect(shallowDiff({ a: 1 }, undefined)).toEqual({ before: { a: 1 }, after: null });
    expect(shallowDiff(undefined, undefined)).toEqual({ before: null, after: null });
  });

  it('normalises dates and drops undefined values', () => {
    const at = new Date('2026-04-01T00:00:00.000Z');
    const diff = shallowDiff({ at, u: undefined }, { at: '2026-04-01T00:00:00.000Z' });
    expect(diff).toEqual({ before: {}, after: {} });
  });
});

describe('fiscalYearOf', () => {
  it('uses the calendar year when the date is on or after the FY start month', () => {
    expect(fiscalYearOf('2026-04-01', 4)).toBe(2026);
    expect(fiscalYearOf('2026-12-31', 4)).toBe(2026);
  });

  it('uses the previous calendar year before the FY start month', () => {
    expect(fiscalYearOf('2027-03-31', 4)).toBe(2026);
    expect(fiscalYearOf('2026-01-01', 4)).toBe(2025);
  });

  it('follows a January FY start', () => {
    expect(fiscalYearOf('2026-01-01', 1)).toBe(2026);
    expect(fiscalYearOf('2025-12-31', 1)).toBe(2025);
  });

  it.each(['2026-02-30', '2026-13-01', '2026-00-10', '2026-04-31', '26-04-01', '2026/04/01', ''])(
    'rejects %j',
    (value) => {
      expect(() => fiscalYearOf(value, 4)).toThrow(AppError);
    },
  );

  it('accepts 29 February only in leap years', () => {
    expect(fiscalYearOf('2028-02-29', 4)).toBe(2027);
    expect(() => fiscalYearOf('2027-02-29', 4)).toThrow(AppError);
  });
});

describe('setting schemas', () => {
  it('bounds fy_start_month to 1..12 integers', () => {
    const schema = SETTING_SCHEMAS.fy_start_month;
    expect(schema.safeParse(4).success).toBe(true);
    expect(schema.safeParse(0).success).toBe(false);
    expect(schema.safeParse(13).success).toBe(false);
    expect(schema.safeParse(4.5).success).toBe(false);
    expect(schema.safeParse('4').success).toBe(false);
  });

  it('bounds tally_stale_hours to 1..720 integers', () => {
    const schema = SETTING_SCHEMAS.tally_stale_hours;
    expect(schema.safeParse(24).success).toBe(true);
    expect(schema.safeParse(0).success).toBe(false);
    expect(schema.safeParse(721).success).toBe(false);
  });
});
