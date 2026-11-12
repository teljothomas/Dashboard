using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using TradeX.Agent.Core.Cloud;
using TradeX.Agent.Core.Security;
using TradeX.Agent.Tests.Fakes;
using Xunit;

namespace TradeX.Agent.Tests;

/// <summary>
/// Shared signature vector (agent/tests/fixtures/signature-vector.json) is verified by the Node tests in apps/api
/// and here: both sides rebuild the same canonical string and verify the same signature.
/// </summary>
public class SigningTests
{
    private sealed record Vector(string PublicKeyPem, string Method, string Path, string Timestamp, string Nonce, string Body, string Canonical, string Signature);

    private static Vector LoadVector()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "fixtures", "signature-vector.json");
        return JsonSerializer.Deserialize<Vector>(File.ReadAllText(path), new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
    }

    [Fact]
    public void Canonical_string_matches_the_shared_vector()
    {
        var v = LoadVector();
        var canonical = RequestSigner.Canonical(v.Method, v.Path, v.Timestamp, v.Nonce, Encoding.UTF8.GetBytes(v.Body));
        Assert.Equal(v.Canonical, canonical);
    }

    [Fact]
    public void Signature_from_the_node_side_verifies_with_the_public_key()
    {
        var v = LoadVector();
        using var publicKey = ECDsa.Create();
        publicKey.ImportFromPem(v.PublicKeyPem);

        Assert.True(RequestSigner.Verify(publicKey, v.Canonical, v.Signature));
        Assert.False(RequestSigner.Verify(publicKey, v.Canonical.Replace("heartbeat", "lease/acquire", StringComparison.Ordinal), v.Signature));
        Assert.False(RequestSigner.Verify(publicKey, v.Canonical, "not base64!"));
    }

    [Fact]
    public void Heartbeat_body_serialises_to_the_vector_body_byte_for_byte()
    {
        var v = LoadVector();
        var body = JsonSerializer.SerializeToUtf8Bytes(new HeartbeatRequest(7, true, "7.0", true, 0, null), CloudClient.Json);
        Assert.Equal(v.Body, Encoding.UTF8.GetString(body));
    }

    [Fact]
    public void Signature_is_ieee_p1363_64_bytes()
    {
        using var key = AgentKeys.Generate();
        var signature = Convert.FromBase64String(RequestSigner.Sign(key, "x"));
        Assert.Equal(64, signature.Length);
    }

    [Fact]
    public async Task Handler_signs_each_send_with_a_fresh_nonce_and_a_verifiable_signature()
    {
        using var key = AgentKeys.Generate();
        var stub = new StubHandler();
        stub.Responses.Enqueue(_ => StubHandler.Json(HttpStatusCode.OK, "{}"));
        stub.Responses.Enqueue(_ => StubHandler.Json(HttpStatusCode.OK, "{}"));
        using var http = new HttpClient(new SigningHandler(key, "agent-1", TimeProvider.System) { InnerHandler = stub })
        {
            BaseAddress = new Uri("https://erp.example.com"),
        };

        for (var i = 0; i < 2; i++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "/connector/v1/heartbeat?x=1")
            {
                Content = new StringContent("{\"epoch\":1}", Encoding.UTF8, "application/json"),
            };
            using var response = await http.SendAsync(request);
            Assert.True(response.IsSuccessStatusCode);
        }

        var nonces = new List<string>();
        foreach (var (request, body) in stub.Seen)
        {
            Assert.Equal("agent-1", request.Headers.GetValues("X-Agent-Id").Single());
            var timestamp = request.Headers.GetValues("X-Timestamp").Single();
            var nonce = request.Headers.GetValues("X-Nonce").Single();
            nonces.Add(nonce);
            var canonical = RequestSigner.Canonical("POST", "/connector/v1/heartbeat?x=1", timestamp, nonce, body);
            Assert.True(RequestSigner.Verify(key, canonical, request.Headers.GetValues("X-Signature").Single()));
            Assert.True(long.TryParse(timestamp, out var seconds) && Math.Abs(seconds - DateTimeOffset.UtcNow.ToUnixTimeSeconds()) < 60);
        }

        Assert.Equal(2, nonces.Distinct().Count());
    }

    [Fact]
    public async Task Unsigned_option_sends_no_signature_headers()
    {
        using var key = AgentKeys.Generate();
        var stub = new StubHandler();
        stub.Responses.Enqueue(_ => StubHandler.Json(HttpStatusCode.OK, "{}"));
        using var http = new HttpClient(new SigningHandler(key, "agent-1", TimeProvider.System) { InnerHandler = stub })
        {
            BaseAddress = new Uri("https://erp.example.com"),
        };
        using var request = new HttpRequestMessage(HttpMethod.Post, "/connector/v1/register");
        request.Options.Set(SigningHandler.Unsigned, true);
        using var response = await http.SendAsync(request);

        Assert.False(stub.Seen.Single().Request.Headers.Contains("X-Signature"));
    }
}
