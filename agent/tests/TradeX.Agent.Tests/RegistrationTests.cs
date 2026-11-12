using System.Net;
using System.Security.Cryptography;
using TradeX.Agent.Core.Cloud;
using TradeX.Agent.Core.Registration;
using TradeX.Agent.Core.Security;
using TradeX.Agent.Tests.Fakes;
using Xunit;

namespace TradeX.Agent.Tests;

public class RegistrationTests
{
    private readonly FakeCloud _cloud = new();
    private readonly MemoryKeyStore _keys = new();
    private readonly MemoryIdentityStore _identities = new();

    private RegistrationService Service() =>
        new(_cloud, _keys, _identities, new FakeMachine(), "https://erp.example.com", "0.1.0", TimeProvider.System);

    private void AcceptRegistration() =>
        _cloud.OnRegister = _ => new RegisterResponse("agent-9", "company-9", new ExpectedCompany("Acme", "7", "2024-04-01"));

    [Fact]
    public async Task Registers_with_the_public_key_and_stores_key_and_identity_afterwards()
    {
        RegisterRequest? sent = null;
        _cloud.OnRegister = request =>
        {
            sent = request;
            Assert.False(_keys.Exists); // nothing is persisted before the cloud accepts
            return new RegisterResponse("agent-9", "company-9", new ExpectedCompany("Acme", "7", "2024-04-01"));
        };

        var identity = await Service().RegisterAsync("  ABCD-EFGH  ", CancellationToken.None);

        Assert.Equal("agent-9", identity.AgentId);
        Assert.Equal("ABCD-EFGH", sent!.RegistrationCode);
        Assert.Equal("TALLY-PC", sent.MachineName);
        Assert.Equal("0.1.0", sent.AgentVersion);
        Assert.True(_keys.Exists);
        Assert.Equal(identity, _identities.Stored);

        // The public key that was sent is the one for the key that was stored.
        using var stored = _keys.Load();
        using var announced = ECDsa.Create();
        announced.ImportFromPem(sent.PublicKeyPem);
        Assert.True(RequestSigner.Verify(announced, "c", RequestSigner.Sign(stored, "c")));
        Assert.DoesNotContain("PRIVATE", sent.PublicKeyPem, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_refused_code_leaves_nothing_on_disk_and_gives_a_plain_message()
    {
        _cloud.OnRegister = _ => throw Fp.Api(HttpStatusCode.Unauthorized, "UNAUTHENTICATED");

        var ex = await Assert.ThrowsAsync<RegistrationException>(() => Service().RegisterAsync("WRONG", CancellationToken.None));

        Assert.Contains("invalid, expired or already used", ex.Message, StringComparison.Ordinal);
        Assert.False(_keys.Exists);
        Assert.False(_identities.Exists);
    }

    [Fact]
    public async Task An_already_registered_machine_is_never_overwritten()
    {
        AcceptRegistration();
        await Service().RegisterAsync("CODE", CancellationToken.None);
        var before = _identities.Stored;
        _cloud.OnRegister = _ => throw new InvalidOperationException("must not be called");

        await Assert.ThrowsAsync<RegistrationException>(() => Service().RegisterAsync("CODE2", CancellationToken.None));

        Assert.Equal(before, _identities.Stored);
    }

    [Fact]
    public async Task If_the_identity_cannot_be_saved_the_new_key_is_rolled_back()
    {
        AcceptRegistration();
        _identities.FailOnSave = true;

        await Assert.ThrowsAsync<RegistrationException>(() => Service().RegisterAsync("CODE", CancellationToken.None));

        Assert.False(_keys.Exists);
    }

    [Fact]
    public async Task A_blank_code_is_rejected_before_any_call()
    {
        _cloud.OnRegister = _ => throw new InvalidOperationException("must not be called");
        await Assert.ThrowsAsync<RegistrationException>(() => Service().RegisterAsync("  ", CancellationToken.None));
    }
}
