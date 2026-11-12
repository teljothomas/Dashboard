using Xunit;
using TradeX.Agent.Tally;
using TradeX.Agent.Tools;
using TradeX.Agent.Core.Config;
using Microsoft.Extensions.Logging.Abstractions;

namespace TradeX.Agent.Tests;

/// <summary>Parser tests: exercises TallyParsers over all fixtures and synthetic edge cases.</summary>
public sealed class TallyParserTests
{
    [Fact]
    public void ParseLedgers_FromFixture()
    {
        var json = TallySimulator.DefaultLedgerResponse;
        var ledgers = TallyParsers.ParseLedgers(json);

        Assert.Equal(3, ledgers.Count);
        Assert.Equal("Cash", ledgers[0].Name);
        Assert.Equal("Cash-in-Hand", ledgers[0].Parent);
        Assert.Equal(50000.00m, ledgers[0].ClosingBalance);
        Assert.Equal("Bank Account", ledgers[1].Name);
        Assert.Equal(150000.00m, ledgers[1].ClosingBalance);
        Assert.Equal("Customer A", ledgers[2].Name);
        Assert.Equal(25000.00m, ledgers[2].ClosingBalance);
    }

    [Fact]
    public void ParseLedgers_EmptyCollection()
    {
        var json = """{"status":"1","data":{"collection":[]}}""";
        Assert.Empty(TallyParsers.ParseLedgers(json));
    }

    [Fact]
    public void ParseLedgers_NoDataKey()
    {
        var json = """{"status":"0"}""";
        Assert.Empty(TallyParsers.ParseLedgers(json));
    }

    [Fact]
    public void ParseVouchers_FromFixture()
    {
        var json = TallySimulator.DefaultVoucherResponse;
        var vouchers = TallyParsers.ParseVouchers(json);

        Assert.Single(vouchers);
        var v = vouchers[0];
        Assert.Equal("00000000-0000-4000-8000-000000000001-00000001", v.Guid);
        Assert.Equal("00000000-0000-4000-8000-000000000001-00000001", v.RemoteId);
        Assert.Equal("Receipt", v.VoucherTypeName);
        Assert.Equal("1", v.VoucherNumber);
        Assert.Equal(new DateOnly(2025, 4, 1), v.Date);
        Assert.Equal(1000.00m, v.Amount);
        Assert.Equal(1L, v.MasterId);
        Assert.False(v.IsDeleted);
        Assert.Equal(2, v.LedgerEntries.Count);
        Assert.Equal("Customer A", v.LedgerEntries[0].LedgerName);
        Assert.False(v.LedgerEntries[0].IsDeemedPositive);
        Assert.Equal(1000.00m, v.LedgerEntries[0].Amount);
        Assert.Equal("Bank Account", v.LedgerEntries[1].LedgerName);
        Assert.True(v.LedgerEntries[1].IsDeemedPositive);
        Assert.Equal(-1000.00m, v.LedgerEntries[1].Amount);
    }

    [Fact]
    public void ParseVouchers_FromResponseFixtureFile()
    {
        // The original fixture from WP-05.1 (no narration key)
        var json = File.ReadAllText(Path.Combine("fixtures", "tally", "response-voucher-collection.json"));
        var vouchers = TallyParsers.ParseVouchers(json);
        Assert.Single(vouchers);
        Assert.Equal("00000000-0000-4000-8000-000000000001-00000001", vouchers[0].Guid);
        Assert.Equal("Receipt", vouchers[0].VoucherTypeName);
    }

    [Fact]
    public void ParseVouchers_WithNarration()
    {
        var json = TallySimulator.DefaultVoucherResponse;
        var vouchers = TallyParsers.ParseVouchers(json);
        Assert.Equal("Test receipt [ERP:a1b2c3d4-e5f6-7890-abcd-ef1234567890]", vouchers[0].Narration);
    }

    [Fact]
    public void ParseVouchers_EmptyCollection()
    {
        var json = """{"status":"1","data":{"collection":[]}}""";
        Assert.Empty(TallyParsers.ParseVouchers(json));
    }

    [Fact]
    public void ParseImportResult_FromFixture()
    {
        var json = TallySimulator.DefaultImportResponse;
        var result = TallyParsers.ParseImportResult(json);

        Assert.NotNull(result);
        Assert.Equal(1, result.Created);
        Assert.Equal(0, result.Altered);
        Assert.Equal(0, result.Deleted);
        Assert.Equal(70, result.LastVchId);
        Assert.Equal(0, result.Errors);
        Assert.Equal(2, result.VchNumber);
    }

