using System.Text.Json.Serialization;

namespace TradeX.Agent.Core.Cloud;

// Wire DTOs mirroring packages/contracts/src/connector.ts (INTERFACES section 5). Property names are camelCase on the
// wire. Import batch and outbox DTOs are added by the WPs that use them (05.5 and Phase 11).

public sealed record RegisterRequest(
    string RegistrationCode,
    string MachineName,
    string MachineFingerprint,
    string PublicKeyPem,
    string AgentVersion);

public sealed record ExpectedCompany(string TallyName, string CompanyNumber, string BooksFrom);

public sealed record RegisterResponse(string AgentId, string CompanyId, ExpectedCompany ExpectedCompany);

public sealed record ObservedCompany(
    string TallyName,
    string CompanyNumber,
    string BooksFrom,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Guid = null);

public sealed record CompanyVerifyRequest(ObservedCompany Observed);

public sealed record CompanyVerifyResponse(bool Match, string Fingerprint);

public sealed record LeaseAcquireRequest(string CompanyFingerprint);

public sealed record LeaseAcquireResponse(long Epoch, string ExpiresAt);

public sealed record LeaseReleaseRequest(long Epoch);

public sealed record HeartbeatRequest(
    long Epoch,
    bool TallyReachable,
    string? TallyVersion,
    bool CompanyMatch,
    int JournalPending,
    string? LastError);

public sealed record HeartbeatResponse(string ExpiresAt, string PostingMode, IReadOnlyList<string> Commands);

public sealed record WatermarkDto(string Stream, long LastAlterId, string? LastFullReconAt);

public sealed record VersionResponse(string MinimumVersion, string LatestVersion, string DownloadNote);

// ---- import batches and reconciliation snapshots (SYNC_DESIGN section 5) -------------------------------------------
// The wire shape follows packages/contracts/src/connector.ts. Alter ids are always null: ALTERID is NOT VERIFIED
// (TALLY_INTEGRATION section 8 b and c), so the cloud identifies a record by guid plus content hash.

/// <summary>The import streams the agent feeds (masters, then vouchers, then balances).</summary>
public static class ImportStreams
{
    public const string Masters = "MASTERS";
    public const string Vouchers = "VOUCHERS";
    public const string Balances = "BALANCES";

    /// <summary>Maximum records per import batch (contracts <c>IMPORT_BATCH_MAX_RECORDS</c>).</summary>
    public const int MaxRecordsPerBatch = 500;
}

/// <summary>Command names the cloud may send in a heartbeat answer (contracts <c>CONNECTOR_COMMANDS</c>).</summary>
public static class AgentCommands
{
    public const string FullRecon = "FULL_RECON";
    public const string RefreshMasters = "REFRESH_MASTERS";
    public const string VerifyUncertain = "VERIFY_UNCERTAIN";
}

/// <summary>
/// One master record. Only the properties that belong to <see cref="Kind"/> are set; the others stay null and are left
/// out of the JSON (the cloud schema is a discriminated union and rejects explicit nulls for booleans).
/// </summary>
public sealed record MasterRecordDto(
    string Kind,
    string Guid,
    string Name,
    bool Archived = false,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Parent = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ParentGroup = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? IsParty = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Gstin = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? OpeningBalance = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? UnitName = null)
{
    public long? AlterId => null;
}

public sealed record VoucherLedgerLineDto(string LedgerName, string? LedgerGuid, string Amount, bool IsParty);

public sealed record VoucherRecordDto(
    string Guid,
    long? MasterId,
    string VoucherTypeName,
    string BaseType,
    string VoucherNumber,
    string VoucherDate,
    string? PartyLedgerName,
    string? Narration,
    string Amount,
    bool IsCancelled,
    bool IsDeleted,
    IReadOnlyList<VoucherLedgerLineDto> LedgerLines)
{
    public long? AlterId => null;
}

public sealed record BalanceRecordDto(string LedgerName, string? LedgerGuid, string AsOf, string ClosingBalance);

/// <summary>Body of <c>POST /import-batches</c>. The epoch is the lease epoch at the time of sending.</summary>
public sealed record ImportBatchRequest<TRecord>(
    string BatchId,
    long Epoch,
    string Stream,
    IReadOnlyList<TRecord> Records)
{
    public long? FromAlterId => null;
    public long? ToAlterId => null;
}

public sealed record ImportBatchResponse(string Status, int Created, int Updated, int Unchanged);

public sealed record ReconVoucherRef(string Guid)
{
    public long? AlterId => null;
}

/// <summary>Body of <c>POST /recon-snapshots</c>: the guids Tally holds inside the window.</summary>
public sealed record ReconSnapshotRequest(
    string BatchId,
    long Epoch,
    string PeriodFrom,
    string PeriodTo,
    bool IsFull,
    IReadOnlyList<ReconVoucherRef> Vouchers);

public sealed record ReconSnapshotResponse(int MissingMarkedDeleted);

/// <summary>Standard error envelope body: <c>{ "error": { code, message, details?, requestId } }</c>.</summary>
public sealed record ErrorEnvelope(ErrorBody Error);

public sealed record ErrorBody(string Code, string Message, System.Text.Json.JsonElement? Details = null, string? RequestId = null);
