import { z } from 'zod';
import { DateString, MoneyString, QtyString, RateString } from './common.js';

/**
 * Connector wire contract (INTERFACES section 5, agent <-> cloud, `/connector/v1`).
 *
 * The agent is a .NET service, so ids it generates (batch ids, nonces) may be any RFC 4122 uuid, not
 * only v7. Money, quantities and rates stay decimal strings. Tally amounts are signed.
 *
 * ALTERID is NOT VERIFIED (TALLY_INTEGRATION section 8 items b and c), so every alter id is nullable:
 * the import identity is the guid plus a content hash, and the watermark fields are kept for the day
 * ALTERID is confirmed.
 */

/** Any RFC 4122 uuid (agent generated). Lower-cased on parse so comparisons are stable. */
export const AnyUuid = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    'Expected a UUID',
  )
  .transform((value) => value.toLowerCase());

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const Epoch = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const AlterId = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const NullableAlterId = AlterId.nullable().default(null);
const ShortText = z.string().max(500);
const Guid = z.string().min(1).max(128);

export const CONNECTOR_STREAMS = ['MASTERS', 'VOUCHERS', 'BALANCES'] as const;
export const ConnectorStream = z.enum(CONNECTOR_STREAMS);
export type ConnectorStream = z.infer<typeof ConnectorStream>;

export const POSTING_MODES = ['DISABLED', 'TEST_ONLY', 'PRODUCTION'] as const;
export const PostingMode = z.enum(POSTING_MODES);
export type PostingMode = z.infer<typeof PostingMode>;

export const CONNECTOR_COMMANDS = ['FULL_RECON', 'REFRESH_MASTERS', 'VERIFY_UNCERTAIN'] as const;
export const ConnectorCommand = z.enum(CONNECTOR_COMMANDS);
export type ConnectorCommand = z.infer<typeof ConnectorCommand>;

// ---------------------------------------------------------------------------
// Registration (unsigned) and company identity
// ---------------------------------------------------------------------------

export const RegisterRequest = z.object({
  // Any length reaches the service, which answers one generic 401 (no format oracle).
  registrationCode: z.string().min(1).max(64),
  machineName: z.string().trim().min(1).max(200),
  machineFingerprint: z.string().min(8).max(256),
  publicKeyPem: z.string().min(80).max(2000),
  agentVersion: z.string().trim().min(1).max(64),
});
export type RegisterRequest = z.infer<typeof RegisterRequest>;

export const ExpectedCompany = z.object({
  tallyName: z.string(),
  companyNumber: z.string(),
  booksFrom: DateString,
});
export type ExpectedCompany = z.infer<typeof ExpectedCompany>;

export const RegisterResponse = z.object({
  agentId: z.string(),
  companyId: z.string(),
  expectedCompany: ExpectedCompany,
});
export type RegisterResponse = z.infer<typeof RegisterResponse>;

export const ObservedCompany = z.object({
  tallyName: z.string().trim().min(1).max(300),
  companyNumber: z.string().max(100).default(''),
  booksFrom: DateString,
  guid: z.string().min(1).max(128).optional(),
});
export type ObservedCompany = z.infer<typeof ObservedCompany>;

export const CompanyVerifyRequest = z.object({ observed: ObservedCompany });
export type CompanyVerifyRequest = z.infer<typeof CompanyVerifyRequest>;

export const CompanyVerifyResponse = z.object({ match: z.boolean(), fingerprint: Sha256Hex });
export type CompanyVerifyResponse = z.infer<typeof CompanyVerifyResponse>;

// ---------------------------------------------------------------------------
// Lease and heartbeat
// ---------------------------------------------------------------------------

export const LeaseAcquireRequest = z.object({ companyFingerprint: Sha256Hex });
export type LeaseAcquireRequest = z.infer<typeof LeaseAcquireRequest>;

export const LeaseAcquireResponse = z.object({ epoch: Epoch, expiresAt: z.string() });
export type LeaseAcquireResponse = z.infer<typeof LeaseAcquireResponse>;

export const LeaseReleaseRequest = z.object({ epoch: Epoch });
export type LeaseReleaseRequest = z.infer<typeof LeaseReleaseRequest>;

