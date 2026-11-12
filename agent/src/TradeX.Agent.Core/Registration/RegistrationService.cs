using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using TradeX.Agent.Core.Cloud;
using TradeX.Agent.Core.Security;

namespace TradeX.Agent.Core.Registration;

public interface IMachineInfo
{
    string MachineName { get; }

    /// <summary>Stable, non-reversible machine fingerprint (8 to 256 chars).</summary>
    string Fingerprint { get; }
}

[SupportedOSPlatform("windows")]
public sealed class WindowsMachineInfo : IMachineInfo
{
    public string MachineName => Environment.MachineName;

    public string Fingerprint
    {
        get
        {
            using var key = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Cryptography");
            var machineGuid = key?.GetValue("MachineGuid") as string ?? "unknown";
            return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes($"tradex-agent|{machineGuid}|{Environment.MachineName}")));
        }
    }
}

public sealed class RegistrationException(string message, Exception? inner = null) : Exception(message, inner);

/// <summary>
/// <c>TradeXAgent.exe register &lt;code&gt;</c>. Generates the ECDSA P-256 key in memory, sends the public half with the
/// one-time registration code, and only after the cloud accepts it writes the private key (DPAPI) and the identity.
/// A failed registration leaves nothing on disk. An agent that is already registered is never overwritten.
/// </summary>
public sealed class RegistrationService(
    ICloudClient cloud,
    IKeyStore keys,
    IIdentityStore identities,
    IMachineInfo machine,
    string cloudBaseUrl,
    string agentVersion,
    TimeProvider clock)
{
    public async Task<AgentIdentity> RegisterAsync(string registrationCode, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(registrationCode)) throw new RegistrationException("A registration code is required.");
        if (keys.Exists || identities.Exists)
        {
            throw new RegistrationException(
                "This machine is already registered. Revoke the agent in the ERP and uninstall it before registering again.");
        }

        using var key = AgentKeys.Generate();
        RegisterResponse response;
        try
        {
            response = await cloud.RegisterAsync(
                new RegisterRequest(registrationCode.Trim(), machine.MachineName, machine.Fingerprint, AgentKeys.PublicKeyPem(key), agentVersion),
                ct).ConfigureAwait(false);
        }
        catch (CloudApiException ex) when (ex.IsAuthFailure)
        {
            throw new RegistrationException("The registration code is invalid, expired or already used.", ex);
        }

        var identity = new AgentIdentity(response.AgentId, response.CompanyId, response.ExpectedCompany, cloudBaseUrl, clock.GetUtcNow());

        keys.Save(key);
        try
        {
            identities.Save(identity);
        }
        catch
        {
            keys.Delete();
            throw new RegistrationException(
                "The cloud accepted the registration but the identity could not be saved locally. Ask the owner for a new registration code.");
        }

        return identity;
    }
}
