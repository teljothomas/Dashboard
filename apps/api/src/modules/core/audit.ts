import { isDeepStrictEqual } from 'node:util';
import { getContext, type ActorContext, type Tx } from './context.js';

export interface AuditInput {
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  /** Overrides the ambient context (tests, system actors). */
  ctx?: ActorContext;
}

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Round-trip through JSON so Dates, undefined and class instances compare as stored. */
function normalize(value: unknown): unknown {
  return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown);
}

/**
 * Shallow JSON diff. When both sides are objects only the top-level keys whose values differ are
 * kept (old values in `before`, new values in `after`). When either side is missing or not an
 * object, each side is kept whole. Values are compared deeply, but keys are not recursed into.
 */
export function shallowDiff(before: unknown, after: unknown): { before: unknown; after: unknown } {
  const b = normalize(before);
  const a = normalize(after);
  if (!isPlainObject(b) || !isPlainObject(a)) {
    return { before: b ?? null, after: a ?? null };
  }
  const beforeOut: JsonObject = {};
  const afterOut: JsonObject = {};
  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (!isDeepStrictEqual(b[key], a[key])) {
      if (key in b) beforeOut[key] = b[key];
      if (key in a) afterOut[key] = a[key];
    }
  }
  return { before: beforeOut, after: afterOut };
}

/**
 * Append one audit row in the caller's transaction (ADR-013). Call it in the same transaction as
 * the mutation so both commit or neither does. Actor fields come from `input.ctx` or the ambient
 * request context; system work (no context) records null actors.
 */
export async function record(tx: Tx, input: AuditInput): Promise<void> {
  const ctx = input.ctx ?? getContext();
  const diff = shallowDiff(input.before, input.after);
  await tx
    .insertInto('audit_log')
    .values({
      action: input.action,
      entity_type: input.entityType,
      entity_id: input.entityId,
      actor_user_id: ctx?.userId ?? null,
      actor_agent_id: ctx?.agentId ?? null,
      device_id: ctx?.deviceId ?? null,
      request_id: ctx?.requestId ?? null,
      ip: ctx?.ip ?? null,
      // JSON.stringify: node-postgres turns JS arrays into PG arrays, not jsonb.
      before: diff.before === null ? null : JSON.stringify(diff.before),
      after: diff.after === null ? null : JSON.stringify(diff.after),
    })
    .execute();
}
