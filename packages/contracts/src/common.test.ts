import { describe, expect, it } from 'vitest';
import {
  DateString,
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  ErrorEnvelope,
  MoneyString,
  QtyString,
  SYNC_STATUSES,
  SyncStatus,
  Uuid,
  successEnvelope,
} from './common.js';

describe('MoneyString', () => {
  it.each([
    '0',
    '1',
    '-1',
    '1234.5',
    '1234.50',
    '-0.01',
    '9999999999999999',
    '9999999999999999.99',
  ])('accepts %s', (v) => {
    expect(MoneyString.safeParse(v).success).toBe(true);
  });
  it.each([
    '',
    '1.',
    '.5',
    '1.234',
    '1e3',
    ' 1',
    '1 ',
    '+1',
    '--1',
    '12345678901234567',
    'abc',
    '1,000.00',
  ])('rejects %j', (v) => {
    expect(MoneyString.safeParse(v).success).toBe(false);
  });
  it('rejects non-strings (no JSON numbers for money)', () => {
    expect(MoneyString.safeParse(12.5).success).toBe(false);
  });
});

describe('QtyString', () => {
  it('accepts up to 3 fraction digits', () => {
    expect(QtyString.safeParse('12.345').success).toBe(true);
    expect(QtyString.safeParse('12.3456').success).toBe(false);
  });
});

describe('DateString', () => {
  it('accepts real dates incl. leap day', () => {
    expect(DateString.safeParse('2026-11-11').success).toBe(true);
    expect(DateString.safeParse('2028-02-29').success).toBe(true);
  });
  it.each(['2026-02-29', '2026-13-01', '2026-00-10', '2026-11-31', '26-11-11', '2026-1-1'])(
    'rejects %s',
    (v) => {
      expect(DateString.safeParse(v).success).toBe(false);
    },
  );
});

describe('Uuid', () => {
  it('accepts v7 and rejects v4', () => {
    expect(Uuid.safeParse('0192f6a0-7b3c-7abc-8def-0123456789ab').success).toBe(true);
    expect(Uuid.safeParse('0192f6a0-7b3c-4abc-8def-0123456789ab').success).toBe(false);
    expect(Uuid.safeParse('not-a-uuid').success).toBe(false);
  });
});

describe('error codes', () => {
  it('has 16 codes each with an HTTP status', () => {
    expect(ERROR_CODES).toHaveLength(16);
    for (const code of ERROR_CODES) {
      expect(ERROR_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
    expect(ERROR_HTTP_STATUS.INTERNAL).toBe(500);
    expect(ERROR_HTTP_STATUS.MAPPING_MISSING).toBe(422);
  });
  it('validates the error envelope', () => {
    const ok = ErrorEnvelope.safeParse({
      error: { code: 'NOT_FOUND', message: 'x', requestId: 'r1' },
    });
    expect(ok.success).toBe(true);
    const bad = ErrorEnvelope.safeParse({ error: { code: 'NOPE', message: 'x', requestId: 'r1' } });
    expect(bad.success).toBe(false);
  });
});

describe('SyncStatus', () => {
  it('has the seven BR-301 labels', () => {
    expect(SYNC_STATUSES).toEqual([
      'LOCAL_ONLY',
      'SYNCED',
      'AWAITING_APPROVAL',
      'AWAITING_TALLY',
      'POSTED_TO_TALLY',
      'FAILED',
      'REQUIRES_RECONCILIATION',
    ]);
    expect(SyncStatus.safeParse('SYNCED').success).toBe(true);
    expect(SyncStatus.safeParse('synced').success).toBe(false);
  });
});

describe('successEnvelope', () => {
  it('wraps data with optional meta', () => {
    const schema = successEnvelope(MoneyString);
    expect(schema.safeParse({ data: '1.00', meta: { nextCursor: 'c' } }).success).toBe(true);
    expect(schema.safeParse({ data: 1 }).success).toBe(false);
  });
});
