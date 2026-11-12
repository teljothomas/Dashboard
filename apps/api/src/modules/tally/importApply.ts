import { sql, type Insertable } from 'kysely';
import type {
  BalanceRecord,
  ImportBatchRequest,
  ImportBatchResponse,
  MasterRecord,
  ReconSnapshotRequest,
  ReconSnapshotResponse,
  VoucherRecord,
} from '@tradex/contracts';
import { uuidv7 } from '@tradex/domain';
import type { Database } from '../../db/index.js';
import type {
  TallyVoucher,
  TallyVoucherInventoryLine,
  TallyVoucherLedgerLine,
} from '../../db/generated.js';
import { AppError } from '../../errors.js';
import type { Tx } from '../core/context.js';
import { runVouchersImportedHooks, type ImportedVoucher } from './hooks.js';
import { assertLease, type AuthenticatedAgent } from './lease.js';
import { parseErpMarker } from './marker.js';
import { sha256Hex } from './signature.js';

/**
 * Import apply (SYNC_DESIGN section 5). Every batch runs in one transaction: lease check, batch row
 * (idempotent by batch id), upserts by (company_id, guid), hooks, watermark. Any failure rolls all of
 * it back, so the watermark only ever moves for a batch that was fully applied.
 *
 * ALTERID is NOT VERIFIED (TALLY_INTEGRATION section 8), so nothing here depends on it: an unchanged
 * re-export is recognised by a content hash, a changed voucher replaces the stored one, and an
 * incoming alter id lower than the stored one is ignored when both are known.
 */

interface Counts {
  created: number;
  updated: number;
  unchanged: number;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Keep the last record per key (a batch may repeat a guid; one upsert statement cannot touch a row twice). */
function lastWins<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const map = new Map<string, T>();
  for (const item of items) map.set(keyOf(item), item);
  return [...map.values()];
}

// ---------------------------------------------------------------------------
// Masters
// ---------------------------------------------------------------------------

const MASTER_TABLES = {
  GROUP: { table: 'tally_group', extra: ['parent'] },
  LEDGER: {
    table: 'tally_ledger',
    extra: ['parent_group', 'is_party', 'gstin', 'opening_balance'],
  },
  STOCK_ITEM: { table: 'tally_stock_item', extra: ['parent', 'unit_name'] },
  UNIT: { table: 'tally_unit', extra: [] },
  VOUCHER_TYPE: { table: 'tally_voucher_type', extra: ['parent'] },
  COST_CENTRE: { table: 'tally_cost_centre', extra: ['parent'] },
} as const satisfies Record<MasterRecord['kind'], { table: string; extra: readonly string[] }>;

function masterExtras(record: MasterRecord): Record<string, unknown> {
  switch (record.kind) {
    case 'GROUP':
    case 'VOUCHER_TYPE':
    case 'COST_CENTRE':
      return { parent: record.parent };
    case 'LEDGER':
      return {
        parent_group: record.parentGroup,
        is_party: record.isParty,
        gstin: record.gstin,
        opening_balance: record.openingBalance,
      };
    case 'STOCK_ITEM':
      return { parent: record.parent, unit_name: record.unitName };
    case 'UNIT':
      return {};
  }
}

