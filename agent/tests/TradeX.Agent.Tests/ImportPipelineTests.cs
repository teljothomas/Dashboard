using System.Globalization;
using System.Net;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using TradeX.Agent.Core.Cloud;
using TradeX.Agent.Core.Config;
using TradeX.Agent.Core.Journal;
using TradeX.Agent.Core.Registration;
using TradeX.Agent.Core.Runtime;
using TradeX.Agent.Tally;
using TradeX.Agent.Tally.Import;
using TradeX.Agent.Tests.Fakes;
using TradeX.Agent.Tools;
using Xunit;

namespace TradeX.Agent.Tests;

/// <summary>
/// WP-05.5 harness: the real <see cref="AgentRuntime"/>, <see cref="TallyClient"/> over loopback to the
/// <see cref="TallySimulator"/>, a real SQLite journal, and the in-process <see cref="FakeApiServer"/> standing in for the
/// cloud. Covers TS-T01, TS-T04, TS-T07 (import side), TS-T10 and TS-T12 from QUALITY_GATES section 4.
/// </summary>
public sealed class ImportPipelineTests : IAsyncLifetime
{
    private const string Company = "Test Company";

    private readonly string _dir = Path.Combine(Path.GetTempPath(), "tradex-import-tests-" + Guid.NewGuid().ToString("N"));
    private readonly FakeTimeProvider _clock = new(new DateTimeOffset(2026, 11, 12, 8, 0, 0, TimeSpan.Zero));
    private readonly FakeApiServer _api = new();
    private readonly FakeCloud _cloud = new();
    private readonly AgentIdentity _identity = new("agent-1", "company-1", new ExpectedCompany(Company, "1", "2024-04-01"), "https://erp.example.com", DateTimeOffset.UnixEpoch);
    private TallySimulator _sim = null!;
    private TallyClient _tally = null!;
    private AgentJournal _journal = null!;
    private AgentOptions _options = null!;

    public ValueTask InitializeAsync()
    {
        _sim = new TallySimulator();
        _sim.VoucherResponse = Vouchers(("g-1", "20261101", "1000.00", "first [ERP:a1b2c3d4-e5f6-7890-abcd-ef1234567890]"));
        _sim.Start();
        _options = new AgentOptions { TallyPort = _sim.Port, CloudBaseUrl = "http://127.0.0.1:1234", HttpTimeoutSeconds = 10 };
        _tally = new TallyClient(_options, Company, NullLogger.Instance);
        _journal = AgentJournal.Open(Path.Combine(_dir, "journal.db"), _clock);
        _cloud.OnPostBatch = _api.PostBatch;
        _cloud.OnPostRecon = _api.PostRecon;
        _cloud.OnAcquire = _ => new LeaseAcquireResponse(_api.Epoch, "2030-01-01T00:00:00.000Z");
        return ValueTask.CompletedTask;
    }

    public async ValueTask DisposeAsync()
    {
        _tally.Dispose();
        await _sim.StopAsync();
        _sim.Dispose();
        _journal.Dispose();
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
    }

    private string PayloadDir => Path.Combine(_dir, "import");

    private ImportWork NewWork() => new(_cloud, _tally, _options, PayloadDir, _clock, NullLogger<ImportWork>.Instance);

    private AgentRuntime NewRuntime(ImportWork? work = null) =>
        new(_cloud, _tally, _journal, _identity, _options, [work ?? NewWork()], _clock, NullLogger<AgentRuntime>.Instance);

    private static string Vouchers(params (string Guid, string Date, string Amount, string Narration)[] items)
    {
        var collection = new JsonArray();
        for (var i = 0; i < items.Length; i++)
        {
            var (guid, date, amount, narration) = items[i];
            var number = (i + 1).ToString(CultureInfo.InvariantCulture);
            collection.Add(new JsonObject
            {
                ["date"] = Typed("Date", date),
                ["guid"] = guid,
                ["vouchertypename"] = "Receipt",
                ["vouchernumber"] = number,
                ["isdeleted"] = false,
                ["masterid"] = Typed("Number", " " + number),
                ["amount"] = Typed("Amount", amount),
                ["narration"] = narration,
                ["allledgerentries"] = new JsonArray(Entry("Customer A", false, amount), Entry("Bank Account", true, "-" + amount)),
            });
        }

        return new JsonObject { ["status"] = "1", ["data"] = new JsonObject { ["collection"] = collection } }.ToJsonString();

        static JsonObject Typed(string type, string value) => new() { ["type"] = type, ["value"] = value };

        static JsonObject Entry(string ledger, bool positive, string amount) => new()
        {
            ["ledgername"] = Typed("String", ledger),
            ["isdeemedpositive"] = new JsonObject { ["type"] = "Logical", ["value"] = positive },
            ["amount"] = Typed("Amount", amount),
        };
    }

