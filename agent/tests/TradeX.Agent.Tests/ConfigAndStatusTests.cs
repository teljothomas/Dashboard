using TradeX.Agent.Core.Cloud;
using TradeX.Agent.Core.Config;
using TradeX.Agent.Core.Journal;
using TradeX.Agent.Core.Registration;
using TradeX.Agent.Core.Runtime;
using Xunit;

namespace TradeX.Agent.Tests;

public class ConfigAndStatusTests
{
    private static AgentOptions Valid() => new() { CloudBaseUrl = "https://erp.example.com" };

    [Fact]
    public void A_valid_configuration_has_no_problems()
    {
        Assert.Empty(Valid().Validate());
    }

    [Theory]
    [InlineData("0.0.0.0")]
    [InlineData("192.168.1.20")]
    [InlineData("tally-pc")]
    [InlineData("example.com")]
    public void The_agent_refuses_a_tally_host_that_is_not_loopback(string host)
    {
        var options = Valid();
        options.TallyHost = host;
        Assert.Contains(options.Validate(), p => p.Contains("loopback", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("127.0.0.1")]
    [InlineData("127.0.0.2")]
    [InlineData("::1")]
    [InlineData("localhost")]
    [InlineData("LOCALHOST")]
    public void Loopback_hosts_are_accepted(string host)
    {
        var options = Valid();
        options.TallyHost = host;
        Assert.Empty(options.Validate());
    }

    [Theory]
    [InlineData("")]
    [InlineData("not a url")]
    [InlineData("http://erp.example.com")]
    [InlineData("https://erp.example.com/api")]
    [InlineData("https://user:pw@erp.example.com")]
    public void The_cloud_url_must_be_an_https_origin(string url)
    {
        var options = Valid();
        options.CloudBaseUrl = url;
        Assert.NotEmpty(options.Validate());
    }

    [Fact]
    public void Plain_http_is_allowed_only_for_a_loopback_development_server()
    {
        var options = Valid();
        options.CloudBaseUrl = "http://127.0.0.1:3000";
        Assert.Empty(options.Validate());
    }

    [Fact]
    public void Heartbeat_interval_cannot_exceed_a_third_of_the_lease_ttl()
    {
        var options = Valid();
        options.HeartbeatSeconds = 31;
        Assert.NotEmpty(options.Validate());
    }

    [Fact]
    public void Status_text_shows_lease_heartbeat_journal_counts_and_last_error()
    {
        var identity = new AgentIdentity("agent-1", "company-1", new ExpectedCompany("Acme Meats", "7", "2024-04-01"), "https://erp.example.com", DateTimeOffset.UnixEpoch);
        var snapshot = new StatusSnapshot(
            identity, "Active", 4, "2026-11-12T08:01:30.000Z", "2026-11-12T08:00:30.0000000+00:00", true, true, "7.0", "TEST_ONLY",
            "Heartbeat rejected: VALIDATION", "2026-11-12T08:00:30.0000000+00:00", new JournalCounts(1, 0, 2, 5, 1, 9));

        var text = StatusFormatter.Format(snapshot);

        Assert.Contains("agent agent-1", text, StringComparison.Ordinal);
        Assert.Contains("Acme Meats", text, StringComparison.Ordinal);
        Assert.Contains("epoch 4", text, StringComparison.Ordinal);
        Assert.Contains("Last heartbeat:   2026-11-12T08:00:30.0000000+00:00 (ok: yes)", text, StringComparison.Ordinal);
        Assert.Contains("pending 4 (post intent 1, sent 0, responded 2, import prepared 1)", text, StringComparison.Ordinal);
        Assert.Contains("Heartbeat rejected: VALIDATION", text, StringComparison.Ordinal);
        Assert.DoesNotContain("PRIVATE", text, StringComparison.Ordinal);
    }

    [Fact]
    public void Status_text_for_an_unregistered_agent_says_how_to_register()
    {
        var snapshot = new StatusSnapshot(null, "NotRunning", null, null, null, null, null, null, null, null, null, new JournalCounts(0, 0, 0, 0, 0, 0));

        var text = StatusFormatter.Format(snapshot);

        Assert.Contains("Registered:       no (run: TradeXAgent.exe register <code>)", text, StringComparison.Ordinal);
        Assert.Contains("Lease:            not held", text, StringComparison.Ordinal);
        Assert.Contains("Last heartbeat:   never", text, StringComparison.Ordinal);
        Assert.Contains("Last error:       none", text, StringComparison.Ordinal);
    }
}
