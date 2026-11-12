using System.Net;
using System.Security.Cryptography;
using TradeX.Agent.Core.Cloud;
using TradeX.Agent.Core.Registration;
using TradeX.Agent.Core.Runtime;
using TradeX.Agent.Core.Security;

namespace TradeX.Agent.Tests.Fakes;

public static class Fp
{
    public static readonly string Fingerprint = new('a', 64);

    public static CloudApiException Api(HttpStatusCode status, string code) => new(status, code, code, null);
}

public sealed class FakeCloud : ICloudClient
{
    public Func<RegisterRequest, RegisterResponse> OnRegister { get; set; } = _ => throw new NotSupportedException();
    public Func<ObservedCompany, CompanyVerifyResponse> OnVerify { get; set; } = _ => new CompanyVerifyResponse(true, Fp.Fingerprint);
    public Func<string, LeaseAcquireResponse> OnAcquire { get; set; } = _ => new LeaseAcquireResponse(1, "2030-01-01T00:00:00.000Z");
    public Func<HeartbeatRequest, HeartbeatResponse> OnHeartbeat { get; set; } = _ => new HeartbeatResponse("2030-01-01T00:00:00.000Z", "DISABLED", []);

    public Func<string, ImportBatchResponse> OnPostBatch { get; set; } = _ => new ImportBatchResponse("APPLIED", 0, 0, 0);
    public Func<ReconSnapshotRequest, ReconSnapshotResponse> OnPostRecon { get; set; } = _ => new ReconSnapshotResponse(0);

    public List<long> Released { get; } = [];
    public List<HeartbeatRequest> Heartbeats { get; } = [];
    public int VerifyCalls { get; private set; }
    public int AcquireCalls { get; private set; }

    public Task<RegisterResponse> RegisterAsync(RegisterRequest request, CancellationToken ct) => Task.FromResult(OnRegister(request));

    public Task<CompanyVerifyResponse> VerifyCompanyAsync(ObservedCompany observed, CancellationToken ct)
    {
        VerifyCalls++;
        return Task.FromResult(OnVerify(observed));
    }

    public Task<LeaseAcquireResponse> AcquireLeaseAsync(string companyFingerprint, CancellationToken ct)
    {
        AcquireCalls++;
        return Task.FromResult(OnAcquire(companyFingerprint));
    }

    public Task ReleaseLeaseAsync(long epoch, CancellationToken ct)
    {
        Released.Add(epoch);
        return Task.CompletedTask;
    }

    public Task<HeartbeatResponse> HeartbeatAsync(HeartbeatRequest request, CancellationToken ct)
    {
        Heartbeats.Add(request);
        return Task.FromResult(OnHeartbeat(request));
    }

    public Task<IReadOnlyList<WatermarkDto>> GetWatermarksAsync(CancellationToken ct) => Task.FromResult<IReadOnlyList<WatermarkDto>>([]);

    public Task<VersionResponse> GetVersionAsync(CancellationToken ct) => Task.FromResult(new VersionResponse("0.1.0", "0.1.0", ""));

    public Task<ImportBatchResponse> PostImportBatchAsync(string batchJson, CancellationToken ct) => Task.FromResult(OnPostBatch(batchJson));

    public Task<ReconSnapshotResponse> PostReconSnapshotAsync(ReconSnapshotRequest request, CancellationToken ct) => Task.FromResult(OnPostRecon(request));
}

public sealed class FakeTally : ITallyProbe
{
    public Func<TallyProbeResult> OnProbe { get; set; } =
        () => new TallyProbeResult(true, "7.0", new ObservedCompany("Test Co", "1", "2024-04-01"), null);

    public Task<TallyProbeResult> ProbeAsync(CancellationToken ct) => Task.FromResult(OnProbe());
}

public sealed class MemoryKeyStore : IKeyStore
{
    private byte[]? _pkcs8;

    public bool Exists => _pkcs8 is not null;

    public ECDsa Load()
    {
        var key = ECDsa.Create();
        key.ImportPkcs8PrivateKey(_pkcs8 ?? throw new KeyStoreException("none"), out _);
        return key;
    }

    public void Save(ECDsa key) => _pkcs8 = key.ExportPkcs8PrivateKey();

    public void Delete() => _pkcs8 = null;
}

public sealed class MemoryIdentityStore : IIdentityStore
{
    public AgentIdentity? Stored { get; private set; }
    public bool FailOnSave { get; set; }
    public bool Exists => Stored is not null;
    public AgentIdentity? Load() => Stored;

    public void Save(AgentIdentity identity)
    {
        if (FailOnSave) throw new IOException("disk full");
        Stored = identity;
    }
}

public sealed class FakeMachine : IMachineInfo
{
    public string MachineName => "TALLY-PC";
    public string Fingerprint => "fingerprint-12345678";
}

/// <summary>Scripted HTTP handler: each request is answered by the next queued responder.</summary>
public sealed class StubHandler : HttpMessageHandler
{
    public Queue<Func<HttpRequestMessage, HttpResponseMessage>> Responses { get; } = new();
    public List<(HttpRequestMessage Request, byte[] Body)> Seen { get; } = [];

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var body = request.Content is null ? [] : await request.Content.ReadAsByteArrayAsync(cancellationToken);
        Seen.Add((request, body));
        if (Responses.Count == 0) throw new InvalidOperationException("No scripted response left.");
        return Responses.Dequeue()(request);
    }

    public static HttpResponseMessage Json(HttpStatusCode status, string json) => new(status)
    {
        Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json"),
    };

    public static HttpResponseMessage Error(HttpStatusCode status, string code, string? details = null)
    {
        var extra = details is null ? "" : ",\"details\":" + details;
        return Json(status, "{\"error\":{\"code\":\"" + code + "\",\"message\":\"" + code + " message\",\"requestId\":\"r1\"" + extra + "}}");
    }
}