export const HeartbeatRequest = z.object({
  epoch: Epoch,
  tallyReachable: z.boolean(),
  tallyVersion: z.string().max(64).nullable().default(null),
  companyMatch: z.boolean(),
  journalPending: z.number().int().nonnegative().max(1_000_000),
  lastError: z.string().max(2000).nullable().default(null),
});
export type HeartbeatRequest = z.infer<typeof HeartbeatRequest>;

export const HeartbeatResponse = z.object({
  expiresAt: z.string(),
  postingMode: PostingMode,
  commands: z.array(ConnectorCommand),
});
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

// ---------------------------------------------------------------------------
// Watermarks and import batches
// ---------------------------------------------------------------------------

export const WatermarkDto = z.object({
  stream: ConnectorStream,
  lastAlterId: AlterId,
  lastFullReconAt: z.string().nullable(),
});
export type WatermarkDto = z.infer<typeof WatermarkDto>;

const CommonMasterFields = {
  guid: Guid,
  name: z.string().trim().min(1).max(300),
  alterId: NullableAlterId,
  archived: z.boolean().default(false),
};

export const MasterRecord = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('GROUP'),
    ...CommonMasterFields,
    parent: ShortText.nullable().default(null),
  }),
  z.object({
    kind: z.literal('LEDGER'),
    ...CommonMasterFields,
    parentGroup: ShortText.nullable().default(null),
    isParty: z.boolean().default(false),
    gstin: z.string().max(32).nullable().default(null),
    openingBalance: MoneyString.nullable().default(null),
  }),
  z.object({
    kind: z.literal('STOCK_ITEM'),
    ...CommonMasterFields,
    parent: ShortText.nullable().default(null),
    unitName: ShortText.nullable().default(null),
  }),
  z.object({ kind: z.literal('UNIT'), ...CommonMasterFields }),
  z.object({
    kind: z.literal('VOUCHER_TYPE'),
    ...CommonMasterFields,
    parent: ShortText.nullable().default(null),
  }),
  z.object({
    kind: z.literal('COST_CENTRE'),
    ...CommonMasterFields,
    parent: ShortText.nullable().default(null),
  }),
]);
export type MasterRecord = z.infer<typeof MasterRecord>;

export const VOUCHER_BASE_TYPES = [
  'SALES',
  'PURCHASE',
  'RECEIPT',
  'PAYMENT',
  'JOURNAL',
  'CONTRA',
  'CREDIT_NOTE',
  'DEBIT_NOTE',
  'OTHER',
] as const;
export const VoucherBaseType = z.enum(VOUCHER_BASE_TYPES);
export type VoucherBaseType = z.infer<typeof VoucherBaseType>;

export const CostCentreAllocation = z.object({
  costCentre: z.string().min(1).max(300),
  amount: MoneyString,
});
export type CostCentreAllocation = z.infer<typeof CostCentreAllocation>;

export const VoucherLedgerLine = z.object({
  ledgerName: z.string().trim().min(1).max(300),
  ledgerGuid: Guid.nullable().default(null),
  amount: MoneyString,
  isParty: z.boolean().default(false),
  costCentres: z.array(CostCentreAllocation).max(50).default([]),
});
export type VoucherLedgerLine = z.infer<typeof VoucherLedgerLine>;

export const VoucherInventoryLine = z.object({
  stockItemName: z.string().trim().min(1).max(300),
  stockItemGuid: Guid.nullable().default(null),
  qty: QtyString,
  uom: z.string().max(50).nullable().default(null),
  rate: RateString.nullable().default(null),
  amount: MoneyString,
  batchName: z.string().max(200).nullable().default(null),
  godown: z.string().max(200).nullable().default(null),
});
export type VoucherInventoryLine = z.infer<typeof VoucherInventoryLine>;

