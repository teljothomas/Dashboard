using Microsoft.Extensions.Logging.Abstractions;
using TradeX.Agent.Core.Config;
using TradeX.Agent.Tally;
using TradeX.Agent.Tally.Import;
using TradeX.Agent.Tools;
using Xunit;

namespace TradeX.Agent.Tests;

public sealed class ImportMapperTests
{
    private static TallyMaster Group(string name, string? parent) => new(TallyMasterKind.Group, "gg-" + name, name, parent);

    private static TallyVoucher Voucher(string type, params TallyLedgerEntry[] entries) => new(
        "v-1", null, null, type, "7", new DateOnly(2026, 11, 1), 100m, 5, false, entries, "narr");

    private static ImportMapper Mapper(
        TallyMaster[]? groups = null, TallyMaster[]? types = null, TallyLedger[]? ledgers = null) =>
        new(groups ?? [], types ?? [], ledgers ?? []);

    [Fact]
    public void Money_has_exactly_two_fraction_digits_and_keeps_the_sign()
    {
        Assert.Equal("1000.00", ImportMapper.Money(1000m));
        Assert.Equal("-1000.50", ImportMapper.Money(-1000.5m));
        Assert.Equal("0.01", ImportMapper.Money(0.005m)); // away from zero, never banker's rounding
        Assert.Equal("0.00", ImportMapper.Money(-0.001m));
    }

    [Theory]
    [InlineData("Sales", "SALES")]
    [InlineData("receipt", "RECEIPT")]
    [InlineData("Credit Note", "CREDIT_NOTE")]
    [InlineData("Something Else", "OTHER")]
    public void Built_in_voucher_types_map_to_their_base_type(string name, string expected) =>
        Assert.Equal(expected, Mapper().BaseTypeOf(name));

    [Fact]
    public void A_custom_voucher_type_takes_the_base_type_of_its_parent()
    {
        var mapper = Mapper(types: [new(TallyMasterKind.VoucherType, "t1", "Sales - Meat", "Sales")]);
        Assert.Equal("SALES", mapper.BaseTypeOf("Sales - Meat"));
    }

    [Fact]
    public void A_voucher_type_cycle_ends_as_other_instead_of_looping()
    {
        var mapper = Mapper(types:
        [
            new(TallyMasterKind.VoucherType, "a", "A", "B"),
            new(TallyMasterKind.VoucherType, "b", "B", "A"),
        ]);
        Assert.Equal("OTHER", mapper.BaseTypeOf("A"));
    }

    [Fact]
    public void A_ledger_in_a_sub_group_of_sundry_debtors_is_a_party_and_its_balance_is_sent()
    {
        var ledgers = new[]
        {
            new TallyLedger("Hotel Alpha", "Retail Customers", 500m, "l-1"),
            new TallyLedger("Rent", "Indirect Expenses", 10m, "l-2"),
        };
        var mapper = Mapper(groups: [Group("Retail Customers", "Sundry Debtors")], ledgers: ledgers);

        var masters = mapper.MapMasters([], ledgers);
        var balances = mapper.MapBalances(ledgers, new DateOnly(2026, 11, 12));

        Assert.True(masters.Single(m => m.Record.Name == "Hotel Alpha").Record.IsParty);
        Assert.False(masters.Single(m => m.Record.Name == "Rent").Record.IsParty);
        var balance = Assert.Single(balances);
        Assert.Equal("Hotel Alpha", balance.Record.LedgerName);
        Assert.Equal("500.00", balance.Record.ClosingBalance);
        Assert.Equal("2026-11-12", balance.Record.AsOf);
    }

