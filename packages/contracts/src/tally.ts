import { z } from 'zod';
import { DateString, Uuid, type MoneyString, type QtyString, type RateString } from './common.js';
import {
  VoucherBaseType,
  type ConnectorStream,
  type CostCentreAllocation,
  type PostingMode,
} from './connector.js';

/** Admin and read endpoints of the `tally` module (INTERFACES section 2, tally rows, non-posting). */

export const CreateCompanyRequest = z.object({
  displayName: z.string().trim().min(1).max(200),
  tallyName: z.string().trim().min(1).max(300),
  companyNumber: z.string().trim().max(100).default(''),
  booksFrom: DateString,
  tallyGuid: z.string().trim().min(1).max(128).nullable().default(null),
  isTest: z.boolean().default(false),
});
export type CreateCompanyRequest = z.infer<typeof CreateCompanyRequest>;

export interface TallyCompanyDto {
  id: string;
  displayName: string;
  tallyName: string;
  companyNumber: string;
  booksFrom: string;
  tallyGuid: string | null;
  fingerprint: string;
  isTest: boolean;
  postingMode: PostingMode;
  createdAt: string;
  version: number;
}

/** Shown once, never stored in clear (SECURITY section 1). */
export interface RegistrationCodeDto {
  companyId: string;
  code: string;
  expiresAt: string;
}

export interface ConnectorAgentDto {
  id: string;
  companyId: string;
  machineName: string;
  agentVersion: string;
  status: 'ACTIVE' | 'REVOKED';
  registeredAt: string;
  lastSeenAt: string | null;
  lastStatus: Record<string, unknown> | null;
  isLeaseHolder: boolean;
}

export interface TallyStatusDto {
  companies: TallyCompanyStatusDto[];
}

export interface TallyCompanyStatusDto {
  companyId: string;
  displayName: string;
  tallyName: string;
  isTest: boolean;
  postingMode: PostingMode;
  lease: {
    holderAgentId: string;
    holderMachineName: string;
    epoch: number;
    expiresAt: string;
    active: boolean;
  } | null;
  lastHeartbeat: {
    agentId: string;
    at: string;
    tallyReachable: boolean;
    companyMatch: boolean;
    tallyVersion: string | null;
    journalPending: number;
    error: string | null;
  } | null;
  watermarks: {
    stream: ConnectorStream;
    lastAlterId: number;
    lastSuccessAt: string | null;
    lastFullReconAt: string | null;
  }[];
  freshness: {
    /** min(last_success_at of VOUCHERS, BALANCES); null when either never succeeded. */
    asOf: string | null;
    stale: boolean;
    staleAfterHours: number;
  };
}

const Limit = z.coerce.number().int().min(1).max(200).default(50);
const Cursor = z.string().min(1).max(400).optional();

export const LedgerListQuery = z.object({
  companyId: Uuid.optional(),
  q: z.string().trim().min(1).max(100).optional(),
  isParty: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  limit: Limit,
  cursor: Cursor,
});
export type LedgerListQuery = z.infer<typeof LedgerListQuery>;

export const VoucherListQuery = z.object({
  companyId: Uuid.optional(),
  from: DateString.optional(),
  to: DateString.optional(),
  baseType: VoucherBaseType.optional(),
  q: z.string().trim().min(1).max(100).optional(),
  includeDeleted: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(false),
  limit: Limit,
  cursor: Cursor,
});
export type VoucherListQuery = z.infer<typeof VoucherListQuery>;

/** Every mirror row says where it came from and how fresh it is (source label TALLY + as-of). */
export interface MirrorSourceDto {
  source: 'TALLY';
  /** When the row was last written by an import batch. */
  asOf: string;
}

export interface TallyLedgerDto extends MirrorSourceDto {
  id: string;
  companyId: string;
  guid: string;
  name: string;
  parentGroup: string | null;
  isParty: boolean;
  gstin: string | null;
  openingBalance: string | null;
  archivedInTally: boolean;
}

export interface TallyVoucherDto extends MirrorSourceDto {
  id: string;
  companyId: string;
  guid: string;
  voucherTypeName: string;
  baseType: VoucherBaseType;
  voucherNumber: string;
  voucherDate: string;
  reference: string | null;
  partyLedgerName: string | null;
  narration: string | null;
  amount: MoneyString;
  isCancelled: boolean;
  isDeletedInTally: boolean;
  erpEventId: string | null;
  alterId: number | null;
}

export interface TallyVoucherDetailDto extends TallyVoucherDto {
  ledgerLines: {
    lineNo: number;
    ledgerName: string;
    ledgerGuid: string | null;
    amount: MoneyString;
    isParty: boolean;
    costCentres: CostCentreAllocation[];
  }[];
  inventoryLines: {
    lineNo: number;
    stockItemName: string;
    stockItemGuid: string | null;
    qty: QtyString;
    uom: string | null;
    rate: RateString | null;
    amount: MoneyString;
    batchName: string | null;
    godown: string | null;
  }[];
}
