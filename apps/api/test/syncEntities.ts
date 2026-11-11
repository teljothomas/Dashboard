import { sql } from 'kysely';
import type pg from 'pg';
import { z } from 'zod';
import { MoneyString } from '@tradex/contracts';
import { AppError } from '../src/errors.js';
import { audit } from '../src/modules/core/index.js';
import type { Tx } from '../src/modules/core/context.js';
import {
  classifyStaleUpdate,
  registerEntity,
  type EntitySummary,
  type HandlerOutcome,
  type SyncCaller,
  type SyncEntityHandler,
  type SyncMutation,
} from '../src/modules/sync/index.js';

/**
 * Test-only syncable entities (never imported by `src/`). The tables are created by the test setup
 * as the owner role, not by a migration. `test_note` is a user-scoped record with a financial field
 * (`amount`), non-financial fields (`title`, `note`), a business-unique `(owner_id, slot)` and a
 * `locked_at` lock enforced by the real `forbid_update_when_locked` trigger. `test_ref` is a
 * reference type.
 */
export const NOTE_FINANCIAL_FIELDS = ['amount'] as const;

export async function createSyncTestTables(owner: pg.Pool): Promise<void> {
  await owner.query(`
    DROP TABLE IF EXISTS test_note;
    DROP TABLE IF EXISTS test_ref;
    CREATE TABLE test_note (
      id             uuid PRIMARY KEY,
      owner_id       uuid NOT NULL,
      title          text NOT NULL,
      amount         numeric(18,2) NOT NULL DEFAULT 0,
      note           text,
      slot           text,
      status         text NOT NULL DEFAULT 'DRAFT',
      locked_at      timestamptz,
      field_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
      version        integer NOT NULL DEFAULT 1,
      sync_seq       bigint,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now(),
      UNIQUE (owner_id, slot)
    );
    CREATE TRIGGER test_note_bump BEFORE UPDATE ON test_note
      FOR EACH ROW EXECUTE FUNCTION bump_version();
    CREATE TRIGGER test_note_seq BEFORE INSERT OR UPDATE ON test_note
      FOR EACH ROW EXECUTE FUNCTION assign_sync_seq();
    CREATE TRIGGER test_note_lock BEFORE UPDATE OR DELETE ON test_note
      FOR EACH ROW EXECUTE FUNCTION forbid_update_when_locked('locked_at');
    CREATE TABLE test_ref (
      id          uuid PRIMARY KEY,
      name        text NOT NULL,
      archived_at timestamptz,
      version     integer NOT NULL DEFAULT 1,
      sync_seq    bigint
    );
    CREATE TRIGGER test_ref_bump BEFORE UPDATE ON test_ref
      FOR EACH ROW EXECUTE FUNCTION bump_version();
    CREATE TRIGGER test_ref_seq BEFORE INSERT OR UPDATE ON test_ref
      FOR EACH ROW EXECUTE FUNCTION assign_sync_seq();
  `);
}

export interface NoteRow {
  id: string;
  owner_id: string;
  title: string;
  amount: string;
  note: string | null;
  slot: string | null;
  status: string;
  locked_at: Date | null;
  field_versions: Record<string, number>;
  version: number;
  sync_seq: string;
}

export interface RefRow {
  id: string;
  name: string;
  archived_at: Date | null;
  version: number;
  sync_seq: string;
}

const CreatePayload = z.object({
  title: z.string().min(1).max(100),
  amount: MoneyString,
  note: z.string().max(500).optional(),
  slot: z.string().min(1).max(20).optional(),
});
const UpdatePayload = z
  .object({
    title: z.string().min(1).max(100).optional(),
    amount: MoneyString.optional(),
    note: z.string().max(500).optional(),
  })
  .strict();

function summary(row: NoteRow): EntitySummary {
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    number: null,
    syncStatus: row.status === 'SUBMITTED' ? 'AWAITING_APPROVAL' : 'SYNCED',
  };
}

