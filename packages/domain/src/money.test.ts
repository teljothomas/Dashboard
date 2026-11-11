import { describe, expect, it } from 'vitest';
import { Money, MoneyError, sumMoney } from './money.js';

const m = (s: string): Money => Money.parse(s);

describe('Money.parse', () => {
  it.each([
    ['0', '0.00'],
    ['1', '1.00'],
    ['1.5', '1.50'],
    ['1234.56', '1234.56'],
    ['-12.3', '-12.30'],
    ['-0', '0.00'],
    ['-0.00', '0.00'],
  ])('parses %s to %s', (input, out) => {
    expect(m(input).toString()).toBe(out);
  });

  it('handles 16 integer digits without precision loss', () => {
    expect(m('9999999999999999.99').toString()).toBe('9999999999999999.99');
    expect(m('1234567890123456.78').add(m('0.01')).toString()).toBe('1234567890123456.79');
  });

  it.each([
    '',
    ' ',
    '1.',
    '.5',
    '1.234',
    '1e3',
    '1,000',
    ' 1',
    '1 ',
    '+1',
    '--1',
    'NaN',
    'Infinity',
    '12345678901234567',
  ])('rejects %j', (input) => {
    expect(() => Money.parse(input)).toThrow(MoneyError);
  });

  it('rejects non-string input', () => {
    expect(() => Money.parse(1.5 as unknown as string)).toThrow(MoneyError);
    expect(() => Money.parse(null as unknown as string)).toThrow(MoneyError);
  });

  it('isValid mirrors parse', () => {
    expect(Money.isValid('10.25')).toBe(true);
    expect(Money.isValid('10.255')).toBe(false);
    expect(Money.isValid(10)).toBe(false);
  });
});

describe('arithmetic', () => {
  it('0.1 + 0.2 is exactly 0.30', () => {
    expect(m('0.1').add(m('0.2')).toString()).toBe('0.30');
    expect(m('0.1').add(m('0.2')).equals(m('0.3'))).toBe(true);
  });

  it('subtracts into negatives', () => {
    const r = m('1.00').sub(m('2.50'));
    expect(r.toString()).toBe('-1.50');
    expect(r.isNegative()).toBe(true);
  });

  it('add/sub with negative operands', () => {
    expect(m('-5').add(m('-7.25')).toString()).toBe('-12.25');
    expect(m('-5').sub(m('-5')).toString()).toBe('0.00');
  });

  it('never yields -0.00', () => {
    expect(m('0').mul('-1').toString()).toBe('0.00');
    expect(m('0.01').mul('-0.4').toString()).toBe('0.00');
    expect(m('0.01').mul('-0.4').isNegative()).toBe(false);
  });

  it('multiplies by quantity and rounds HALF_UP to 2 dp', () => {
    expect(m('100.00').mul('12.345').toString()).toBe('1234.50');
    expect(m('1.00').mul('0.005').toString()).toBe('0.01'); // .005 rounds up
    expect(m('1.00').mul('0.004').toString()).toBe('0.00');
    expect(m('1.00').mul('0.015').toString()).toBe('0.02');
  });

  it('rounds negative values half away from zero', () => {
    expect(m('-1.00').mul('0.005').toString()).toBe('-0.01');
    expect(m('-1.00').mul('0.015').toString()).toBe('-0.02');
  });

  it('multiplies by a rate with 4 dp', () => {
    expect(m('1000.00').mul('0.0525').toString()).toBe('52.50');
    expect(m('333.33').mul('0.1234').toString()).toBe('41.13');
  });

  it('divides with HALF_UP rounding', () => {
    expect(m('10.00').div('3').toString()).toBe('3.33');
    expect(m('20.00').div('3').toString()).toBe('6.67');
    expect(m('1.00').div('8').toString()).toBe('0.13'); // 0.125 -> 0.13
  });

  it('division by zero throws', () => {
    expect(() => m('1').div('0')).toThrow(MoneyError);
    expect(() => m('1').div('0.000')).toThrow(MoneyError);
  });

  it('rejects invalid factors', () => {
    expect(() => m('1').mul('1e2')).toThrow(MoneyError);
    expect(() => m('1').mul('')).toThrow(MoneyError);
  });

  it('throws when result exceeds 16 integer digits', () => {
    expect(() => m('9999999999999999.99').add(m('0.01'))).toThrow(MoneyError);
    expect(() => m('9999999999999999.00').mul('10')).toThrow(MoneyError);
  });

  it('negate and abs', () => {
    expect(m('5.10').negate().toString()).toBe('-5.10');
    expect(m('-5.10').abs().toString()).toBe('5.10');
    expect(m('0').negate().toString()).toBe('0.00');
  });
});

describe('compare / sum', () => {
  it('compares', () => {
    expect(m('1.00').compare(m('1.0'))).toBe(0);
    expect(m('1.01').compare(m('1.00'))).toBe(1);
    expect(m('-1').compare(m('0'))).toBe(-1);
    expect(m('0').isZero()).toBe(true);
  });

  it('sums a list; empty list is zero', () => {
    expect(sumMoney([m('0.1'), m('0.2'), m('0.3')]).toString()).toBe('0.60');
    expect(sumMoney([]).toString()).toBe('0.00');
    expect(sumMoney([m('10'), m('-10.50')]).toString()).toBe('-0.50');
  });

  it('sums 10,000 x 0.10 exactly', () => {
    const items = Array.from({ length: 10_000 }, () => m('0.10'));
    expect(sumMoney(items).toString()).toBe('1000.00');
  });
});

describe('format (en-IN)', () => {
  it.each([
    ['0', '₹0.00'],
    ['5', '₹5.00'],
    ['999.5', '₹999.50'],
    ['1000', '₹1,000.00'],
    ['12345.6', '₹12,345.60'],
    ['123456.78', '₹1,23,456.78'],
    ['1234567.5', '₹12,34,567.50'],
    ['-1234567.5', '-₹12,34,567.50'],
    ['9999999999999999.99', '₹9,99,99,99,99,99,99,999.99'],
  ])('formats %s as %s', (input, out) => {
    expect(m(input).format()).toBe(out);
  });
});

describe('serialisation', () => {
  it('JSON-serialises as a fixed 2 dp string', () => {
    expect(JSON.stringify({ amount: m('3.5') })).toBe('{"amount":"3.50"}');
  });
});
