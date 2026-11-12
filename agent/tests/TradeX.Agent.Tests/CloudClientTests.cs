using System.Net;
using System.Text.Json;
using TradeX.Agent.Core.Cloud;
using TradeX.Agent.Core.Security;
using TradeX.Agent.Tests.Fakes;
using Xunit;

namespace TradeX.Agent.Tests;

public class CloudClientTests
{
    private const string LeaseJson = """{"epoch":3,"expiresAt":"2030-01-01T00:00:00.000Z"}""";

    private static (CloudClient Client, StubHandler Stub, List<TimeSpan> Delays) Build(int retries = 3)
    {
        var stub = new StubHandler();
        var key = AgentKeys.Generate();
        var http = new HttpClient(new SigningHandler(key, "agent-1", TimeProvider.System) { InnerHandler = stub })
        {
            BaseAddress = new Uri("https://erp.example.com"),
        };
        var delays = new List<TimeSpan>();
        var client = new CloudClient(
            http,
            new CloudRetryPolicy(retries, TimeSpan.FromMilliseconds(100)),
            (delay, _) =>
            {
                delays.Add(delay);
                return Task.CompletedTask;
            },
            () => 0.5);
        return (client, stub, delays);
    }

    [Fact]
    public async Task Transient_failures_are_retried_with_jittered_backoff_and_a_fresh_nonce_each_time()
    {
        var (client, stub, delays) = Build();
        stub.Responses.Enqueue(_ => StubHandler.Error(HttpStatusCode.ServiceUnavailable, "INTERNAL"));
        stub.Responses.Enqueue(_ => throw new HttpRequestException("connection reset"));
        stub.Responses.Enqueue(_ => StubHandler.Json(HttpStatusCode.OK, LeaseJson));

        var lease = await client.AcquireLeaseAsync(Fp.Fingerprint, CancellationToken.None);

        Assert.Equal(3, lease.Epoch);
        Assert.Equal(3, stub.Seen.Count);
        Assert.Equal(3, stub.Seen.Select(s => s.Request.Headers.GetValues("X-Nonce").Single()).Distinct().Count());
        // full jitter: random 0.5 times base * 2^attempt = 50 ms, then 100 ms
        Assert.Equal([TimeSpan.FromMilliseconds(50), TimeSpan.FromMilliseconds(100)], delays);
    }

    [Fact]
    public async Task Business_errors_are_not_retried_and_carry_code_and_details()
    {
        var (client, stub, delays) = Build();
        stub.Responses.Enqueue(_ => StubHandler.Error(HttpStatusCode.Conflict, "LEASE_HELD", """{"holderAgentId":"other","expiresAt":"2030-01-01T00:00:00.000Z"}"""));

        var ex = await Assert.ThrowsAsync<CloudApiException>(() => client.AcquireLeaseAsync(Fp.Fingerprint, CancellationToken.None));

        Assert.True(ex.IsLeaseHeld);
        Assert.Equal(HttpStatusCode.Conflict, ex.StatusCode);
        Assert.Equal("other", ex.Details!.Value.GetProperty("holderAgentId").GetString());
        Assert.Single(stub.Seen);
        Assert.Empty(delays);
    }

    [Fact]
    public async Task Stale_epoch_is_reported_as_lease_stale()
    {
        var (client, stub, _) = Build();
        stub.Responses.Enqueue(_ => StubHandler.Error(HttpStatusCode.Conflict, "LEASE_STALE"));

        var ex = await Assert.ThrowsAsync<CloudApiException>(() =>
            client.HeartbeatAsync(new HeartbeatRequest(1, true, "7.0", true, 0, null), CancellationToken.None));

        Assert.True(ex.IsLeaseStale);
    }

