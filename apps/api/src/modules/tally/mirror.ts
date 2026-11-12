import { sql, type Selectable } from 'kysely';
import type {
  LedgerListQuery,
  PostingMode,
  TallyCompanyStatusDto,
  TallyLedgerDto,
  TallyStatusDto,
  TallyVoucherDetailDto,
  TallyVoucherDto,
  VoucherBaseType,
  VoucherListQuery,
} from '@tradex/contracts';
import { CONNECTOR_STREAMS } from '@tradex/contracts';
import type { Database } from '../../db/index.js';
import type { TallyLedger, TallyVoucher } from '../../db/generated.js';
import { AppError } from '../../errors.js';
import { dateOnly } from './dates.js';
import * as settings from '../core/settings.js';

/** Fallback when `tally_stale_hours` has no row (SYNC_DESIGN section 6 default). */
const DEFAULT_STALE_HOURS = 24;

// ---------------------------------------------------------------------------
// Status (GET /tally/status)
// ---------------------------------------------------------------------------

async function staleHours(db: Database): Promise<number> {
  try {
    return (await settings.get(db, 'tally_stale_hours')).value;
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') return DEFAULT_STALE_HOURS;
    throw error;
  }
}

/**
 * Connection and freshness per company: lease holder, last heartbeat, watermarks, and the staleness
 * flag (SYNC_DESIGN section 6: min of the VOUCHERS and BALANCES last success; stale when either never
 * succeeded or the older one is past `tally_stale_hours`).
 */
export async function getStatus(db: Database): Promise<TallyStatusDto> {
  const staleAfterHours = await staleHours(db);
  const companies = await db
    .selectFrom('tally_company')
    .select(['id', 'display_name', 'tally_name', 'is_test', 'posting_mode'])
    .orderBy('created_at')
    .orderBy('id')
    .execute();

  const result: TallyCompanyStatusDto[] = [];
  for (const company of companies) {
    const lease = await db
      .selectFrom('connector_lease as l')
      .innerJoin('connector_agent as a', 'a.id', 'l.agent_id')
      .select([
        'l.agent_id',
        'a.machine_name',
        'l.epoch',
        'l.expires_at',
        sql<boolean>`l.expires_at > now()`.as('active'),
      ])
      .where('l.company_id', '=', company.id)
      .executeTakeFirst();
    const heartbeat = await db
      .selectFrom('connector_heartbeat as h')
      .innerJoin('connector_agent as a', 'a.id', 'h.agent_id')
      .selectAll('h')
      .where('a.company_id', '=', company.id)
      .orderBy('h.at', 'desc')
      .orderBy('h.id', 'desc')
      .limit(1)
      .executeTakeFirst();
    const marks = await db
      .selectFrom('sync_watermark')
      .selectAll()
      .where('company_id', '=', company.id)
      .execute();

    const byStream = new Map(marks.map((m) => [m.stream, m]));
    const watermarks = CONNECTOR_STREAMS.map((stream) => {
      const mark = byStream.get(stream);
      return {
        stream,
        lastAlterId: mark ? Number(mark.last_alter_id) : 0,
        lastSuccessAt: mark?.last_success_at ? mark.last_success_at.toISOString() : null,
        lastFullReconAt: mark?.last_full_recon_at ? mark.last_full_recon_at.toISOString() : null,
      };
    });
    const vouchersAt = byStream.get('VOUCHERS')?.last_success_at ?? null;
    const balancesAt = byStream.get('BALANCES')?.last_success_at ?? null;
    const asOf =
      vouchersAt && balancesAt ? (vouchersAt < balancesAt ? vouchersAt : balancesAt) : null;
    const stale = asOf === null || Date.now() - asOf.getTime() > staleAfterHours * 3_600_000;

    result.push({
      companyId: company.id,
      displayName: company.display_name,
      tallyName: company.tally_name,
      isTest: company.is_test,
      postingMode: company.posting_mode as PostingMode,
      lease: lease
        ? {
            holderAgentId: lease.agent_id,
            holderMachineName: lease.machine_name,
            epoch: Number(lease.epoch),
            expiresAt: lease.expires_at.toISOString(),
            active: lease.active,
          }
        : null,
      lastHeartbeat: heartbeat
        ? {
            agentId: heartbeat.agent_id,
            at: heartbeat.at.toISOString(),
            tallyReachable: heartbeat.tally_reachable,
            companyMatch: heartbeat.company_match,
            tallyVersion: heartbeat.tally_version,
            journalPending: heartbeat.local_queue,
            error: heartbeat.error,
          }
        : null,
      watermarks,
      freshness: { asOf: asOf ? asOf.toISOString() : null, stale, staleAfterHours },
    });
  }
  return { companies: result };
}

// ---------------------------------------------------------------------------
// Mirror reads: opaque keyset cursors
// ---------------------------------------------------------------------------

function encodeCursor(parts: readonly string[]): string {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string, size: number): string[] {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === size &&
      parsed.every((p): p is string => typeof p === 'string')
    ) {
      return parsed;
    }
  } catch {
    // fall through
  }
  throw new AppError('VALIDATION_FAILED', 'Invalid cursor', {
    fields: [{ path: 'cursor', message: 'invalid' }],
  });
}