    [Fact]
    public void ParseImportResult_FromFixtureFile()
    {
        var json = File.ReadAllText(Path.Combine("fixtures", "tally", "response-voucher-import.json"));
        var result = TallyParsers.ParseImportResult(json);
        Assert.NotNull(result);
        Assert.Equal(1, result.Created);
        Assert.Equal(0, result.Errors);
    }

    [Fact]
    public void ParseImportResult_NoData()
    {
        Assert.Null(TallyParsers.ParseImportResult("""{"status":"0"}"""));
    }

    [Fact]
    public void ParseStatus_Success()
    {
        Assert.True(TallyParsers.ParseStatus("""{"status":"1"}"""));
    }

    [Fact]
    public void ParseStatus_Failure()
    {
        Assert.False(TallyParsers.ParseStatus("""{"status":"0"}"""));
    }

    [Fact]
    public void ParseStatus_Missing()
    {
        Assert.False(TallyParsers.ParseStatus("""{"data":{}}"""));
    }

    [Fact]
    public void ExtractMarker_Found()
    {
        Assert.Equal("a1b2c3d4-e5f6-7890-abcd-ef1234567890",
            TallyParsers.ExtractMarker("Test receipt [ERP:a1b2c3d4-e5f6-7890-abcd-ef1234567890]"));
    }

    [Fact]
    public void ExtractMarker_NotFound()
    {
        Assert.Null(TallyParsers.ExtractMarker("No marker here"));
    }

    [Fact]
    public void ExtractMarker_Null()
    {
        Assert.Null(TallyParsers.ExtractMarker(null));
    }

    [Fact]
    public void ExtractMarker_Empty()
    {
        Assert.Null(TallyParsers.ExtractMarker(""));
    }

    [Fact]
    public void ExtractMarker_Partial()
    {
        Assert.Null(TallyParsers.ExtractMarker("[ERP:"));
    }

    [Fact]
    public void ParseLedgers_NumericBalance_NoType()
    {
        // Tolerant: handle balance as plain number
        var json = """{"status":"1","data":{"collection":[{"name":"Cash","parent":"Bank","closingbalance":"123.45"}]}}""";
        var ledgers = TallyParsers.ParseLedgers(json);
        Assert.Single(ledgers);
        Assert.Equal(123.45m, ledgers[0].ClosingBalance);
    }

    [Fact]
    public void ParseVouchers_DeletedVoucher()
    {
        var json = """
        {
          "status": "1",
          "data": {
            "collection": [
              {
                "guid": "deleted-guid-001",
                "vouchertypename": "Payment",
                "vouchernumber": "99",
                "date": "20250601",
                "amount": { "type": "Amount", "value": "500.00" },
                "isdeleted": true,
                "allledgerentries": []
              }
            ]
          }
        }
        """;
        var vouchers = TallyParsers.ParseVouchers(json);
        Assert.Single(vouchers);
        Assert.True(vouchers[0].IsDeleted);
        Assert.Equal("deleted-guid-001", vouchers[0].Guid);
    }
}

/// <summary>
/// Simulator-driven TallyClient tests: probe, export, fault injection.
/// Covers TS-T07 (wrong company) and TS-T02 read side (Tally closed/unreachable).
/// </summary>
public sealed class TallyClientTests : IAsyncLifetime
{
    private TallySimulator _sim = null!;
    private TallyClient _client = null!;
    private AgentOptions _opts = null!;

    public ValueTask InitializeAsync()
    {
        _sim = new TallySimulator();
        _sim.Start();
        _opts = new AgentOptions
        {
            TallyHost = "127.0.0.1",
            TallyPort = _sim.Port,
            CloudBaseUrl = "http://127.0.0.1:1234",
            HttpTimeoutSeconds = 10,
        };
        _client = new TallyClient(_opts, "Test Company", NullLogger.Instance);
        return ValueTask.CompletedTask;
    }

    public async ValueTask DisposeAsync()
    {
        _client.Dispose();
        await _sim.StopAsync();
        _sim.Dispose();
    }

    [Fact]
    public async Task Probe_TallyUp_ReturnsReachable()
    {
        var result = await _client.ProbeAsync(CancellationToken.None);
        Assert.True(result.Reachable);
        Assert.NotNull(result.Company);
        Assert.Equal("Test Company", result.Company.TallyName);
    }

