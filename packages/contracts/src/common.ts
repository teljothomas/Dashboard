import { z } from 'zod';

/** ADR-010: money is a decimal string, max 16 integer digits, max 2 fraction digits. */
export const MONEY_REGEX = /^-?\d{1,16}(\.\d{1,2})?$/;
/** Quantities are NUMERIC(14,3): max 11 integer digits, max 3 fraction digits. */
export const QTY_REGEX = /^-?\d{1,11}(\.\d{1,3})?$/;
/** Rates are NUMERIC(18,4): max 14 integer digits, max 4 fraction digits. */
export const RATE_REGEX = /^-?\d{1,14}(\.\d{1,4})?$/;
/** ADR-011: primary keys are UUID v7. */
export const UUID_V7_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export const MoneyString = z
  .string()
  .regex(MONEY_REGEX, 'Expected a decimal string with at most 2 fraction digits');
export type MoneyString = z.infer<typeof MoneyString>;

export const QtyString = z
  .string()
  .regex(QTY_REGEX, 'Expected a decimal string with at most 3 fraction digits');
export type QtyString = z.infer<typeof QtyString>;

export const RateString = z
  .string()
  .regex(RATE_REGEX, 'Expected a decimal string with at most 4 fraction digits');
export type RateString = z.infer<typeof RateString>;

/** Business date, `YYYY-MM-DD` (Asia/Kolkata). Must be a real calendar date. */
export const DateString = z
  .string()
  .regex(DATE_REGEX, 'Expected YYYY-MM-DD')
  .refine((value) => {
    const [y, m, d] = value.split('-').map(Number) as [number, number, number];
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  }, 'Not a real calendar date');
export type DateString = z.infer<typeof DateString>;

export const Uuid = z.string().regex(UUID_V7_REGEX, 'Expected a UUID v7');
export type Uuid = z.infer<typeof Uuid>;

/** INTERFACES §1 error codes. */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT_VERSION',
  'IDEMPOTENCY_MISMATCH',
  'DUPLICATE_SUSPECTED',
  'INVALID_TRANSITION',
  'RECORD_LOCKED',
  'LEASE_HELD',
  'LEASE_STALE',
  'MAPPING_MISSING',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA',
  'RATE_LIMITED',
  'INTERNAL',
] as const;

export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** HTTP status per INTERFACES §1 table. */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT_VERSION: 409,
  IDEMPOTENCY_MISMATCH: 409,
  DUPLICATE_SUSPECTED: 409,
  INVALID_TRANSITION: 409,
  RECORD_LOCKED: 409,
  LEASE_HELD: 409,
  LEASE_STALE: 409,
  MAPPING_MISSING: 422,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA: 415,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

/** `{ "error": { code, message, details?, requestId } }` */
export const ErrorEnvelope = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    requestId: z.string(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

/** BR-301: the seven user-visible record statuses. */
export const SYNC_STATUSES = [
  'LOCAL_ONLY',
  'SYNCED',
  'AWAITING_APPROVAL',
  'AWAITING_TALLY',
  'POSTED_TO_TALLY',
  'FAILED',
  'REQUIRES_RECONCILIATION',
] as const;

export const SyncStatus = z.enum(SYNC_STATUSES);
export type SyncStatus = z.infer<typeof SyncStatus>;

/** Success envelope: `{ data, meta?: { nextCursor? } }`. */
export function successEnvelope<T extends z.ZodType>(data: T) {
  return z.object({
    data,
    meta: z.object({ nextCursor: z.string().optional() }).optional(),
  });
}
