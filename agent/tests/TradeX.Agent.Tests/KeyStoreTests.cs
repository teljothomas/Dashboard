using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using TradeX.Agent.Core.Security;
using Xunit;

namespace TradeX.Agent.Tests;

public sealed class KeyStoreTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "tradex-agent-tests-" + Guid.NewGuid().ToString("N"));
    private readonly SecurityIdentifier _me = WindowsIdentity.GetCurrent().User!;

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
    }

    private DpapiKeyStore Store() => new(Path.Combine(_dir, "agent.key"), [_me]);

    [Fact]
    public void Key_round_trips_and_signs_with_the_same_identity()
    {
        var store = Store();
        using var original = AgentKeys.Generate();
        store.Save(original);

        using var loaded = store.Load();

        Assert.Equal(AgentKeys.PublicKeyPem(original), AgentKeys.PublicKeyPem(loaded));
        Assert.True(RequestSigner.Verify(original, "c", RequestSigner.Sign(loaded, "c")));
    }

    [Fact]
    public void The_file_does_not_contain_the_plain_private_key()
    {
        var store = Store();
        using var key = AgentKeys.Generate();
        store.Save(key);

        var onDisk = File.ReadAllBytes(Path.Combine(_dir, "agent.key"));
        var plain = key.ExportPkcs8PrivateKey();

        Assert.False(onDisk.AsSpan().IndexOf(plain.AsSpan()) >= 0);
        Assert.False(File.Exists(Path.Combine(_dir, "agent.key.tmp")));
    }

    [Fact]
    public void File_acl_has_no_inheritance_and_only_system_administrators_and_the_listed_reader()
    {
        var store = Store();
        using var key = AgentKeys.Generate();
        store.Save(key);

        var security = new FileInfo(Path.Combine(_dir, "agent.key")).GetAccessControl();
        var principals = security.GetAccessRules(true, true, typeof(SecurityIdentifier))
            .Cast<FileSystemAccessRule>()
            .Select(r => r.IdentityReference.Value)
            .ToHashSet();

        Assert.True(security.AreAccessRulesProtected);
        Assert.Equal(
            new HashSet<string>
            {
                new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null).Value,
                new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null).Value,
                _me.Value,
            },
            principals);
    }

    [Fact]
    public void An_existing_key_is_never_replaced()
    {
        var store = Store();
        using var first = AgentKeys.Generate();
        using var second = AgentKeys.Generate();
        store.Save(first);

        Assert.Throws<KeyStoreException>(() => store.Save(second));
        using var loaded = store.Load();
        Assert.Equal(AgentKeys.PublicKeyPem(first), AgentKeys.PublicKeyPem(loaded));
    }

    [Fact]
    public void A_damaged_or_missing_file_fails_with_a_clear_error()
    {
        var store = Store();
        Assert.Throws<KeyStoreException>(() => store.Load());

        using var key = AgentKeys.Generate();
        store.Save(key);
        var path = Path.Combine(_dir, "agent.key");
        var bytes = File.ReadAllBytes(path);
        bytes[bytes.Length / 2] ^= 0xFF;
        File.Delete(path); // the ACL is read-only for the test user, so replace the file instead of editing it
        File.WriteAllBytes(path, bytes);

        Assert.Throws<KeyStoreException>(() => store.Load());
    }

    [Fact]
    public void Delete_removes_the_key()
    {
        var store = Store();
        using var key = AgentKeys.Generate();
        store.Save(key);
        store.Delete();
        Assert.False(store.Exists);
    }
}