    private static string ManyVouchers(int count) =>
        Vouchers(Enumerable.Range(1, count).Select(i => ($"g-{i}", "20261101", "10.00", "n")).ToArray());

    private void PassInterval() => _clock.Advance(TimeSpan.FromSeconds(_options.ImportIntervalSeconds + 1));

    /// <summary>Lets the import interval pass the way it really does: heartbeats every 30 s keep the lease alive.</summary>
    private async Task PassIntervalAsync(AgentRuntime runtime)
    {
        for (var seconds = 0; seconds < _options.ImportIntervalSeconds + 1; seconds += _options.HeartbeatSeconds)
        {
            _clock.Advance(TimeSpan.FromSeconds(_options.HeartbeatSeconds));
            await runtime.HeartbeatOnceAsync(CancellationToken.None);
        }
    }

    // ---------------------------------------------------------------------------------------------------------------

    [Fact]
    public async Task First_cycle_sends_masters_vouchers_balances_and_a_startup_reconciliation()
    {
        var runtime = NewRuntime();

        await runtime.StepAsync(CancellationToken.None);

        Assert.Equal(AgentState.Active, runtime.State);
        Assert.Single(_api.Vouchers);
        Assert.Equal(3, _api.MastersStored);   // the three ledgers (no other master kind in the simulator)
        Assert.Equal(3, _api.BalancesStored);  // Cash-in-Hand, Bank Accounts, Sundry Debtors
        Assert.Equal(["MASTERS", "VOUCHERS", "BALANCES"], _api.AppliedBatches.Select(b => b.Stream).ToArray());
        var snapshot = Assert.Single(_api.Snapshots);
        Assert.False(snapshot.IsFull);
        Assert.Equal("2026-10-01", snapshot.PeriodFrom);
        Assert.Equal("2026-11-30", snapshot.PeriodTo);
        Assert.Equal(["g-1"], snapshot.Vouchers.Select(v => v.Guid).ToArray());
        Assert.Equal(0, _journal.Counts().Pending);
        Assert.Empty(Directory.GetFiles(PayloadDir)); // payload files removed once acknowledged
        Assert.Null(_journal.GetValue(ImportKeys.LastError));
        Assert.NotNull(_journal.GetValue(ImportKeys.LastSuccessAt));
    }

    [Fact]
    public async Task Batches_hold_at_most_500_records()
    {
        _sim.VoucherResponse = ManyVouchers(1200);
        var runtime = NewRuntime();

        await runtime.StepAsync(CancellationToken.None);

        var voucherBatches = _api.AppliedBatches.Where(b => b.Stream == "VOUCHERS").Select(b => b.Records).ToArray();
        Assert.Equal([500, 500, 200], voucherBatches);
        Assert.Equal(1200, _api.Vouchers.Count);
        Assert.All(_api.AppliedBatches, b => Assert.True(b.Records <= 500));
    }

    [Fact]
    public async Task Nothing_is_sent_again_inside_the_interval_and_empty_batches_follow_after_it()
    {
        var runtime = NewRuntime();
        await runtime.StepAsync(CancellationToken.None);
        var afterFirst = _api.AppliedBatches.Count;

        await runtime.StepAsync(CancellationToken.None);
        Assert.Equal(afterFirst, _api.AppliedBatches.Count); // not due yet

        await PassIntervalAsync(runtime);
        await runtime.StepAsync(CancellationToken.None);

        // Unchanged data: one empty batch per stream still moves the cloud freshness clock.
        var added = _api.AppliedBatches.Skip(afterFirst).ToList();
        Assert.Equal(["MASTERS", "VOUCHERS", "BALANCES"], added.Select(b => b.Stream).ToArray());
        Assert.All(added, b => Assert.Equal(0, b.Records));
        Assert.Equal(2, _api.SuccessCount["VOUCHERS"]);
        Assert.Single(_api.Snapshots); // no second reconciliation inside the same day
    }

    [Fact]
    public async Task TS_T01_tally_off_for_a_day_then_back_drains_everything()
    {
        _sim.Pause(); // Tally PC off
        var runtime = NewRuntime();

        await runtime.StepAsync(CancellationToken.None);
        Assert.Equal(AgentState.WaitingForTally, runtime.State);

        for (var hour = 0; hour < 24; hour++)
        {
            _clock.Advance(TimeSpan.FromHours(1));
            await runtime.StepAsync(CancellationToken.None);
        }

        Assert.Empty(_api.AppliedBatches);
        Assert.Empty(_api.Snapshots);

        _sim.Resume(); // Tally PC is back
        await runtime.StepAsync(CancellationToken.None);

        Assert.Equal(AgentState.Active, runtime.State);
        Assert.Single(_api.Vouchers);
        Assert.Equal(0, _journal.Counts().Pending);
        Assert.Single(_api.Snapshots);
    }