    [Fact]
    public async Task Probe_TallyDown_ReturnsUnreachable_TS_T02()
    {
        // TS-T02 read side: Tally is closed (not listening)
        // Create a client pointing to a port that nothing listens on
        var deadPort = FindFreePort();
        var opts = new AgentOptions
        {
            TallyHost = "127.0.0.1",
            TallyPort = deadPort,
            CloudBaseUrl = "http://127.0.0.1:1234",
            HttpTimeoutSeconds = 5,
        };
        using var client = new TallyClient(opts, "Test Company", NullLogger.Instance);
        var result = await client.ProbeAsync(CancellationToken.None);

        Assert.False(result.Reachable);
        Assert.Null(result.Company);
        Assert.NotNull(result.Error);
    }

    [Fact]
    public async Task Probe_WrongCompany_ReturnsUnreachable_TS_T07()
    {
        // TS-T07: Tally returns status 0 (wrong company or company not found)
        _sim.Fault = SimulatorFault.WrongCompany;

        var result = await _client.ProbeAsync(CancellationToken.None);

        Assert.False(result.Reachable);
        Assert.NotNull(result.Error);
    }

    [Fact]
    public async Task Probe_MalformedResponse_ReturnsUnreachable()
    {
        _sim.Fault = SimulatorFault.Malformed;

        // Malformed JSON will throw during parse. Probe should catch and return unreachable.
        var result = await _client.ProbeAsync(CancellationToken.None);
        Assert.False(result.Reachable);
    }

    [Fact]
    public async Task ExportLedgers_ReturnsParsedLedgers()
    {
        var ledgers = await _client.ExportLedgersAsync(CancellationToken.None);
        Assert.Equal(3, ledgers.Count);
        Assert.Equal("Cash", ledgers[0].Name);
        Assert.Equal(50000.00m, ledgers[0].ClosingBalance);
    }

    [Fact]
    public async Task ExportVouchers_ReturnsParsedVouchers()
    {
        var vouchers = await _client.ExportVouchersAsync(CancellationToken.None);
        Assert.Single(vouchers);
        Assert.Equal("Receipt", vouchers[0].VoucherTypeName);
        Assert.NotNull(vouchers[0].Narration);
    }

    [Fact]
    public async Task ExportBalances_ReturnsLedgersWithBalances()
    {
        var balances = await _client.ExportBalancesAsync(CancellationToken.None);
        Assert.Equal(3, balances.Count);
        Assert.NotEqual(0m, balances[0].ClosingBalance);
    }

    [Fact]
    public async Task Export_SendsCorrectHeaders()
    {
        await _client.ExportLedgersAsync(CancellationToken.None);

        Assert.True(_sim.LastRequestHeaders.ContainsKey("tallyrequest"));
        Assert.Equal("export", _sim.LastRequestHeaders["tallyrequest"]);
        Assert.Equal("collection", _sim.LastRequestHeaders["type"]);
        Assert.Equal("Ledger", _sim.LastRequestHeaders["id"]);
        Assert.Equal("1", _sim.LastRequestHeaders["version"]);
    }

    [Fact]
    public async Task Export_BodyContainsSvCurrentCompany()
    {
        await _client.ExportLedgersAsync(CancellationToken.None);
        Assert.NotNull(_sim.LastRequestBody);
        Assert.Contains("svCurrentCompany", _sim.LastRequestBody);
        Assert.Contains("Test Company", _sim.LastRequestBody);
    }

    [Fact]
    public async Task Export_BodyContainsJsonExFormat()
    {
        await _client.ExportLedgersAsync(CancellationToken.None);
        Assert.NotNull(_sim.LastRequestBody);
        Assert.Contains("svExportFormat", _sim.LastRequestBody);
        Assert.Contains("jsonex", _sim.LastRequestBody);
    }

    [Fact]
    public void Constructor_RejectsNonLoopback()
    {
        var opts = new AgentOptions
        {
            TallyHost = "192.168.1.100",
            TallyPort = 9000,
            CloudBaseUrl = "https://example.com",
        };
        Assert.Throws<ArgumentException>(() => new TallyClient(opts, "Co", NullLogger.Instance));
    }

    [Fact]
    public async Task Probe_RecordsRequestCount()
    {
        var before = _sim.RequestCount;
        await _client.ProbeAsync(CancellationToken.None);
        Assert.True(_sim.RequestCount > before);
    }

    private static int FindFreePort()
    {
        using var l = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
        l.Start();
        var port = ((System.Net.IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return port;
    }
}

