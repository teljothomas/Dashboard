using System.Security.Cryptography;
using System.Text;

namespace TradeX.Agent.Core.Security;

/// <summary>
/// Connector request signing (INTERFACES section 5). Canonical string:
/// <c>METHOD\nPATH\nTIMESTAMP\nNONCE\nhex(sha256(body))</c> where PATH is the raw request target (path and query),
/// TIMESTAMP is Unix seconds and the body hash covers the raw body bytes (sha256 of nothing for a GET).
/// The signature is ECDSA P-256 / SHA-256 in IEEE P1363 form (r||s, 64 bytes), base64.
/// </summary>
public static class RequestSigner
{
    public const string AgentIdHeader = "X-Agent-Id";
    public const string TimestampHeader = "X-Timestamp";
    public const string NonceHeader = "X-Nonce";
    public const string SignatureHeader = "X-Signature";

    public static string BodyHashHex(ReadOnlySpan<byte> body) =>
        Convert.ToHexStringLower(SHA256.HashData(body));

    public static string Canonical(string method, string pathAndQuery, string timestamp, string nonce, ReadOnlySpan<byte> body) =>
        string.Join('\n', method.ToUpperInvariant(), pathAndQuery, timestamp, nonce, BodyHashHex(body));

    public static string Sign(ECDsa key, string canonical) =>
        Convert.ToBase64String(key.SignData(
            Encoding.UTF8.GetBytes(canonical), HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation));

    public static bool Verify(ECDsa publicKey, string canonical, string signatureBase64)
    {
        byte[] signature;
        try
        {
            signature = Convert.FromBase64String(signatureBase64);
        }
        catch (FormatException)
        {
            return false;
        }

        return publicKey.VerifyData(
            Encoding.UTF8.GetBytes(canonical), signature, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
    }
}