    [Fact]
    public void A_voucher_gets_its_party_ledger_and_signed_lines()
    {
        var ledgers = new[]
        {
            new TallyLedger("Customer A", "Sundry Debtors", 0m, "l-1"),
            new TallyLedger("Bank", "Bank Accounts", 0m, "l-2"),
        };
        var mapper = Mapper(ledgers: ledgers);
        var voucher = Voucher("Receipt", new TallyLedgerEntry("Customer A", false, 100m), new TallyLedgerEntry("Bank", true, -100m));

        var record = Assert.Single(mapper.MapVouchers([voucher])).Record;

        Assert.Equal("RECEIPT", record.BaseType);
        Assert.Equal("Customer A", record.PartyLedgerName);
        Assert.Equal("2026-11-01", record.VoucherDate);
        Assert.Equal(["100.00", "-100.00"], record.LedgerLines.Select(l => l.Amount).ToArray());
        Assert.Equal("l-1", record.LedgerLines[0].LedgerGuid);
        Assert.Null(record.AlterId);
    }

    [Fact]
    public void Oversized_text_is_clipped_so_one_voucher_cannot_make_the_cloud_refuse_a_whole_batch()
    {
        var voucher = Voucher("Receipt") with { Narration = new string('x', 5000), VoucherNumber = new string('9', 300) };

        var record = Assert.Single(Mapper().MapVouchers([voucher])).Record;

        Assert.Equal(4000, record.Narration!.Length);
        Assert.Equal(100, record.VoucherNumber.Length);
    }

    [Fact]
    public void A_voucher_without_a_readable_date_or_with_too_many_lines_is_skipped_and_counted()
    {
        var mapper = Mapper();
        var noDate = Voucher("Receipt") with { Date = default };
        var tooMany = Voucher("Receipt", Enumerable.Range(0, 201).Select(i => new TallyLedgerEntry("L" + i, false, 1m)).ToArray());

        Assert.Empty(mapper.MapVouchers([noDate, tooMany]));
        Assert.Equal(1, mapper.Report.VouchersSkippedNoDate);
        Assert.Equal(1, mapper.Report.VouchersSkippedTooManyLines);
    }

    [Fact]
    public void A_master_without_a_guid_is_keyed_by_kind_and_name_and_counted()
    {
        var mapper = Mapper();
        var unit = new TallyMaster(TallyMasterKind.Unit, null, "Kg", null);

        var record = Assert.Single(mapper.MapMasters([unit], [])).Record;

        Assert.Equal("NAME:UNIT:Kg", record.Guid);
        Assert.Equal(1, mapper.Report.MastersWithoutGuid);
    }

    [Fact]
    public void The_same_content_gives_the_same_hash_and_a_change_gives_a_new_one()
    {
        var mapper = Mapper();
        var a = mapper.MapVouchers([Voucher("Receipt")]).Single();
        var same = mapper.MapVouchers([Voucher("Receipt")]).Single();
        var changed = mapper.MapVouchers([Voucher("Receipt") with { Narration = "different" }]).Single();

        Assert.Equal(a.Hash, same.Hash);
        Assert.NotEqual(a.Hash, changed.Hash);
    }

    [Fact]
    public void Master_and_voucher_records_serialise_to_the_cloud_wire_shape()
    {
        var ledger = new TallyLedger("Cash", "Cash-in-Hand", 5m, "l-1", 2m);
        var mapper = Mapper(ledgers: [ledger]);
        var master = mapper.MapMasters([], [ledger]).Single().Record;
        var voucher = mapper.MapVouchers([Voucher("Sales")]).Single().Record;

        var masterJson = System.Text.Json.JsonSerializer.Serialize(master, TradeX.Agent.Core.Cloud.CloudClient.Json);
        var voucherJson = System.Text.Json.JsonSerializer.Serialize(voucher, TradeX.Agent.Core.Cloud.CloudClient.Json);

        // Kind-specific fields only; booleans never null (the cloud rejects explicit nulls for them).
        Assert.Contains("\"kind\":\"LEDGER\"", masterJson, StringComparison.Ordinal);
        Assert.Contains("\"parentGroup\":\"Cash-in-Hand\"", masterJson, StringComparison.Ordinal);
        Assert.Contains("\"openingBalance\":\"2.00\"", masterJson, StringComparison.Ordinal);
        Assert.DoesNotContain("\"unitName\"", masterJson, StringComparison.Ordinal);
        Assert.Contains("\"alterId\":null", masterJson, StringComparison.Ordinal);
        Assert.Contains("\"baseType\":\"SALES\"", voucherJson, StringComparison.Ordinal);
        Assert.Contains("\"isCancelled\":false", voucherJson, StringComparison.Ordinal);
    }
}

