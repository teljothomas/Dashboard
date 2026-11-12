using System.Net.Http.Json;
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;

namespace TradeX.Agent.Core.Cloud;

/// <summary>A non-success answer from the cloud, with the standard error envelope fields.</summary>
public sealed class CloudApiException(HttpStatusCode status, string code, string message, JsonElement? details)
    : Exception($"{(int)status} {code}: {message}")
{
    public HttpStatusCode StatusCode { get; } = status;
    public string Code { get; } = code;
    public JsonElement? Details { get; } = details;

    /// <summary>The lease is not held at this epoch: the agent must stop work and re-acquire.</summary>
    public bool IsLeaseStale => Code == "LEASE_STALE";

    /// <summary>Another agent holds the lease.</summary>
    public bool IsLeaseHeld => Code == "LEASE_HELD";

    public bool IsAuthFailure => StatusCode == HttpStatusCode.Unauthorized;
}

/// <summary>The cloud could not be reached after all retries.</summary>
public sealed class CloudUnavailableException(string message, Exception? inner = null) : Exception(message, inner);

public interface ICloudClient
{
    Task<RegisterResponse> RegisterAsync(RegisterRequest request, CancellationToken ct);
    Task<CompanyVerifyResponse> VerifyCompanyAsync(ObservedCompany observed, CancellationToken ct);
    Task<LeaseAcquireResponse> AcquireLeaseAsync(string companyFingerprint, CancellationToken ct);
    Task ReleaseLeaseAsync(long epoch, CancellationToken ct);
    Task<HeartbeatResponse> HeartbeatAsync(HeartbeatRequest request, CancellationToken ct);
    Task<IReadOnlyList<WatermarkDto>> GetWatermarksAsync(CancellationToken ct);
    Task<VersionResponse> GetVersionAsync(CancellationToken ct);

    /// <summary>
    /// Sends an already serialised <see cref="ImportBatchRequest{TRecord}"/> body. The body is a string so the journal can
    /// keep the exact payload on disk and resend it after a network loss; the batch id makes the resend idempotent.
    /// </summary>
    Task<ImportBatchResponse> PostImportBatchAsync(string batchJson, CancellationToken ct);

    Task<ReconSnapshotResponse> PostReconSnapshotAsync(ReconSnapshotRequest request, CancellationToken ct);
}

public sealed record CloudRetryPolicy(int MaxRetries, TimeSpan BaseDelay)
{
    public static CloudRetryPolicy Default { get; } = new(4, TimeSpan.FromMilliseconds(500));
}

