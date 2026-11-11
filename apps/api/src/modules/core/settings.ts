import { z } from 'zod';
import { AppError } from '../../errors.js';
import { record } from './audit.js';
import { getContext, type ActorContext, type Tx } from './context.js';

/** Known settings and their value schemas. Unknown keys are rejected: no free-form config. */
export const SETTING_SCHEMAS = {
  tally_stale_hours: z.number().int().min(1).max(720),
  fy_start_month: z.number().int().min(1).max(12),
} as const;

export type SettingKey = keyof typeof SETTING_SCHEMAS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTING_SCHEMAS)[K]>;

export interface SettingRecord<K extends SettingKey = SettingKey> {
  key: K;
  value: SettingValue<K>;
  version: number;
}

function schemaFor(key: string): z.ZodType {
  if (!Object.hasOwn(SETTING_SCHEMAS, key)) {
    throw new AppError('VALIDATION_FAILED', `Unknown setting: ${key}`, {
      fields: { key: 'unknown' },
    });
  }
  return SETTING_SCHEMAS[key as SettingKey];
}

function parseValue(key: string, raw: unknown): unknown {
  const parsed = schemaFor(key).safeParse(raw);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', `Invalid value for setting ${key}`, {
      fields: { value: parsed.error.issues.map((i) => i.message).join('; ') },
    });
  }
  return parsed.data;
}

/** Read one setting. Throws NOT_FOUND when the row is absent. */
export async function get<K extends SettingKey>(tx: Tx, key: K): Promise<SettingRecord<K>> {
  schemaFor(key);
  const row = await tx
    .selectFrom('app_setting')
    .select(['key', 'value', 'version'])
    .where('key', '=', key)
    .executeTakeFirst();
  if (!row) throw new AppError('NOT_FOUND', 'Setting not found');
  return { key, value: parseValue(key, row.value) as SettingValue<K>, version: row.version };
}

/** All known settings that have a row. Rows with unknown keys are ignored. */
export async function list(tx: Tx): Promise<SettingRecord[]> {
  const rows = await tx
    .selectFrom('app_setting')
    .select(['key', 'value', 'version'])
    .orderBy('key')
    .execute();
  return rows
    .filter((r) => Object.hasOwn(SETTING_SCHEMAS, r.key))
    .map((r) => ({
      key: r.key as SettingKey,
      value: parseValue(r.key, r.value) as never,
      version: r.version,
    }));
}

export interface SetOptions {
  /** Optimistic concurrency: reject with CONFLICT_VERSION unless the stored version matches. */
  expectedVersion?: number;
  ctx?: ActorContext;
}

/** Create or update a setting and write the audit row in the same transaction. */
export async function set<K extends SettingKey>(
  tx: Tx,
  key: K,
  value: SettingValue<K>,
  options: SetOptions = {},
): Promise<SettingRecord<K>> {
  const parsed = parseValue(key, value) as SettingValue<K>;
  const ctx = options.ctx ?? getContext();
  const actor = ctx?.userId ?? null;

  const existing = await tx
    .selectFrom('app_setting')
    .select(['value', 'version'])
    .where('key', '=', key)
    .forUpdate()
    .executeTakeFirst();

  if (options.expectedVersion !== undefined && options.expectedVersion !== existing?.version) {
    throw new AppError('CONFLICT_VERSION', 'Setting was changed by someone else', {
      server: existing ? { key, value: existing.value, version: existing.version } : null,
    });
  }

  let version: number;
  if (existing) {
    const updated = await tx
      .updateTable('app_setting')
      .set({ value: JSON.stringify(parsed), updated_by: actor })
      .where('key', '=', key)
      .returning('version')
      .executeTakeFirstOrThrow();
    version = updated.version;
  } else {
    const inserted = await tx
      .insertInto('app_setting')
      .values({ key, value: JSON.stringify(parsed), created_by: actor, updated_by: actor })
      .returning('version')
      .executeTakeFirstOrThrow();
    version = inserted.version;
  }

  await record(tx, {
    action: existing ? 'setting.update' : 'setting.create',
    entityType: 'app_setting',
    entityId: key,
    before: existing ? { value: existing.value } : null,
    after: { value: parsed },
    ...(ctx ? { ctx } : {}),
  });

  return { key, value: parsed, version };
}
