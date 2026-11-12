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

/// <summary>Standard error envelope body: <c>{ "error": { code, message, details?, requestId } }</c>.</summary>
public sealed record ErrorEnvelope(ErrorBody Error);

public sealed record ErrorBody(string Code, string Message, System.Text.Json.JsonElement? Details = null, string? RequestId = null);