public sealed class TallyMasterParserTests
{
    [Fact]
    public void ParseLedgers_reads_guid_and_opening_balance_when_present()
    {
        const string json = """
        {"status":"1","data":{"collection":[
          {"name":{"type":"String","value":"Cash"},"parent":{"type":"String","value":"Cash-in-Hand"},
           "guid":{"type":"String","value":"g-cash"},"opening balance":{"type":"Amount","value":"10.00"},
           "closing balance":{"type":"Amount","value":"50.00"}}]}}
        """;

        var ledger = Assert.Single(TallyParsers.ParseLedgers(json));

        Assert.Equal("g-cash", ledger.Guid);
        Assert.Equal(10m, ledger.OpeningBalance);
        Assert.Equal(50m, ledger.ClosingBalance);
    }

    [Fact]
    public void ParseMasters_reads_stock_item_unit_and_tolerates_a_missing_guid()
    {
        const string json = """
        {"status":"1","data":{"collection":[
          {"name":{"type":"String","value":"Beef"},"parent":{"type":"String","value":"Meat"},"baseunits":{"type":"String","value":"Kg"}},
          {"name":{"type":"String","value":""}}]}}
        """;

        var master = Assert.Single(TallyParsers.ParseMasters(json, TallyMasterKind.StockItem));

        Assert.Equal("Beef", master.Name);
        Assert.Equal("Meat", master.Parent);
        Assert.Equal("Kg", master.UnitName);
        Assert.Null(master.Guid);
    }

    [Fact]
    public async Task Export_of_a_company_that_is_not_loaded_throws_instead_of_returning_an_empty_list_TS_T07()
    {
        using var sim = new TallySimulator { Fault = SimulatorFault.WrongCompany };
        sim.Start();
        // WrongCompany answers status 0 for every request; Start() listens because only Down skips listening.
        using var client = new TallyClient(
            new AgentOptions { TallyPort = sim.Port, CloudBaseUrl = "http://127.0.0.1:1", HttpTimeoutSeconds = 10 },
            "Test Company", NullLogger.Instance);

        await Assert.ThrowsAsync<TallyRequestException>(() => client.ExportVouchersAsync(CancellationToken.None));
        await Assert.ThrowsAsync<TallyRequestException>(() => client.ExportLedgersAsync(CancellationToken.None));
        await Assert.ThrowsAsync<TallyRequestException>(() => client.ExportMastersAsync(TallyMasterKind.Group, CancellationToken.None));
        await sim.StopAsync();
    }

    [Fact]
    public async Task Export_masters_uses_the_collection_id_and_returns_an_empty_collection_for_unknown_ids()
    {
        using var sim = new TallySimulator();
        sim.Start();
        using var client = new TallyClient(
            new AgentOptions { TallyPort = sim.Port, CloudBaseUrl = "http://127.0.0.1:1", HttpTimeoutSeconds = 10 },
            "Test Company", NullLogger.Instance);

        var none = await client.ExportMastersAsync(TallyMasterKind.CostCentre, CancellationToken.None);
        Assert.Empty(none);
        Assert.Equal("CostCentre", sim.LastRequestHeaders["id"]);

        sim.MasterResponses["Group"] = """{"status":"1","data":{"collection":[{"name":"Retail","parent":"Sundry Debtors","guid":"g1"}]}}""";
        var groups = await client.ExportMastersAsync(TallyMasterKind.Group, CancellationToken.None);
        Assert.Equal("Retail", Assert.Single(groups).Name);
        await sim.StopAsync();
    }
}
