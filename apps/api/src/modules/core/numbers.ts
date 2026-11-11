import { AppError } from '../../errors.js';
import type { Tx } from './context.js';
import * as settings from './settings.js';

const NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Financial year label for a business date: the calendar year in which the FY starts.
 * With `fyStartMonth` 4, 2026-04-01..2027-03-31 is FY 2026 (written 2026-27 in reports).
 */
export function fiscalYearOf(businessDate: string, fyStartMonth: number): number {
  const match = DATE_PATTERN.exec(businessDate);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  const valid =
    match !== null &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (!valid) {
    throw new AppError('VALIDATION_FAILED', 'businessDate must be a valid YYYY-MM-DD date', {
      fields: { businessDate: 'invalid' },
    });
  }
  return month >= fyStartMonth ? year : year - 1;
}

/**
 * Next number for `sequenceName` (the prefix, e.g. `EXP`) in the financial year of `businessDate`,
 * formatted `PREFIX-FY-#####` (`EXP-2026-00001`).
 *
 * The upsert takes a row lock held until the caller's transaction ends, so concurrent
 * transactions queue behind each other. If the caller rolls back the increment rolls back with
 * it, so committed numbers are gap-free and unique. Call it inside the transaction that stores
 * the number, and as late as possible in that transaction to keep the lock short.
 */
export async function next(tx: Tx, sequenceName: string, businessDate: string): Promise<string> {
  if (!NAME_PATTERN.test(sequenceName)) {
    throw new AppError('VALIDATION_FAILED', 'Invalid sequence name', {
      fields: { sequenceName: 'must match ^[A-Z][A-Z0-9_]*$' },
    });
  }
  const { value: fyStartMonth } = await settings.get(tx, 'fy_start_month');
  const fiscalYear = fiscalYearOf(businessDate, fyStartMonth);

  // First use inserts next_value = 2 (value 1 is handed out now); later uses add 1.
  const row = await tx
    .insertInto('number_sequence')
    .values({ name: sequenceName, fiscal_year: fiscalYear, next_value: 2 })
    .onConflict((oc) =>
      oc.columns(['name', 'fiscal_year']).doUpdateSet((eb) => ({
        next_value: eb('number_sequence.next_value', '+', 1),
      })),
    )
    .returning('next_value')
    .executeTakeFirstOrThrow();

  const assigned = BigInt(row.next_value) - 1n;
  return `${sequenceName}-${fiscalYear}-${assigned.toString().padStart(5, '0')}`;
}