async function loadNote(tx: Tx, id: string): Promise<NoteRow | undefined> {
  const result = await sql<NoteRow>`SELECT * FROM test_note WHERE id = ${id}`.execute(tx);
  return result.rows[0];
}

async function ownedNote(tx: Tx, caller: SyncCaller, id: string): Promise<NoteRow> {
  const row = await loadNote(tx, id);
  if (!row || row.owner_id !== caller.userId) {
    throw new AppError('NOT_FOUND', 'Note not found');
  }
  return row;
}

function serverChangedSince(row: NoteRow, baseVersion: number): string[] {
  return Object.entries(row.field_versions)
    .filter(([, version]) => version > baseVersion)
    .map(([field]) => field);
}

async function writeFields(
  tx: Tx,
  row: NoteRow,
  values: z.infer<typeof UpdatePayload>,
): Promise<NoteRow> {
  const changed = Object.fromEntries(
    Object.keys(values)
      .filter((key) => values[key as keyof typeof values] !== undefined)
      .map((key) => [key, row.version + 1]),
  );
  const result = await sql<NoteRow>`
    UPDATE test_note SET
      title = COALESCE(${values.title ?? null}::text, title),
      amount = COALESCE(${values.amount ?? null}::numeric, amount),
      note = COALESCE(${values.note ?? null}::text, note),
      field_versions = field_versions || ${JSON.stringify(changed)}::jsonb
    WHERE id = ${row.id}
    RETURNING *`.execute(tx);
  return result.rows[0] as NoteRow;
}

