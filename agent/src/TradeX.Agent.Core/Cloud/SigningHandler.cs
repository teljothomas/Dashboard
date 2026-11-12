using System.Security.Cryptography;
using TradeX.Agent.Core.Security;

namespace TradeX.Agent.Core.Cloud;

/// <summary>
/// Signs every outgoing connector request (INTERFACES section 5): <c>X-Agent-Id</c>, <c>X-Timestamp</c> (Unix seconds),
/// <c>X-Nonce</c> (fresh uuid per send, so a retried request never reuses a nonce) and <c>X-Signature</c> over the raw
/// path-and-query and the exact body bytes that go on the wire. Only <c>register</c> is sent unsigned.
/// </summary>
public sealed class SigningHandler(ECDsa key, string agentId, TimeProvider clock) : DelegatingHandler
{
    public static readonly HttpRequestOptionsKey<bool> Unsigned = new("tradex.unsigned");

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        if (!request.Options.TryGetValue(Unsigned, out var unsigned) || !unsigned)
        {
            var uri = request.RequestUri ?? throw new InvalidOperationException("Request has no URI.");
            var body = request.Content is null ? [] : await request.Content.ReadAsByteArrayAsync(cancellationToken).ConfigureAwait(false);

            var timestamp = clock.GetUtcNow().ToUnixTimeSeconds().ToString(System.Globalization.CultureInfo.InvariantCulture);
            var nonce = Guid.NewGuid().ToString();
            var canonical = RequestSigner.Canonical(request.Method.Method, uri.PathAndQuery, timestamp, nonce, body);

            request.Headers.Remove(RequestSigner.AgentIdHeader);
            request.Headers.Remove(RequestSigner.TimestampHeader);
            request.Headers.Remove(RequestSigner.NonceHeader);
            request.Headers.Remove(RequestSigner.SignatureHeader);
            request.Headers.Add(RequestSigner.AgentIdHeader, agentId);
            request.Headers.Add(RequestSigner.TimestampHeader, timestamp);
            request.Headers.Add(RequestSigner.NonceHeader, nonce);
            request.Headers.Add(RequestSigner.SignatureHeader, RequestSigner.Sign(key, canonical));
        }

        return await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
    }
}