async function upsertMasters(
  tx: Tx,
  kind: MasterRecord['kind'],
  companyId: string,
  batchId: string,
  records: readonly MasterRecord[],
): Promise<Counts> {
  const { table, extra } = MASTER_TABLES[kind];
  const t = sql.table(table);
  const columns = [
    'id',
    'company_id',
    'guid',
    'name',
    'alter_id',
    'archived_in_tally',
    ...extra,
    'last_import_batch_id',
  ];
  const changeColumns = ['name', 'alter_id', 'archived_in_tally', ...extra];
  const setClause = sql.join([
    ...changeColumns.map((c) => sql`${sql.ref(c)} = EXCLUDED.${sql.ref(c)}`),
    sql`last_import_batch_id = EXCLUDED.last_import_batch_id`,
    sql`updated_at = now()`,
  ]);
  const changed = sql.join(
    changeColumns.map((c) => sql`${t}.${sql.ref(c)} IS DISTINCT FROM EXCLUDED.${sql.ref(c)}`),
    sql` OR `,
  );

  const counts: Counts = { created: 0, updated: 0, unchanged: 0 };
  for (const part of chunk(records, 200)) {
    const rows = sql.join(
      part.map((record) => {
        const extras = masterExtras(record);
        return sql`(${sql.join([
          uuidv7(),
          companyId,
          record.guid,
          record.name,
          record.alterId,
          record.archived,
          ...extra.map((c) => extras[c] ?? null),
          batchId,
        ])})`;
      }),
    );
    const result = await sql<{ inserted: boolean }>`
      INSERT INTO ${t} (${sql.join(columns.map((c) => sql.ref(c)))})
      VALUES ${rows}
      ON CONFLICT (company_id, guid) DO UPDATE SET ${setClause}
      WHERE (${changed})
        AND (EXCLUDED.alter_id IS NULL OR ${t}.alter_id IS NULL OR EXCLUDED.alter_id >= ${t}.alter_id)
      RETURNING (xmax = 0) AS inserted`.execute(tx);
    const created = result.rows.filter((r) => r.inserted).length;
    counts.created += created;
    counts.updated += result.rows.length - created;
    counts.unchanged += part.length - result.rows.length;
  }
  return counts;
}

/** Tally party kinds from the parent group (DATA_MODEL section 6). Other groups leave kinds empty. */
function partyKinds(parentGroup: string | null): string[] {
  const group = (parentGroup ?? '').trim().toLowerCase();
  if (group === 'sundry debtors') return ['CUSTOMER'];
  if (group === 'sundry creditors') return ['SUPPLIER'];
  return [];
}

/**
 * The minimal `party` upsert hook (WP-05.2): party ledgers keep a `party` row in step with Tally. Only
 * rows with source TALLY are refreshed, so an ERP-created party linked later keeps its own values, and
 * `kinds` is set on insert only (it may be edited in the ERP afterwards).
 */
async function syncParties(
  tx: Tx,
  records: readonly Extract<MasterRecord, { kind: 'LEDGER' }>[],
): Promise<void> {
  const parties = records.filter((r) => r.isParty);
  for (const part of chunk(parties, 200)) {
    const rows = sql.join(
      part.map(
        (r) =>
          sql`(${sql.join([
            uuidv7(),
            r.name,
            sql`${partyKinds(r.parentGroup)}::text[]`,
            r.gstin,
            r.guid,
            'TALLY',
            r.archived ? sql`now()` : sql`NULL::timestamptz`,
          ])})`,
      ),
    );
    await sql`
      INSERT INTO party (id, name, kinds, gstin, tally_ledger_guid, source, archived_at)
      VALUES ${rows}
      ON CONFLICT (tally_ledger_guid) DO UPDATE SET
        name = EXCLUDED.name, gstin = EXCLUDED.gstin, archived_at = EXCLUDED.archived_at
      WHERE party.source = 'TALLY'
        AND (party.name, party.gstin, party.archived_at IS NULL)
            IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.gstin, EXCLUDED.archived_at IS NULL)`.execute(
      tx,
    );
  }
}

async function applyMasters(
  tx: Tx,
  companyId: string,
  batchId: string,
  records: readonly MasterRecord[],
): Promise<Counts> {
  const total: Counts = { created: 0, updated: 0, unchanged: 0 };
  const unique = lastWins(records, (r) => `${r.kind}:${r.guid}`);
  for (const kind of Object.keys(MASTER_TABLES) as MasterRecord['kind'][]) {
    const ofKind = unique.filter((r) => r.kind === kind);
    if (ofKind.length === 0) continue;
    const counts = await upsertMasters(tx, kind, companyId, batchId, ofKind);
    total.created += counts.created;
    total.updated += counts.updated;
    total.unchanged += counts.unchanged;
  }
  await syncParties(
    tx,
    unique.filter((r): r is Extract<MasterRecord, { kind: 'LEDGER' }> => r.kind === 'LEDGER'),
  );
  return total;
}

// ---------------------------------------------------------------------------
// Vouchers
// ---------------------------------------------------------------------------

