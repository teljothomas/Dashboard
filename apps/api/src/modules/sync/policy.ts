import { createHash } from 'node:crypto';

/** JSON with object keys sorted recursively, so equal payloads hash equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const body = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',');
  return `{${body}}`;
}

export interface HashableMutation {
  entityType: string;
  entityId: string;
  op: string;
  baseVersion: number | null;
  payload: Record<string, unknown>;
}

/**
 * sha256 of the content of a mutation. `clientCreatedAt` and the device are left out, so a retry
 * of the same outbox entry always hashes the same.
 */
export function mutationHash(m: HashableMutation): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        entityType: m.entityType,
        entityId: m.entityId,
        op: m.op,
        baseVersion: m.baseVersion,
        payload: m.payload,
      }),
    )
    .digest('hex');
}

export type StaleKind = 'FRESH' | 'MERGE' | 'CONFLICT';

export interface StaleInput {
  /** Version the client edited from. */
  baseVersion: number | null;
  /** Current server version of the row. */
  serverVersion: number;
  /** Payload keys the client wants to change. */
  changedKeys: readonly string[];
  /** Keys that are financial (amount, date, category, mode, payee, qty, km): stale means conflict. */
  financialFields: readonly string[];
  /**
   * Keys the server changed between `baseVersion` and `serverVersion`, or null when the handler
   * cannot tell (treated as overlapping).
   */
  serverChangedFields: readonly string[] | null;
}

export interface StaleResult {
  kind: StaleKind;
  /** Machine reason for a CONFLICT. */
  reason?: string;
  /** Keys that collided (CONFLICT) or auto-merged (MERGE). */
  fields?: string[];
}

/**
 * SYNC_DESIGN 2.3 for UPDATE. `FRESH`: base is current, apply. `MERGE`: stale but only
 * non-financial keys, disjoint from what the server changed: apply and audit as merged.
 * `CONFLICT`: anything else (financial key touched, overlapping keys, unknown server changes,
 * or a base version that is missing or ahead of the server).
 */
export function classifyStaleUpdate(input: StaleInput): StaleResult {
  const { baseVersion, serverVersion, changedKeys, financialFields, serverChangedFields } = input;
  if (baseVersion === serverVersion) {
    return { kind: 'FRESH' };
  }
  if (baseVersion === null || baseVersion > serverVersion) {
    return { kind: 'CONFLICT', reason: 'BASE_VERSION_INVALID' };
  }
  const financial = changedKeys.filter((key) => financialFields.includes(key));
  if (financial.length > 0) {
    return { kind: 'CONFLICT', reason: 'STALE_FINANCIAL_FIELD', fields: financial };
  }
  if (serverChangedFields === null) {
    return { kind: 'CONFLICT', reason: 'SERVER_CHANGES_UNKNOWN' };
  }
  const overlap = changedKeys.filter((key) => serverChangedFields.includes(key));
  if (overlap.length > 0) {
    return { kind: 'CONFLICT', reason: 'OVERLAPPING_FIELDS', fields: overlap };
  }
  return { kind: 'MERGE', fields: [...changedKeys] };
}
