using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;

namespace TradeX.Agent.Core.Security;

public sealed class KeyStoreException(string message, Exception? inner = null) : Exception(message, inner);

/// <summary>Holds the agent's ECDSA P-256 private key. The key is the agent's only secret.</summary>
public interface IKeyStore
{
    bool Exists { get; }

    /// <summary>Loads the private key. Throws <see cref="KeyStoreException"/> when it is missing or unreadable.</summary>
    ECDsa Load();

    /// <summary>Persists a new key. Throws when a key already exists (never silently replaced).</summary>
    void Save(ECDsa key);

    /// <summary>Removes the key (used to roll back a registration whose identity could not be saved).</summary>
    void Delete();
}

public static class AgentKeys
{
    public static ECDsa Generate() => ECDsa.Create(ECCurve.NamedCurves.nistP256);

    /// <summary>SPKI public key as PEM, the form the cloud stores at registration.</summary>
    public static string PublicKeyPem(ECDsa key) => key.ExportSubjectPublicKeyInfoPem();
}

/// <summary>
/// Private key at rest: PKCS#8 bytes protected with DPAPI scope LocalMachine, so any process on the Tally PC running
/// as an allowed account can unprotect it but a copy of the file on another machine is useless. The file is created
/// with inheritance disabled and an ACL of SYSTEM and Administrators only; the install script adds the service
/// account (SECURITY section 6). The key never touches disk unprotected: the temp file only holds the protected blob.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class DpapiKeyStore(string keyFile, IReadOnlyList<SecurityIdentifier>? additionalReaders = null) : IKeyStore
{
    // Not a secret: a fixed application tag so the blob is only valid for this agent's key.
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("TradeXAgent.PrivateKey.v1");

    public bool Exists => File.Exists(keyFile);

    public ECDsa Load()
    {
        if (!Exists) throw new KeyStoreException($"No private key at {keyFile}. Run 'TradeXAgent register <code>'.");

        try
        {
            var protectedBytes = File.ReadAllBytes(keyFile);
            var pkcs8 = ProtectedData.Unprotect(protectedBytes, Entropy, DataProtectionScope.LocalMachine);
            try
            {
                var key = ECDsa.Create();
                key.ImportPkcs8PrivateKey(pkcs8, out _);
                return key;
            }
            finally
            {
                CryptographicOperations.ZeroMemory(pkcs8);
            }
        }
        catch (CryptographicException ex)
        {
            throw new KeyStoreException("The private key file cannot be decrypted (wrong machine or damaged file).", ex);
        }
        catch (IOException ex)
        {
            throw new KeyStoreException("The private key file cannot be read.", ex);
        }
        catch (UnauthorizedAccessException ex)
        {
            throw new KeyStoreException("Access to the private key file was denied for this account.", ex);
        }
    }

    public void Save(ECDsa key)
    {
        if (Exists) throw new KeyStoreException("A private key already exists. Refusing to replace it.");

        var directory = Path.GetDirectoryName(keyFile) ?? throw new KeyStoreException("Invalid key file path.");
        Directory.CreateDirectory(directory);

        var pkcs8 = key.ExportPkcs8PrivateKey();
        try
        {
            var blob = ProtectedData.Protect(pkcs8, Entropy, DataProtectionScope.LocalMachine);
            var temp = keyFile + ".tmp";
            if (File.Exists(temp)) File.Delete(temp);

            using (var stream = new FileInfo(temp).Create(
                       FileMode.CreateNew, FileSystemRights.Write | FileSystemRights.ReadPermissions, FileShare.None, 4096,
                       FileOptions.WriteThrough, RestrictedSecurity(additionalReaders)))
            {
                stream.Write(blob);
                stream.Flush(flushToDisk: true);
            }

            File.Move(temp, keyFile, overwrite: false);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(pkcs8);
        }
    }

    public void Delete()
    {
        if (Exists) File.Delete(keyFile);
    }

    /// <summary>
    /// ACL: no inheritance; SYSTEM and Administrators full control, plus read-only for any listed service account.
    /// Nobody else. An elevated token carries Administrators; a non-elevated administrator does not and needs an entry.
    /// </summary>
    internal static FileSecurity RestrictedSecurity(IReadOnlyList<SecurityIdentifier>? additionalReaders = null)
    {
        var security = new FileSecurity();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        foreach (var sid in new[] { WellKnownSidType.LocalSystemSid, WellKnownSidType.BuiltinAdministratorsSid })
        {
            security.AddAccessRule(new FileSystemAccessRule(
                new SecurityIdentifier(sid, null), FileSystemRights.FullControl, AccessControlType.Allow));
        }

        foreach (var reader in additionalReaders ?? [])
        {
            security.AddAccessRule(new FileSystemAccessRule(reader, FileSystemRights.Read, AccessControlType.Allow));
        }

        return security;
    }
}