/** Resolve names to guids from the masters already mirrored (Tally voucher exports carry names). */
async function guidsByName(
  tx: Tx,
  table: 'tally_ledger' | 'tally_stock_item',
  companyId: string,
  names: ReadonlySet<string>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (names.size === 0) return out;
  const lowered = [...names].map((n) => n.toLowerCase());
  for (const part of chunk(lowered, 1000)) {
    const rows = await tx
      .selectFrom(table)
      .select(['guid', 'name'])
      .where('company_id', '=', companyId)
      .where(sql<string>`lower(name)`, 'in', part)
      .orderBy('created_at')
      .execute();
    for (const row of rows) {
      const key = row.name.toLowerCase();
      if (!out.has(key)) out.set(key, row.guid);
    }
  }
  return out;
}

/** Content hash of an imported voucher: everything except the alter id (which may be unknown). */
function voucherContentHash(record: VoucherRecord): string {
  return sha256Hex(JSON.stringify({ ...record, alterId: undefined }));
}

async function applyVouchers(
  tx: Tx,
  companyId: string,
  batchId: string,
  records: readonly VoucherRecord[],
): Promise<{ counts: Counts; written: ImportedVoucher[] }> {
  const unique = lastWins(records, (r) => r.guid);
  const counts: Counts = { created: 0, updated: 0, unchanged: 0 };
  if (unique.length === 0) return { counts, written: [] };

  const ledgerNames = new Set<string>();
  const stockNames = new Set<string>();
  for (const r of unique) {
    if (r.partyLedgerName && !r.partyLedgerGuid) ledgerNames.add(r.partyLedgerName);
    for (const line of r.ledgerLines) if (!line.ledgerGuid) ledgerNames.add(line.ledgerName);
    for (const line of r.inventoryLines)
      if (!line.stockItemGuid) stockNames.add(line.stockItemName);
  }
  const ledgerGuids = await guidsByName(tx, 'tally_ledger', companyId, ledgerNames);
  const stockGuids = await guidsByName(tx, 'tally_stock_item', companyId, stockNames);

  const existing = new Map<
    string,
    { id: string; content_hash: string; alter_id: string | null; is_deleted_in_tally: boolean }
  >();
  for (const part of chunk(unique, 1000)) {
    const rows = await tx
      .selectFrom('tally_voucher')
      .select(['id', 'guid', 'content_hash', 'alter_id', 'is_deleted_in_tally'])
      .where('company_id', '=', companyId)
      .where(
        'guid',
        'in',
        part.map((r) => r.guid),
      )
      .execute();
    for (const row of rows) existing.set(row.guid, row);
  }

  const contentOf = (record: VoucherRecord, hash: string) => ({
    master_id: record.masterId,
    alter_id: record.alterId,
    voucher_type_name: record.voucherTypeName,
    base_type: record.baseType,
    voucher_number: record.voucherNumber,
    voucher_date: record.voucherDate,
    reference: record.reference,
    party_ledger_name: record.partyLedgerName,
    party_ledger_guid:
      record.partyLedgerGuid ??
      (record.partyLedgerName
        ? (ledgerGuids.get(record.partyLedgerName.toLowerCase()) ?? null)
        : null),
    narration: record.narration,
    amount: record.amount,
    is_cancelled: record.isCancelled,
    is_deleted_in_tally: record.isDeleted,
    erp_event_id: parseErpMarker(record.narration),
    content_hash: hash,
    last_import_batch_id: batchId,
  });
  const toRow = (record: VoucherRecord, id: string, hash: string): Insertable<TallyVoucher> => ({
    id,
    company_id: companyId,
    guid: record.guid,
    ...contentOf(record, hash),
  });

  const fresh: { record: VoucherRecord; id: string; hash: string }[] = [];
  const changed: { record: VoucherRecord; id: string; hash: string }[] = [];
  for (const record of unique) {
    const hash = voucherContentHash(record);
    const old = existing.get(record.guid);
    if (!old) {
      fresh.push({ record, id: uuidv7(), hash });
      continue;
    }
    const oldAlter = old.alter_id === null ? null : Number(old.alter_id);
    const olderThanStored =
      record.alterId !== null && oldAlter !== null && record.alterId < oldAlter;
    const same =
      old.content_hash === hash &&
      old.is_deleted_in_tally === record.isDeleted &&
      (record.alterId === null || record.alterId === oldAlter);
    if (olderThanStored || same) {
      counts.unchanged += 1;
    } else {
      changed.push({ record, id: old.id, hash });
    }
  }

  const written: ImportedVoucher[] = [];
  const lineTargets = new Map<string, VoucherRecord>();

  for (const part of chunk(fresh, 100)) {
    const inserted = await tx
      .insertInto('tally_voucher')
      .values(part.map((p) => toRow(p.record, p.id, p.hash)))
      .onConflict((oc) => oc.columns(['company_id', 'guid']).doNothing())
      .returning(['id', 'guid'])
      .execute();
    const ids = new Set(inserted.map((r) => r.id));
    for (const p of part) {
      if (!ids.has(p.id)) {
        counts.unchanged += 1; // lost a race with an identical concurrent write
        continue;
      }
      counts.created += 1;
      lineTargets.set(p.id, p.record);
      written.push(summaryOf(p.id, p.record, true));
    }
  }

  for (const p of changed) {
    await tx
      .updateTable('tally_voucher')
      .set({ ...contentOf(p.record, p.hash), updated_at: sql`now()` })
      .where('id', '=', p.id)
      .execute();
    counts.updated += 1;
    lineTargets.set(p.id, p.record);
    written.push(summaryOf(p.id, p.record, false));
  }

  const changedIds = changed.map((p) => p.id);
  for (const part of chunk(changedIds, 1000)) {
    await tx.deleteFrom('tally_voucher_ledger_line').where('voucher_id', 'in', part).execute();
    await tx.deleteFrom('tally_voucher_inventory_line').where('voucher_id', 'in', part).execute();
  }

  const ledgerLines: Insertable<TallyVoucherLedgerLine>[] = [];
  const inventoryLines: Insertable<TallyVoucherInventoryLine>[] = [];
  for (const [voucherId, record] of lineTargets) {
    record.ledgerLines.forEach((line, index) => {
      ledgerLines.push({
        id: uuidv7(),
        voucher_id: voucherId,
        line_no: index + 1,
        ledger_name: line.ledgerName,
        ledger_guid: line.ledgerGuid ?? ledgerGuids.get(line.ledgerName.toLowerCase()) ?? null,
        amount: line.amount,
        is_party: line.isParty,
        // JSON.stringify: node-postgres turns JS arrays into PG arrays, not jsonb.
        cost_centres: JSON.stringify(line.costCentres),
      });
    });
    record.inventoryLines.forEach((line, index) => {
      inventoryLines.push({
        id: uuidv7(),
        voucher_id: voucherId,
        line_no: index + 1,
        stock_item_name: line.stockItemName,
        stock_item_guid:
          line.stockItemGuid ?? stockGuids.get(line.stockItemName.toLowerCase()) ?? null,
        qty: line.qty,
        uom: line.uom,
        rate: line.rate,
        amount: line.amount,
        batch_name: line.batchName,
        godown: line.godown,
      });
    });
  }
  for (const part of chunk(ledgerLines, 500)) {
    await tx.insertInto('tally_voucher_ledger_line').values(part).execute();
  }
  for (const part of chunk(inventoryLines, 500)) {
    await tx.insertInto('tally_voucher_inventory_line').values(part).execute();
  }

  return { counts, written };
}

