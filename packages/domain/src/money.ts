import { Decimal } from 'decimal.js';

/**
 * Money arithmetic (ADR-010). Never uses JS floats.
 * Values are NUMERIC(18,2) INR: at most 16 integer digits and exactly 2 fraction digits after rounding.
 */
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

const MONEY_INPUT = /^-?\d{1,16}(\.\d{1,2})?$/;
const FACTOR_INPUT = /^-?\d{1,16}(\.\d{1,8})?$/;
const MAX_ABS = new D('9999999999999999.99');

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export class Money {
  private readonly value: Decimal;

  private constructor(value: Decimal) {
    this.value = value;
  }

  static zero(): Money {
    return new Money(new D(0));
  }

  /** Strict parse of an API decimal string. Rejects floats, exponents, whitespace, >2 fraction digits. */
  static parse(input: string): Money {
    if (typeof input !== 'string' || !MONEY_INPUT.test(input)) {
      throw new MoneyError(`Invalid money string: ${JSON.stringify(input)}`);
    }
    return new Money(new D(input));
  }

  static isValid(input: unknown): input is string {
    return typeof input === 'string' && MONEY_INPUT.test(input);
  }

  /** Round any value (e.g. from a multiplication) to 2 dp HALF_UP and range-check. */
  private static fromRaw(raw: Decimal): Money {
    const rounded = raw.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    if (rounded.abs().greaterThan(MAX_ABS)) {
      throw new MoneyError('Money value out of range (max 16 integer digits)');
    }
    return new Money(rounded);
  }

  add(other: Money): Money {
    return Money.fromRaw(this.value.plus(other.value));
  }

  sub(other: Money): Money {
    return Money.fromRaw(this.value.minus(other.value));
  }

  /** Multiply by a decimal-string factor (quantity, rate, percentage fraction). Result rounded HALF_UP to 2 dp. */
  mul(factor: string): Money {
    return Money.fromRaw(this.value.times(parseFactor(factor)));
  }

  /** Divide by a non-zero decimal-string divisor. Result rounded HALF_UP to 2 dp. */
  div(divisor: string): Money {
    const d = parseFactor(divisor);
    if (d.isZero()) {
      throw new MoneyError('Division by zero');
    }
    return Money.fromRaw(this.value.div(d));
  }

  negate(): Money {
    return Money.fromRaw(this.value.negated());
  }

  abs(): Money {
    return Money.fromRaw(this.value.abs());
  }

  /** -1, 0 or 1. */
  compare(other: Money): -1 | 0 | 1 {
    return this.value.comparedTo(other.value) as -1 | 0 | 1;
  }

  equals(other: Money): boolean {
    return this.value.equals(other.value);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative() && !this.value.isZero();
  }

  /** Fixed 2 dp decimal string, never `-0.00`. */
  toString(): string {
    if (this.value.isZero()) {
      return '0.00';
    }
    return this.value.toFixed(2);
  }

  toJSON(): string {
    return this.toString();
  }

  /** en-IN display, e.g. `₹12,34,567.50`, negatives as `-₹1,000.00`. */
  format(): string {
    const [intPart, frac] = this.toString().replace('-', '').split('.') as [string, string];
    return `${this.isNegative() ? '-' : ''}₹${groupIndian(intPart)}.${frac}`;
  }
}

function parseFactor(factor: string): Decimal {
  if (typeof factor !== 'string' || !FACTOR_INPUT.test(factor)) {
    throw new MoneyError(`Invalid factor string: ${JSON.stringify(factor)}`);
  }
  return new D(factor);
}

/** Indian digit grouping: last 3 digits, then groups of 2. */
function groupIndian(digits: string): string {
  if (digits.length <= 3) {
    return digits;
  }
  const last3 = digits.slice(-3);
  let rest = digits.slice(0, -3);
  const groups: string[] = [];
  while (rest.length > 2) {
    groups.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest.length > 0) {
    groups.unshift(rest);
  }
  return `${groups.join(',')},${last3}`;
}

/** Sum of money values; empty list is zero. */
export function sumMoney(values: readonly Money[]): Money {
  return values.reduce((acc, v) => acc.add(v), Money.zero());
}