    [Fact]
    public async Task Unauthenticated_answer_is_an_auth_failure_and_not_retried()
    {
        var (client, stub, _) = Build();
        stub.Responses.Enqueue(_ => StubHandler.Error(HttpStatusCode.Unauthorized, "UNAUTHENTICATED"));

        var ex = await Assert.ThrowsAsync<CloudApiException>(() => client.GetVersionAsync(CancellationToken.None));

        Assert.True(ex.IsAuthFailure);
        Assert.Single(stub.Seen);
    }

    [Fact]
    public async Task Gives_up_after_the_retry_budget()
    {
        var (client, stub, delays) = Build(retries: 2);
        for (var i = 0; i < 3; i++) stub.Responses.Enqueue(_ => StubHandler.Error(HttpStatusCode.BadGateway, "INTERNAL"));

        await Assert.ThrowsAsync<CloudUnavailableException>(() => client.GetVersionAsync(CancellationToken.None));

        Assert.Equal(3, stub.Seen.Count);
        Assert.Equal(2, delays.Count);
    }

    [Fact]
    public async Task Shutdown_cancellation_is_not_retried()
    {
        var (client, stub, _) = Build();
        stub.Responses.Enqueue(_ => StubHandler.Json(HttpStatusCode.OK, "{}"));
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => client.GetVersionAsync(cts.Token));

        Assert.Empty(stub.Seen);
    }

    [Fact]
    public async Task Register_is_sent_unsigned_with_camel_case_json()
    {
        var (client, stub, _) = Build();
        stub.Responses.Enqueue(_ => StubHandler.Json(
            HttpStatusCode.Created,
            """{"agentId":"a1","companyId":"c1","expectedCompany":{"tallyName":"Acme","companyNumber":"7","booksFrom":"2024-04-01"}}"""));

        var response = await client.RegisterAsync(new RegisterRequest("CODE1234", "PC", "fingerprint-12345678", "-----BEGIN PUBLIC KEY-----", "0.1.0"), CancellationToken.None);

        Assert.Equal("a1", response.AgentId);
        Assert.Equal("Acme", response.ExpectedCompany.TallyName);
        var (request, body) = stub.Seen.Single();
        Assert.False(request.Headers.Contains("X-Signature"));
        Assert.Equal("/connector/v1/register", request.RequestUri!.AbsolutePath);
        using var json = JsonDocument.Parse(body);
        Assert.Equal("CODE1234", json.RootElement.GetProperty("registrationCode").GetString());
        Assert.True(json.RootElement.TryGetProperty("machineFingerprint", out _));
    }

    [Fact]
    public async Task Release_accepts_204_and_sends_the_epoch()
    {
        var (client, stub, _) = Build();
        stub.Responses.Enqueue(_ => new HttpResponseMessage(HttpStatusCode.NoContent));

        await client.ReleaseLeaseAsync(9, CancellationToken.None);

        var (request, body) = stub.Seen.Single();
        Assert.Equal("/connector/v1/lease/release", request.RequestUri!.AbsolutePath);
        Assert.Equal("""{"epoch":9}""", System.Text.Encoding.UTF8.GetString(body));
    }

    [Fact]
    public async Task Observed_company_omits_a_missing_guid_and_get_calls_send_no_body()
    {
        var (client, stub, _) = Build();
        stub.Responses.Enqueue(_ => StubHandler.Json(HttpStatusCode.OK, $$"""{"match":true,"fingerprint":"{{Fp.Fingerprint}}"}"""));
        stub.Responses.Enqueue(_ => StubHandler.Json(HttpStatusCode.OK, """[{"stream":"VOUCHERS","lastAlterId":5,"lastFullReconAt":null}]"""));

        await client.VerifyCompanyAsync(new ObservedCompany("Acme", "7", "2024-04-01"), CancellationToken.None);
        var watermarks = await client.GetWatermarksAsync(CancellationToken.None);

        Assert.DoesNotContain("guid", System.Text.Encoding.UTF8.GetString(stub.Seen[0].Body), StringComparison.Ordinal);
        Assert.Empty(stub.Seen[1].Body);
        Assert.Equal(5, watermarks.Single().LastAlterId);
    }
}
