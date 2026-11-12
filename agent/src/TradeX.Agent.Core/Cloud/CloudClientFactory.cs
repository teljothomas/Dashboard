using System.Net;
using System.Security.Cryptography;
using TradeX.Agent.Core.Config;

namespace TradeX.Agent.Core.Cloud;

/// <summary>Builds the production <see cref="CloudClient"/> (real sockets, signing handler for signed use).</summary>
public static class CloudClientFactory
{
    /// <summary>Client for the unsigned <c>register</c> call only.</summary>
    public static CloudClient CreateForRegistration(AgentOptions options, out HttpClient http)
    {
        http = new HttpClient(NewSocketsHandler()) { BaseAddress = new Uri(options.CloudBaseUrl), Timeout = Timeout(options) };
        return new CloudClient(http, Retry(options));
    }

    /// <summary>Client whose every request is signed with the agent key. The caller owns <paramref name="http"/>.</summary>
    public static CloudClient CreateSigned(AgentOptions options, ECDsa key, string agentId, TimeProvider clock, out HttpClient http)
    {
        var signing = new SigningHandler(key, agentId, clock) { InnerHandler = NewSocketsHandler() };
        http = new HttpClient(signing) { BaseAddress = new Uri(options.CloudBaseUrl), Timeout = Timeout(options) };
        return new CloudClient(http, Retry(options));
    }

    private static SocketsHttpHandler NewSocketsHandler() => new()
    {
        PooledConnectionLifetime = TimeSpan.FromMinutes(5),
        AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate,
        AllowAutoRedirect = false, // a redirect would be re-sent without a valid signature
    };

    private static TimeSpan Timeout(AgentOptions options) => TimeSpan.FromSeconds(options.HttpTimeoutSeconds);

    private static CloudRetryPolicy Retry(AgentOptions options) =>
        new(options.MaxRetries, TimeSpan.FromMilliseconds(options.RetryBaseMilliseconds));
}