/// <summary>
/// Typed client for <c>/connector/v1</c>. Each attempt builds a fresh request (so the signing handler issues a new
/// nonce) and transient failures (network errors, timeouts, 408, 429, 5xx) are retried with exponential backoff and
/// full jitter. Business answers (4xx) are never retried. Lease and heartbeat calls are idempotent on the server.
/// </summary>
public sealed class CloudClient : ICloudClient
{
    /// <summary>Wire serialisation: camelCase, nulls written (the cloud schemas use nullable-with-default fields).</summary>
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.Never,
    };

    private const string Base = "/connector/v1";
    private static readonly TimeSpan MaxBackoff = TimeSpan.FromSeconds(60);

    private readonly HttpClient _http;
    private readonly CloudRetryPolicy _retry;
    private readonly Func<TimeSpan, CancellationToken, Task> _delay;
    private readonly Func<double> _random;

    public CloudClient(
        HttpClient http,
        CloudRetryPolicy? retry = null,
        Func<TimeSpan, CancellationToken, Task>? delay = null,
        Func<double>? random = null)
    {
        _http = http;
        _retry = retry ?? CloudRetryPolicy.Default;
        _delay = delay ?? Task.Delay;
        _random = random ?? Random.Shared.NextDouble;
    }

    public Task<RegisterResponse> RegisterAsync(RegisterRequest request, CancellationToken ct) =>
        SendAsync<RegisterResponse>(HttpMethod.Post, $"{Base}/register", request, signed: false, ct);

    public Task<CompanyVerifyResponse> VerifyCompanyAsync(ObservedCompany observed, CancellationToken ct) =>
        SendAsync<CompanyVerifyResponse>(HttpMethod.Post, $"{Base}/company/verify", new CompanyVerifyRequest(observed), true, ct);

    public Task<LeaseAcquireResponse> AcquireLeaseAsync(string companyFingerprint, CancellationToken ct) =>
        SendAsync<LeaseAcquireResponse>(HttpMethod.Post, $"{Base}/lease/acquire", new LeaseAcquireRequest(companyFingerprint), true, ct);

    public async Task ReleaseLeaseAsync(long epoch, CancellationToken ct) =>
        await SendAsync<object>(HttpMethod.Post, $"{Base}/lease/release", new LeaseReleaseRequest(epoch), true, ct).ConfigureAwait(false);

    public Task<HeartbeatResponse> HeartbeatAsync(HeartbeatRequest request, CancellationToken ct) =>
        SendAsync<HeartbeatResponse>(HttpMethod.Post, $"{Base}/heartbeat", request, true, ct);

    public async Task<IReadOnlyList<WatermarkDto>> GetWatermarksAsync(CancellationToken ct) =>
        await SendAsync<List<WatermarkDto>>(HttpMethod.Get, $"{Base}/watermarks", null, true, ct).ConfigureAwait(false) ?? [];

    public Task<VersionResponse> GetVersionAsync(CancellationToken ct) =>
        SendAsync<VersionResponse>(HttpMethod.Get, $"{Base}/version", null, true, ct);

    public Task<ImportBatchResponse> PostImportBatchAsync(string batchJson, CancellationToken ct) =>
        SendRawAsync<ImportBatchResponse>(HttpMethod.Post, $"{Base}/import-batches", System.Text.Encoding.UTF8.GetBytes(batchJson), ct);

    public Task<ReconSnapshotResponse> PostReconSnapshotAsync(ReconSnapshotRequest request, CancellationToken ct) =>
        SendAsync<ReconSnapshotResponse>(HttpMethod.Post, $"{Base}/recon-snapshots", request, true, ct);

    private Task<T> SendAsync<T>(HttpMethod method, string path, object? body, bool signed, CancellationToken ct)
        where T : class =>
        SendBytesAsync<T>(method, path, body is null ? null : JsonSerializer.SerializeToUtf8Bytes(body, body.GetType(), Json), signed, ct);

    private Task<T> SendRawAsync<T>(HttpMethod method, string path, byte[] payload, CancellationToken ct)
        where T : class =>
        SendBytesAsync<T>(method, path, payload, true, ct);

    private async Task<T> SendBytesAsync<T>(HttpMethod method, string path, byte[]? payload, bool signed, CancellationToken ct)
        where T : class
    {
        Exception? last = null;

        for (var attempt = 0; attempt <= _retry.MaxRetries; attempt++)
        {
            ct.ThrowIfCancellationRequested();

            using var request = new HttpRequestMessage(method, path);
            if (!signed) request.Options.Set(SigningHandler.Unsigned, true);
            if (payload is not null)
            {
                request.Content = new ByteArrayContent(payload);
                request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
            }

            TimeSpan? serverDelay = null;
            try
            {
                using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseContentRead, ct).ConfigureAwait(false);
                if (response.IsSuccessStatusCode) return await ReadSuccessAsync<T>(response, ct).ConfigureAwait(false);

                if (!IsTransient(response.StatusCode)) throw await ReadErrorAsync(response, ct).ConfigureAwait(false);

                last = await ReadErrorAsync(response, ct).ConfigureAwait(false);
                serverDelay = RetryAfter(response);
            }
            catch (HttpRequestException ex)
            {
                last = ex;
            }
            catch (TaskCanceledException ex) when (!ct.IsCancellationRequested)
            {
                last = ex; // request timeout, not a shutdown
            }

            if (attempt < _retry.MaxRetries) await _delay(serverDelay ?? Backoff(attempt), ct).ConfigureAwait(false);
        }

        throw new CloudUnavailableException($"Cloud unavailable after {_retry.MaxRetries + 1} attempts: {last?.Message}", last);
    }

    private TimeSpan Backoff(int attempt)
    {
        var ceiling = Math.Min(_retry.BaseDelay.TotalMilliseconds * Math.Pow(2, attempt), MaxBackoff.TotalMilliseconds);
        return TimeSpan.FromMilliseconds(ceiling * _random()); // full jitter
    }

    private static TimeSpan? RetryAfter(HttpResponseMessage response)
    {
        var after = response.Headers.RetryAfter?.Delta;
        if (after is null) return null;
        return after > MaxBackoff ? MaxBackoff : after;
    }

    private static bool IsTransient(HttpStatusCode status) =>
        status is HttpStatusCode.RequestTimeout or HttpStatusCode.TooManyRequests
            or HttpStatusCode.InternalServerError or HttpStatusCode.BadGateway
            or HttpStatusCode.ServiceUnavailable or HttpStatusCode.GatewayTimeout;

    private static async Task<T> ReadSuccessAsync<T>(HttpResponseMessage response, CancellationToken ct)
        where T : class
    {
        if (response.StatusCode == HttpStatusCode.NoContent || response.Content.Headers.ContentLength == 0) return default!;
        var value = await response.Content.ReadFromJsonAsync<T>(Json, ct).ConfigureAwait(false);
        return value ?? throw new CloudApiException(response.StatusCode, "BAD_RESPONSE", "Empty response body.", null);
    }

    private static async Task<CloudApiException> ReadErrorAsync(HttpResponseMessage response, CancellationToken ct)
    {
        try
        {
            var envelope = await response.Content.ReadFromJsonAsync<ErrorEnvelope>(Json, ct).ConfigureAwait(false);
            if (envelope?.Error is { } e) return new CloudApiException(response.StatusCode, e.Code, e.Message, e.Details);
        }
        catch (JsonException)
        {
            // fall through: not an envelope (a proxy error page, for example)
        }

        return new CloudApiException(response.StatusCode, "HTTP_" + (int)response.StatusCode, response.ReasonPhrase ?? "Request failed", null);
    }
}