/** Escape `%`, `_` and `\` so user text is matched literally by ILIKE. */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function ledgerDto(row: Selectable<TallyLedger>): TallyLedgerDto {
  return {
    source: 'TALLY',
    asOf: row.updated_at.toISOString(),
    id: row.id,
    companyId: row.company_id,
    guid: row.guid,
    name: row.name,
    parentGroup: row.parent_group,
    isParty: row.is_party,
    gstin: row.gstin,
    openingBalance: row.opening_balance,
    archivedInTally: row.archived_in_tally,
  };
}

function voucherDto(row: Selectable<TallyVoucher>): TallyVoucherDto {
  return {
    source: 'TALLY',
    asOf: row.updated_at.toISOString(),
    id: row.id,
    companyId: row.company_id,
    guid: row.guid,
    voucherTypeName: row.voucher_type_name,
    baseType: row.base_type as VoucherBaseType,
    voucherNumber: row.voucher_number,
    voucherDate: dateOnly(row.voucher_date),
    reference: row.reference,
    partyLedgerName: row.party_ledger_name,
    narration: row.narration,
    amount: row.amount,
    isCancelled: row.is_cancelled,
    isDeletedInTally: row.is_deleted_in_tally,
    erpEventId: row.erp_event_id,
    alterId: row.alter_id === null ? null : Number(row.alter_id),
  };
}

export async function listLedgers(
  db: Database,
  query: LedgerListQuery,
): Promise<{ items: TallyLedgerDto[]; nextCursor: string | null }> {
  let q = db
    .selectFrom('tally_ledger')
    .selectAll()
    .orderBy('name')
    .orderBy('id')
    .limit(query.limit + 1);
  if (query.companyId) q = q.where('company_id', '=', query.companyId);
  if (query.isParty !== undefined) q = q.where('is_party', '=', query.isParty);
  if (query.q) q = q.where('name', 'ilike', likePattern(query.q));
  if (query.cursor) {
    const [name, id] = decodeCursor(query.cursor, 2) as [string, string];
    q = q.where(sql<boolean>`(name, id) > (${name}, ${id}::uuid)`);
  }
  const rows = await q.execute();
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(ledgerDto),
    nextCursor: rows.length > query.limit && last ? encodeCursor([last.name, last.id]) : null,
  };
}

export async function listVouchers(
  db: Database,
  query: VoucherListQuery,
): Promise<{ items: TallyVoucherDto[]; nextCursor: string | null }> {
  let q = db
    .selectFrom('tally_voucher')
    .selectAll()
    .orderBy('voucher_date', 'desc')
    .orderBy('id', 'desc')
    .limit(query.limit + 1);
  if (query.companyId) q = q.where('company_id', '=', query.companyId);
  if (query.from) q = q.where('voucher_date', '>=', sql<Date>`${query.from}::date`);
  if (query.to) q = q.where('voucher_date', '<=', sql<Date>`${query.to}::date`);
  if (query.baseType) q = q.where('base_type', '=', query.baseType);
  if (!query.includeDeleted) q = q.where('is_deleted_in_tally', '=', false);
  if (query.q) {
    const pattern = likePattern(query.q);
    q = q.where((eb) =>
      eb.or([
        eb('voucher_number', 'ilike', pattern),
        eb('party_ledger_name', 'ilike', pattern),
        eb('narration', 'ilike', pattern),
        eb('reference', 'ilike', pattern),
      ]),
    );
  }
  if (query.cursor) {
    const [date, id] = decodeCursor(query.cursor, 2) as [string, string];
    q = q.where(sql<boolean>`(voucher_date, id) < (${date}::date, ${id}::uuid)`);
  }
  const rows = await q.execute();
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(voucherDto),
    nextCursor:
      rows.length > query.limit && last
        ? encodeCursor([dateOnly(last.voucher_date), last.id])
        : null,
  };
}

export async function getVoucher(
  db: Database,
  guid: string,
  companyId?: string,
): Promise<TallyVoucherDetailDto> {
  let q = db.selectFrom('tally_voucher').selectAll().where('guid', '=', guid).limit(1);
  if (companyId) q = q.where('company_id', '=', companyId);
  const row = await q.executeTakeFirst();
  if (!row) throw new AppError('NOT_FOUND', 'Voucher not found');
  const [ledgerLines, inventoryLines] = await Promise.all([
    db
      .selectFrom('tally_voucher_ledger_line')
      .selectAll()
      .where('voucher_id', '=', row.id)
      .orderBy('line_no')
      .execute(),
    db
      .selectFrom('tally_voucher_inventory_line')
      .selectAll()
      .where('voucher_id', '=', row.id)
      .orderBy('line_no')
      .execute(),
  ]);
  return {
    ...voucherDto(row),
    ledgerLines: ledgerLines.map((l) => ({
      lineNo: l.line_no,
      ledgerName: l.ledger_name,
      ledgerGuid: l.ledger_guid,
      amount: l.amount,
      isParty: l.is_party,
      costCentres: l.cost_centres as TallyVoucherDetailDto['ledgerLines'][number]['costCentres'],
    })),
    inventoryLines: inventoryLines.map((l) => ({
      lineNo: l.line_no,
      stockItemName: l.stock_item_name,
      stockItemGuid: l.stock_item_guid,
      qty: l.qty,
      uom: l.uom,
      rate: l.rate,
      amount: l.amount,
      batchName: l.batch_name,
      godown: l.godown,
    })),
  };
}