    [Fact]
    public async Task TS_T04_answer_lost_after_apply_resends_the_same_batch_and_nothing_is_duplicated()
    {
        _api.DropNextBatchAnswer = false;
        var runtime = NewRuntime();
        // Let masters through, lose the answer of the first VOUCHERS batch.
        _cloud.OnPostBatch = json =>
        {
            if (json.Contains("\"stream\":\"VOUCHERS\"", StringComparison.Ordinal) && _api.SuccessCount["VOUCHERS"] == 0)
                _api.DropNextBatchAnswer = true;
            return _api.PostBatch(json);
        };

        await runtime.StepAsync(CancellationToken.None);

        // Tally was read, the cloud applied the vouchers, but the agent never heard back.
        Assert.Single(_api.Vouchers);
        Assert.Equal(1, _journal.Counts().ImportPrepared);
        Assert.Single(Directory.GetFiles(PayloadDir));
        var created = _api.Created;

        await runtime.StepAsync(CancellationToken.None); // network is back: journal recovery first

        Assert.Equal(0, _journal.Counts().ImportPrepared);
        Assert.Empty(Directory.GetFiles(PayloadDir));
        Assert.Single(_api.Vouchers);
        // The replay changed nothing; the follow-up cycle found the same voucher (unchanged, not created twice) and only
        // the balances, never reached in the first cycle, were created.
        Assert.Equal(created + 3, _api.Created);
        Assert.Equal(1, _api.Unchanged);
    }

    [Fact]
    public async Task TS_T10_resend_after_reconnect_uses_the_new_epoch()
    {
        _api.NetworkDown = true;
        var first = NewRuntime();
        await first.StepAsync(CancellationToken.None); // lease acquired (epoch 1), every batch post fails

        Assert.Equal(1, _journal.Counts().ImportPrepared);
        var payload = Assert.Single(Directory.GetFiles(PayloadDir));
        Assert.Contains("\"epoch\":1,", File.ReadAllText(payload), StringComparison.Ordinal);

        // Outage ends. The lease expired meanwhile, so the cloud hands out epoch 2 to the restarted agent.
        _api.NetworkDown = false;
        _api.Epoch = 2;
        var restarted = NewRuntime();
        await restarted.StepAsync(CancellationToken.None);

        Assert.Equal(2L, restarted.HeldEpoch);
        Assert.Equal(0, _journal.Counts().ImportPrepared);
        Assert.All(_api.AppliedBatches, b => Assert.Equal(2L, b.Epoch));
        Assert.Single(_api.Vouchers);
    }

    [Fact]
    public async Task TS_T12_altered_voucher_is_upserted_and_a_deleted_one_is_flagged_by_reconciliation()
    {
        _sim.VoucherResponse = Vouchers(("g-1", "20261101", "1000.00", "one"), ("g-2", "20261102", "200.00", "two"));
        var runtime = NewRuntime();
        await runtime.StepAsync(CancellationToken.None);
        Assert.Equal(2, _api.Vouchers.Count);
        var updatedBefore = _api.Updated;

        // g-1 altered in Tally (amount and narration), g-2 deleted in Tally.
        _sim.VoucherResponse = Vouchers(("g-1", "20261101", "1500.00", "one altered"));
        await PassIntervalAsync(runtime);
        _cloud.OnHeartbeat = _ => new HeartbeatResponse("2030-01-01T00:00:00.000Z", "DISABLED", [AgentCommands.FullRecon]);
        await runtime.HeartbeatOnceAsync(CancellationToken.None); // the cloud asks for a full reconciliation
        await runtime.StepAsync(CancellationToken.None);

        Assert.Equal(updatedBefore + 1, _api.Updated);
        Assert.Equal("1500.00", _api.Vouchers["g-1"].Amount);
        Assert.Equal("one altered", _api.Vouchers["g-1"].Narration);
        Assert.False(_api.Vouchers["g-1"].DeletedInTally);
        Assert.True(_api.Vouchers["g-2"].DeletedInTally);   // flagged, never removed
        Assert.True(_api.FullReconStamped);
        var full = _api.Snapshots[^1];
        Assert.True(full.IsFull);
        Assert.Equal("2026-04-01", full.PeriodFrom);
        Assert.Equal("2027-03-31", full.PeriodTo);
        Assert.Empty(runtime.PendingCommands); // consumed, not run again on the next step

        // g-2 comes back (undo in Tally): the next reconciliation clears the flag.
        _sim.VoucherResponse = Vouchers(("g-1", "20261101", "1500.00", "one altered"), ("g-2", "20261102", "200.00", "two"));
        await PassIntervalAsync(runtime);
        await runtime.HeartbeatOnceAsync(CancellationToken.None); // the cloud asks again
        await runtime.StepAsync(CancellationToken.None);
        Assert.False(_api.Vouchers["g-2"].DeletedInTally);
    }