function summaryOf(id: string, record: VoucherRecord, isNew: boolean): ImportedVoucher {
  return {
    id,
    guid: record.guid,
    isNew,
    baseType: record.baseType,
    voucherNumber: record.voucherNumber,
    voucherDate: record.voucherDate,
    amount: record.amount,
    erpEventId: parseErpMarker(record.narration),
    isDeletedInTally: record.isDeleted,
  };
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

async function applyBalances(
  tx: Tx,
  companyId: string,
  batchId: string,
  records: readonly BalanceRecord[],
): Promise<Counts> {
  const unique = lastWins(records, (r) => `${r.ledgerName}\u0000${r.asOf}`);
  const counts: Counts = { created: 0, updated: 0, unchanged: 0 };
  const names = new Set(unique.filter((r) => !r.ledgerGuid).map((r) => r.ledgerName));
  const guids = await guidsByName(tx, 'tally_ledger', companyId, names);
  for (const part of chunk(unique, 200)) {
    const rows = await tx
      .insertInto('tally_balance_snapshot')
      .values(
        part.map((r) => ({
          id: uuidv7(),
          company_id: companyId,
          ledger_name: r.ledgerName,
          ledger_guid: r.ledgerGuid ?? guids.get(r.ledgerName.toLowerCase()) ?? null,
          as_of: r.asOf,
          closing_balance: r.closingBalance,
          last_import_batch_id: batchId,
        })),
      )
      .onConflict((oc) =>
        oc
          .columns(['company_id', 'ledger_name', 'as_of'])
          .doUpdateSet({
            closing_balance: sql`EXCLUDED.closing_balance`,
            ledger_guid: sql`COALESCE(EXCLUDED.ledger_guid, tally_balance_snapshot.ledger_guid)`,
            last_import_batch_id: sql`EXCLUDED.last_import_batch_id`,
            imported_at: sql`now()`,
          })
          .where(sql<boolean>`tally_balance_snapshot.closing_balance <> EXCLUDED.closing_balance`),
      )
      .returning(sql<boolean>`(xmax = 0)`.as('inserted'))
      .execute();
    const created = rows.filter((r) => r.inserted).length;
    counts.created += created;
    counts.updated += rows.length - created;
    counts.unchanged += part.length - rows.length;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Batch entry points
// ---------------------------------------------------------------------------

interface BatchRow {
  id: string;
  company_id: string;
  stream: string;
  payload_sha256: string;
  status: string;
  result_summary: unknown;
}

/**
 * Insert the batch row, or find the earlier one. The same batch id with the same content is an
 * idempotent replay (returns the stored result without applying again); anything else under that id is
 * IDEMPOTENCY_MISMATCH.
 */
async function claimBatch(
  tx: Tx,
  agent: AuthenticatedAgent,
  input: {
    id: string;
    epoch: number;
    stream: 'MASTERS' | 'VOUCHERS' | 'BALANCES' | 'RECON';
    fromAlterId: number | null;
    toAlterId: number | null;
    recordCount: number;
    hash: string;
  },
): Promise<{ replay: BatchRow } | { replay: null }> {
  const inserted = await tx
    .insertInto('import_batch')
    .values({
      id: input.id,
      company_id: agent.companyId,
      agent_id: agent.id,
      epoch: input.epoch,
      stream: input.stream,
      from_alter_id: input.fromAlterId,
      to_alter_id: input.toAlterId,
      record_count: input.recordCount,
      payload_sha256: input.hash,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .returning('id')
    .executeTakeFirst();
  if (inserted) return { replay: null };

  const old = await tx
    .selectFrom('import_batch')
    .select(['id', 'company_id', 'stream', 'payload_sha256', 'status', 'result_summary'])
    .where('id', '=', input.id)
    .executeTakeFirstOrThrow();
  if (
    old.company_id !== agent.companyId ||
    old.stream !== input.stream ||
    old.payload_sha256 !== input.hash
  ) {
    throw new AppError('IDEMPOTENCY_MISMATCH', 'Batch id was already used with different content.');
  }
  if (old.status !== 'APPLIED') {
    throw new Error(
      `import_batch ${old.id} is ${old.status}; a batch is applied in the transaction that creates it`,
    );
  }
  return { replay: old };
}

async function advanceWatermark(
  tx: Tx,
  companyId: string,
  stream: 'MASTERS' | 'VOUCHERS' | 'BALANCES',
  toAlterId: number | null,
): Promise<void> {
  await sql`
    INSERT INTO sync_watermark (company_id, stream, last_alter_id, last_success_at)
    VALUES (${companyId}, ${stream}, ${toAlterId ?? 0}, now())
    ON CONFLICT (company_id, stream) DO UPDATE SET
      last_alter_id = GREATEST(sync_watermark.last_alter_id, EXCLUDED.last_alter_id),
      last_success_at = now()`.execute(tx);
}

function summaryFrom(stored: unknown): ImportBatchResponse {
  const s = (stored ?? {}) as Partial<Counts>;
  return {
    status: 'APPLIED',
    created: s.created ?? 0,
    updated: s.updated ?? 0,
    unchanged: s.unchanged ?? 0,
  };
}

/** `POST /import-batches`. */
export async function applyImportBatch(
  db: Database,
  agent: AuthenticatedAgent,
  request: ImportBatchRequest,
): Promise<ImportBatchResponse> {
  const hash = sha256Hex(
    JSON.stringify({
      stream: request.stream,
      fromAlterId: request.fromAlterId,
      toAlterId: request.toAlterId,
      records: request.records,
    }),
  );
  return db.transaction().execute(async (tx) => {
    await assertLease(tx, agent, request.epoch);
    const claim = await claimBatch(tx, agent, {
      id: request.batchId,
      epoch: request.epoch,
      stream: request.stream,
      fromAlterId: request.fromAlterId,
      toAlterId: request.toAlterId,
      recordCount: request.records.length,
      hash,
    });
    if (claim.replay) return summaryFrom(claim.replay.result_summary);

    let counts: Counts;
    if (request.stream === 'MASTERS') {
      counts = await applyMasters(tx, agent.companyId, request.batchId, request.records);
    } else if (request.stream === 'VOUCHERS') {
      const result = await applyVouchers(tx, agent.companyId, request.batchId, request.records);
      counts = result.counts;
      await runVouchersImportedHooks(tx, {
        companyId: agent.companyId,
        batchId: request.batchId,
        vouchers: result.written,
      });
    } else {
      counts = await applyBalances(tx, agent.companyId, request.batchId, request.records);
    }

    await tx
      .updateTable('import_batch')
      .set({
        status: 'APPLIED',
        applied_at: sql`now()`,
        result_summary: JSON.stringify(counts),
      })
      .where('id', '=', request.batchId)
      .execute();
    await advanceWatermark(tx, agent.companyId, request.stream, request.toAlterId);
    return { status: 'APPLIED', ...counts };
  });
}

/**
 * `POST /recon-snapshots` (SYNC_DESIGN section 5 step 4). Vouchers dated inside the window that the
 * snapshot does not list are flagged `is_deleted_in_tally` (never physically deleted); vouchers it does
 * list inside the window have the flag cleared. One request carries the whole window, because a diff
 * cannot be chunked.
 */
export async function applyReconSnapshot(
  db: Database,
  agent: AuthenticatedAgent,
  request: ReconSnapshotRequest,
): Promise<ReconSnapshotResponse> {
  const guids = request.vouchers.map((v) => v.guid);
  const hash = sha256Hex(
    JSON.stringify({
      periodFrom: request.periodFrom,
      periodTo: request.periodTo,
      isFull: request.isFull,
      guids: [...guids].sort(),
    }),
  );
  return db.transaction().execute(async (tx) => {
    await assertLease(tx, agent, request.epoch);
    const claim = await claimBatch(tx, agent, {
      id: request.batchId,
      epoch: request.epoch,
      stream: 'RECON',
      fromAlterId: null,
      toAlterId: null,
      recordCount: guids.length,
      hash,
    });
    if (claim.replay) {
      const stored = claim.replay.result_summary as { missingMarkedDeleted?: number } | null;
      return { missingMarkedDeleted: stored?.missingMarkedDeleted ?? 0 };
    }

    const flagged = await sql<{ id: string }>`
      UPDATE tally_voucher SET is_deleted_in_tally = true, updated_at = now()
      WHERE company_id = ${agent.companyId}
        AND voucher_date BETWEEN ${request.periodFrom}::date AND ${request.periodTo}::date
        AND NOT is_deleted_in_tally
        AND guid <> ALL(${guids}::text[])
      RETURNING id`.execute(tx);
    await sql`
      UPDATE tally_voucher SET is_deleted_in_tally = false, updated_at = now()
      WHERE company_id = ${agent.companyId}
        AND voucher_date BETWEEN ${request.periodFrom}::date AND ${request.periodTo}::date
        AND is_deleted_in_tally
        AND guid = ANY(${guids}::text[])`.execute(tx);

    const summary = { missingMarkedDeleted: flagged.rows.length };
    await tx
      .updateTable('import_batch')
      .set({ status: 'APPLIED', applied_at: sql`now()`, result_summary: JSON.stringify(summary) })
      .where('id', '=', request.batchId)
      .execute();
    if (request.isFull) {
      await sql`
        INSERT INTO sync_watermark (company_id, stream, last_full_recon_at)
        VALUES (${agent.companyId}, 'VOUCHERS', now())
        ON CONFLICT (company_id, stream) DO UPDATE SET last_full_recon_at = now()`.execute(tx);
    }
    return summary;
  });
}