export const testNoteHandler: SyncEntityHandler<NoteRow> = {
  scopes: ['mine'],

  async create(tx, caller, m: SyncMutation): Promise<HandlerOutcome> {
    const payload = CreatePayload.parse(m.payload);
    const existing = await loadNote(tx, m.entityId);
    if (existing) {
      // Same id again (idempotent by id): the record already exists.
      return { result: 'APPLIED', entity: summary(existing) };
    }
    if (payload.slot) {
      const clash = await sql<NoteRow>`
        SELECT * FROM test_note WHERE owner_id = ${caller.userId} AND slot = ${payload.slot}`.execute(
        tx,
      );
      const other = clash.rows[0];
      if (other) {
        return {
          result: 'CONFLICT',
          conflict: {
            reason: 'UNIQUE_VIOLATION',
            baseVersion: null,
            serverVersion: other.version,
            serverSnapshot: { id: other.id, title: other.title, slot: other.slot },
          },
        };
      }
    }
    const inserted = await sql<NoteRow>`
      INSERT INTO test_note (id, owner_id, title, amount, note, slot)
      VALUES (${m.entityId}, ${caller.userId}, ${payload.title}, ${payload.amount}::numeric,
              ${payload.note ?? null}, ${payload.slot ?? null})
      RETURNING *`.execute(tx);
    const row = inserted.rows[0] as NoteRow;
    await audit.record(tx, {
      action: 'test_note.create',
      entityType: 'test_note',
      entityId: row.id,
      after: payload,
      ctx: caller.actor,
    });
    return { result: 'APPLIED', entity: summary(row) };
  },

  async update(tx, caller, m: SyncMutation): Promise<HandlerOutcome> {
    const values = UpdatePayload.parse(m.payload);
    const row = await ownedNote(tx, caller, m.entityId);
    const changedKeys = Object.keys(values);
    const verdict = classifyStaleUpdate({
      baseVersion: m.baseVersion,
      serverVersion: row.version,
      changedKeys,
      financialFields: NOTE_FINANCIAL_FIELDS,
      serverChangedFields: m.baseVersion === null ? null : serverChangedSince(row, m.baseVersion),
    });
    if (verdict.kind === 'CONFLICT') {
      return {
        result: 'CONFLICT',
        conflict: {
          reason: verdict.reason ?? 'CONFLICT',
          baseVersion: m.baseVersion,
          serverVersion: row.version,
          serverSnapshot: { title: row.title, amount: row.amount, note: row.note },
        },
      };
    }
    // The lock trigger rejects a locked row here (TX423), mapped to RECORD_LOCKED by the framework.
    const updated = await writeFields(tx, row, values);
    await audit.record(tx, {
      action: 'test_note.update',
      entityType: 'test_note',
      entityId: row.id,
      before: { title: row.title, amount: row.amount, note: row.note },
      after: { title: updated.title, amount: updated.amount, note: updated.note },
      ctx: caller.actor,
    });
    return { result: 'APPLIED', entity: summary(updated), merged: verdict.kind === 'MERGE' };
  },

  async submit(tx, caller, m: SyncMutation): Promise<HandlerOutcome> {
    const row = await ownedNote(tx, caller, m.entityId);
    if (row.locked_at) {
      throw new AppError('RECORD_LOCKED', 'Note is locked');
    }
    if (row.status !== 'DRAFT') {
      throw new AppError('INVALID_TRANSITION', `Cannot submit a ${row.status} note`);
    }
    const result = await sql<NoteRow>`
      UPDATE test_note SET status = 'SUBMITTED' WHERE id = ${row.id} RETURNING *`.execute(tx);
    return { result: 'APPLIED', entity: summary(result.rows[0] as NoteRow) };
  },

  async cancel(tx, caller, m: SyncMutation): Promise<HandlerOutcome> {
    const row = await ownedNote(tx, caller, m.entityId);
    if (row.locked_at || row.status === 'APPROVED') {
      throw new AppError('RECORD_LOCKED', 'Note is approved');
    }
    if (row.status === 'CANCELLED') {
      throw new AppError('INVALID_TRANSITION', 'Note is already cancelled');
    }
    const result = await sql<NoteRow>`
      UPDATE test_note SET status = 'CANCELLED' WHERE id = ${row.id} RETURNING *`.execute(tx);
    return { result: 'APPLIED', entity: summary(result.rows[0] as NoteRow) };
  },

  async scopeFilter(tx, caller, _scope, afterSeq, limit) {
    const result = await sql<NoteRow>`
      SELECT * FROM test_note
      WHERE owner_id = ${caller.userId} AND sync_seq > ${afterSeq}
      ORDER BY sync_seq LIMIT ${limit}`.execute(tx);
    return result.rows.map((row) => ({
      entityId: row.id,
      syncSeq: row.sync_seq,
      deleted: row.status === 'CANCELLED',
      row,
    }));
  },

  serialize(row) {
    return {
      id: row.id,
      title: row.title,
      amount: row.amount,
      note: row.note,
      slot: row.slot,
      status: row.status,
      version: row.version,
    };
  },

  async applyResolution(tx, caller, input) {
    const row = await ownedNote(tx, caller, input.conflict.entityId);
    const values = UpdatePayload.parse(input.values);
    const updated = await writeFields(tx, row, values);
    await audit.record(tx, {
      action: 'test_note.resolve',
      entityType: 'test_note',
      entityId: row.id,
      after: values,
      ctx: caller.actor,
    });
    return summary(updated);
  },
};

/** Also in `mine` so one pull merges two entity types in `sync_seq` order. */
export const testRefHandler: SyncEntityHandler<RefRow> = {
  scopes: ['reference', 'mine'],
  async scopeFilter(tx, _caller, _scope, afterSeq, limit) {
    const result = await sql<RefRow>`
      SELECT * FROM test_ref WHERE sync_seq > ${afterSeq} ORDER BY sync_seq LIMIT ${limit}`.execute(
      tx,
    );
    return result.rows.map((row) => ({
      entityId: row.id,
      syncSeq: row.sync_seq,
      deleted: row.archived_at !== null,
      row,
    }));
  },
  serialize(row) {
    return { id: row.id, name: row.name };
  },
};

export function registerTestEntities(): void {
  registerEntity('test_note', testNoteHandler);
  registerEntity('test_ref', testRefHandler);
}