    [Theory]
    [InlineData(SimulatorFault.WrongCompany)]
    [InlineData(SimulatorFault.Malformed)]
    public async Task A_bad_tally_answer_sends_nothing_and_never_flags_vouchers_deleted(SimulatorFault fault)
    {
        var runtime = NewRuntime();
        await runtime.StepAsync(CancellationToken.None);
        var batches = _api.AppliedBatches.Count;
        var snapshots = _api.Snapshots.Count;

        // Tally now answers wrongly (company closed or switched, garbled reply) while the probe still passes.
        _sim.Fault = fault;
        PassInterval();
        var work = NewWork();
        var context = new WorkContext(_api.Epoch, "DISABLED", _journal)
        {
            Commands = [AgentCommands.FullRecon],
            ConsumeCommand = c => c == AgentCommands.FullRecon,
        };
        await work.RunAsync(context, CancellationToken.None);

        Assert.Equal(batches, _api.AppliedBatches.Count);
        Assert.Equal(snapshots, _api.Snapshots.Count);
        Assert.False(_api.Vouchers["g-1"].DeletedInTally);
        Assert.NotNull(_journal.GetValue(ImportKeys.LastError));
    }

    [Fact]
    public async Task TS_T07_wrong_company_runs_no_import()
    {
        _cloud.OnVerify = _ => new CompanyVerifyResponse(false, Fp.Fingerprint);
        var runtime = NewRuntime();

        await runtime.StepAsync(CancellationToken.None);

        Assert.Equal(AgentState.CompanyMismatch, runtime.State);
        Assert.Empty(_api.AppliedBatches);
        Assert.Empty(_api.Snapshots);
    }

    [Fact]
    public async Task A_permanent_refusal_is_closed_in_the_journal_and_does_not_block_the_rest()
    {
        _api.RefuseNextBatch = new CloudApiException(HttpStatusCode.BadRequest, "VALIDATION", "bad record", null);
        var runtime = NewRuntime();

        await runtime.StepAsync(CancellationToken.None);

        // The refused masters batch is closed (not resent forever); vouchers and balances still went through.
        Assert.Equal(0, _journal.Counts().ImportPrepared);
        Assert.Equal(0, _api.MastersStored);
        Assert.Single(_api.Vouchers);
        Assert.Equal("Batch refused: VALIDATION", _journal.GetValue(ImportKeys.LastError));
    }

    [Fact]
    public async Task A_stale_lease_is_not_treated_as_a_permanent_refusal()
    {
        _api.Epoch = 5; // the agent will present epoch 1
        _cloud.OnAcquire = _ => new LeaseAcquireResponse(1, "2030-01-01T00:00:00.000Z");
        var runtime = NewRuntime();

        await runtime.StepAsync(CancellationToken.None);

        Assert.Empty(_api.AppliedBatches);
        Assert.Equal(1, _journal.Counts().ImportPrepared); // kept for a resend under a fresh lease
    }

    [Fact]
    public async Task Refresh_masters_command_resends_the_masters()
    {
        var runtime = NewRuntime();
        await runtime.StepAsync(CancellationToken.None);

        _cloud.OnHeartbeat = _ => new HeartbeatResponse("2030-01-01T00:00:00.000Z", "DISABLED", [AgentCommands.RefreshMasters]);
        await runtime.HeartbeatOnceAsync(CancellationToken.None);
        await runtime.StepAsync(CancellationToken.None); // not due by time, but the command makes it due

        var masterBatches = _api.AppliedBatches.Where(b => b.Stream == "MASTERS").Select(b => b.Records).ToArray();
        Assert.Equal([3, 3], masterBatches);
    }

    [Fact]
    public async Task Work_stops_when_the_lease_token_is_cancelled()
    {
        var work = NewWork();
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();
        var context = new WorkContext(1, "DISABLED", _journal);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => work.RunAsync(context, cts.Token));
        Assert.Empty(_api.AppliedBatches);
    }
}