export const VoucherRecord = z.object({
  guid: Guid,
  masterId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().default(null),
  alterId: NullableAlterId,
  voucherTypeName: z.string().trim().min(1).max(200),
  baseType: VoucherBaseType,
  voucherNumber: z.string().max(100).default(''),
  voucherDate: DateString,
  reference: z.string().max(300).nullable().default(null),
  partyLedgerName: z.string().max(300).nullable().default(null),
  partyLedgerGuid: Guid.nullable().default(null),
  narration: z.string().max(4000).nullable().default(null),
  amount: MoneyString,
  isCancelled: z.boolean().default(false),
  /** Tally's own `isdeleted` flag on the exported voucher. */
  isDeleted: z.boolean().default(false),
  ledgerLines: z.array(VoucherLedgerLine).max(200).default([]),
  inventoryLines: z.array(VoucherInventoryLine).max(500).default([]),
});
export type VoucherRecord = z.infer<typeof VoucherRecord>;

export const BalanceRecord = z.object({
  ledgerName: z.string().trim().min(1).max(300),
  ledgerGuid: Guid.nullable().default(null),
  asOf: DateString,
  closingBalance: MoneyString,
});
export type BalanceRecord = z.infer<typeof BalanceRecord>;

/** Records per import batch (SYNC_DESIGN section 5). */
export const IMPORT_BATCH_MAX_RECORDS = 500;
/** Entries per reconciliation snapshot (one request: a diff cannot be chunked). */
export const RECON_SNAPSHOT_MAX_VOUCHERS = 50_000;

const BatchHeader = {
  batchId: AnyUuid,
  epoch: Epoch,
  fromAlterId: NullableAlterId,
  toAlterId: NullableAlterId,
};

export const ImportBatchRequest = z
  .discriminatedUnion('stream', [
    z.object({
      ...BatchHeader,
      stream: z.literal('MASTERS'),
      records: z.array(MasterRecord).max(IMPORT_BATCH_MAX_RECORDS),
    }),
    z.object({
      ...BatchHeader,
      stream: z.literal('VOUCHERS'),
      records: z.array(VoucherRecord).max(IMPORT_BATCH_MAX_RECORDS),
    }),
    z.object({
      ...BatchHeader,
      stream: z.literal('BALANCES'),
      records: z.array(BalanceRecord).max(IMPORT_BATCH_MAX_RECORDS),
    }),
  ])
  .refine((b) => b.fromAlterId === null || b.toAlterId === null || b.toAlterId >= b.fromAlterId, {
    message: 'toAlterId must be >= fromAlterId',
    path: ['toAlterId'],
  });
export type ImportBatchRequest = z.infer<typeof ImportBatchRequest>;

export const ImportBatchResponse = z.object({
  status: z.literal('APPLIED'),
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
});
export type ImportBatchResponse = z.infer<typeof ImportBatchResponse>;

export const ReconSnapshotRequest = z
  .object({
    batchId: AnyUuid,
    epoch: Epoch,
    periodFrom: DateString,
    periodTo: DateString,
    /** True when the snapshot covers the whole financial year: stamps `last_full_recon_at`. */
    isFull: z.boolean().default(false),
    vouchers: z
      .array(z.object({ guid: Guid, alterId: NullableAlterId }))
      .max(RECON_SNAPSHOT_MAX_VOUCHERS),
  })
  .refine((s) => s.periodTo >= s.periodFrom, {
    message: 'periodTo must be on or after periodFrom',
    path: ['periodTo'],
  });
export type ReconSnapshotRequest = z.infer<typeof ReconSnapshotRequest>;

export const ReconSnapshotResponse = z.object({
  missingMarkedDeleted: z.number().int().nonnegative(),
});
export type ReconSnapshotResponse = z.infer<typeof ReconSnapshotResponse>;

export const VersionResponse = z.object({
  minimumVersion: z.string(),
  latestVersion: z.string(),
  downloadNote: z.string(),
});
export type VersionResponse = z.infer<typeof VersionResponse>;

/** Signed request headers (INTERFACES section 5). Timestamp is Unix seconds. */
export const CONNECTOR_HEADERS = {
  agentId: 'x-agent-id',
  timestamp: 'x-timestamp',
  nonce: 'x-nonce',
  signature: 'x-signature',
} as const;
export const CONNECTOR_TIMESTAMP_WINDOW_SECONDS = 300;
/** Lease time to live (SYNC_DESIGN section 4). */
export const LEASE_TTL_SECONDS = 90;
