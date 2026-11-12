using System.Net;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using TradeX.Agent.Core.Cloud;
using TradeX.Agent.Core.Config;
using TradeX.Agent.Core.Journal;
using TradeX.Agent.Core.Registration;
using TradeX.Agent.Core.Runtime;
using TradeX.Agent.Tests.Fakes;
using Xunit;

namespace TradeX.Agent.Tests;

public sealed class RuntimeTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "tradex-agent-tests-" + Guid.NewGuid().ToString("N"));
    private readonly AgentJournal _journal;
    private readonly FakeCloud _cloud = new();
    private readonly FakeTally _tally = new();
    private readonly FakeTimeProvider _clock = new(new DateTimeOffset(2026, 11, 12, 8, 0, 0, TimeSpan.Zero));
    private readonly List<IAgentWork> _works = [];
    private readonly AgentIdentity _identity = new("agent-1", "company-1", new ExpectedCompany("Test Co", "1", "2024-04-01"), "https://erp.example.com", DateTimeOffset.UnixEpoch);

    public RuntimeTests()
    {
        _journal = AgentJournal.Open(Path.Combine(_dir, "journal.db"));
    }

    public void Dispose()
    {
        _journal.Dispose();
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
    }

    private AgentRuntime Runtime() =>
        new(_cloud, _tally, _journal, _identity, new AgentOptions { CloudBaseUrl = "https://erp.example.com" }, _works, _clock, NullLogger<AgentRuntime>.Instance);

    private sealed class BlockingWork : IAgentWork
    {
        public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public bool SawCancellation { get; private set; }
        public int Runs { get; private set; }

        public async Task RunAsync(WorkContext context, CancellationToken leaseToken)
        {
            Runs++;
            Started.TrySetResult();
            try
            {
                await Task.Delay(Timeout.Infinite, leaseToken);
            }
            catch (OperationCanceledException)
            {
                SawCancellation = true;
                throw;
            }
        }
    }

    private sealed class CountingWork : IAgentWork
    {
        public int Runs { get; private set; }

        public Task RunAsync(WorkContext context, CancellationToken leaseToken)
        {
            Runs++;
            return Task.CompletedTask;
        }
    }

    [Fact]
    public async Task Acquires_the_lease_when_tally_and_company_check_out_and_runs_work()
    {
        var work = new CountingWork();
        _works.Add(work);
        var runtime = Runtime();

        await runtime.StepAsync(CancellationToken.None);

        Assert.Equal(AgentState.Active, runtime.State);
        Assert.Equal(1, runtime.HeldEpoch);
        Assert.Equal(1, work.Runs);
        Assert.Equal(Fp.Fingerprint, _journal.GetValue(StatusKeys.CompanyFingerprint));
        var snapshot = StatusSnapshot.Read(_identity, _journal);
        Assert.Equal("Active", snapshot.State);
        Assert.Equal(1, snapshot.LeaseEpoch);
        Assert.True(snapshot.TallyReachable);
    }

    [Fact]
    public async Task Heartbeat_reports_epoch_tally_state_and_journal_backlog_then_records_posting_mode()
    {
        _journal.RecordPostIntent("o1", 1, "[ERP:1]", new string('b', 64));
        _cloud.OnHeartbeat = _ => new HeartbeatResponse("2030-01-01T00:00:00.000Z", "TEST_ONLY", ["FULL_RECON"]);
        var runtime = Runtime();
        await runtime.StepAsync(CancellationToken.None);

        await runtime.HeartbeatOnceAsync(CancellationToken.None);

        var sent = _cloud.Heartbeats.Single();
        Assert.Equal(1, sent.Epoch);
        Assert.True(sent.TallyReachable);
        Assert.Equal("7.0", sent.TallyVersion);
        Assert.True(sent.CompanyMatch);
        Assert.Equal(1, sent.JournalPending);
        Assert.Equal("TEST_ONLY", runtime.PostingMode);
        Assert.Equal(["FULL_RECON"], runtime.PendingCommands);
        Assert.Equal("true", _journal.GetValue(StatusKeys.LastHeartbeatOk));
    }

    [Fact]
    public async Task Lease_loss_stops_work_in_flight_and_marks_the_agent_lease_lost()
    {
        var work = new BlockingWork();
        _works.Add(work);
        _cloud.OnHeartbeat = _ => throw Fp.Api(HttpStatusCode.Conflict, "LEASE_STALE");
        var runtime = Runtime();

        var step = runtime.StepAsync(CancellationToken.None);
        await work.Started.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.False(runtime.LeaseToken.IsCancellationRequested);

        await runtime.HeartbeatOnceAsync(CancellationToken.None);
        await step.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.True(work.SawCancellation);
        Assert.Equal(AgentState.LeaseLost, runtime.State);
        Assert.Null(runtime.HeldEpoch);
        Assert.Contains("stale", _journal.GetValue(StatusKeys.LastError), StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_revoked_agent_loses_the_lease_on_the_next_heartbeat()
    {
        var runtime = Runtime();
        await runtime.StepAsync(CancellationToken.None);
        _cloud.OnHeartbeat = _ => throw Fp.Api(HttpStatusCode.Unauthorized, "UNAUTHENTICATED");

        await runtime.HeartbeatOnceAsync(CancellationToken.None);

        Assert.Equal(AgentState.LeaseLost, runtime.State);
        Assert.Null(runtime.HeldEpoch);
    }

    [Fact]
    public async Task After_a_lost_lease_the_next_step_acquires_a_new_epoch()
    {
        var runtime = Runtime();
        await runtime.StepAsync(CancellationToken.None);
        _cloud.OnHeartbeat = _ => throw Fp.Api(HttpStatusCode.Conflict, "LEASE_STALE");
        await runtime.HeartbeatOnceAsync(CancellationToken.None);
        _cloud.OnAcquire = _ => new LeaseAcquireResponse(2, "2030-01-01T00:00:00.000Z");

        await runtime.StepAsync(CancellationToken.None);

        Assert.Equal(2, runtime.HeldEpoch);
        Assert.Equal(AgentState.Active, runtime.State);
    }

    [Fact]
    public async Task Without_heartbeat_answers_the_lease_expires_locally_before_the_server_could_hand_it_on()
    {
        var work = new BlockingWork();
        _works.Add(work);
        _cloud.OnHeartbeat = _ => throw new CloudUnavailableException("network down");
        var runtime = Runtime();
        var step = runtime.StepAsync(CancellationToken.None);
        await work.Started.Task.WaitAsync(TimeSpan.FromSeconds(10));

        _clock.Advance(TimeSpan.FromSeconds(79));
        await runtime.HeartbeatOnceAsync(CancellationToken.None); // fails, lease still within its local deadline
        Assert.False(runtime.LeaseToken.IsCancellationRequested);

        _clock.Advance(TimeSpan.FromSeconds(2)); // 81 s after the last good send: before the server's 90 s expiry
        await step.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.True(work.SawCancellation);
        Assert.Null(runtime.HeldEpoch);
    }

    [Fact]
    public async Task A_successful_heartbeat_extends_the_local_deadline()
    {
        var runtime = Runtime();
        await runtime.StepAsync(CancellationToken.None);

        _clock.Advance(TimeSpan.FromSeconds(60));
        await runtime.HeartbeatOnceAsync(CancellationToken.None);
        _clock.Advance(TimeSpan.FromSeconds(60)); // 120 s after the acquire, 60 s after the heartbeat

        Assert.Equal(1, runtime.HeldEpoch);
        Assert.False(runtime.LeaseToken.IsCancellationRequested);
    }

    [Fact]
    public async Task A_second_agent_sees_lease_held_and_runs_no_work()
    {
        var work = new CountingWork();
        _works.Add(work);
        _cloud.OnAcquire = _ => throw Fp.Api(HttpStatusCode.Conflict, "LEASE_HELD");
        var runtime = Runtime();

        await runtime.StepAsync(CancellationToken.None);

        Assert.Equal(AgentState.LeaseHeldByOther, runtime.State);
        Assert.Null(runtime.HeldEpoch);
        Assert.Equal(0, work.Runs);
    }

    [Fact]
    public async Task Company_mismatch_takes_no_lease_runs_no_work_and_names_both_companies_in_the_error()
    {
        var work = new CountingWork();
        _works.Add(work);
        _cloud.OnVerify = _ => new CompanyVerifyResponse(false, Fp.Fingerprint);
        var runtime = Runtime();

        await runtime.StepAsync(CancellationToken.None);

        Assert.Equal(AgentState.CompanyMismatch, runtime.State);
        Assert.Equal(0, _cloud.AcquireCalls);
        Assert.Equal(0, work.Runs);
        Assert.Contains("Test Co", _journal.GetValue(StatusKeys.LastError), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Company_mismatch_after_acquiring_keeps_heartbeating_with_company_match_false()
    {
        var runtime = Runtime();
        await runtime.StepAsync(CancellationToken.None);
        _cloud.OnVerify = _ => new CompanyVerifyResponse(false, Fp.Fingerprint);
        await runtime.StepAsync(CancellationToken.None);

        await runtime.HeartbeatOnceAsync(CancellationToken.None);

        Assert.Equal(AgentState.CompanyMismatch, runtime.State);
        Assert.Equal(1, runtime.HeldEpoch);
        Assert.False(_cloud.Heartbeats.Single().CompanyMatch);
    }

    [Fact]
    public async Task Unreachable_tally_skips_company_verification_and_the_lease()
    {
        _tally.OnProbe = () => TallyProbeResult.Unreachable("connection refused");
        var runtime = Runtime();

        await runtime.StepAsync(CancellationToken.None);

        Assert.Equal(AgentState.WaitingForTally, runtime.State);
        Assert.Equal(0, _cloud.VerifyCalls);
        Assert.Equal(0, _cloud.AcquireCalls);
        Assert.Equal("false", _journal.GetValue(StatusKeys.TallyReachable));
    }

    [Fact]
    public async Task A_throwing_work_item_is_recorded_and_the_lease_is_kept()
    {
        _works.Add(new ThrowingWork());
        var runtime = Runtime();

        await runtime.StepAsync(CancellationToken.None);

        Assert.Equal(1, runtime.HeldEpoch);
        Assert.Contains("ThrowingWork failed", _journal.GetValue(StatusKeys.LastError), StringComparison.Ordinal);
    }

    private sealed class ThrowingWork : IAgentWork
    {
        public Task RunAsync(WorkContext context, CancellationToken leaseToken) => throw new InvalidOperationException("boom");
    }

    [Fact]
    public async Task Graceful_shutdown_releases_the_lease_at_the_held_epoch()
    {
        _cloud.OnAcquire = _ => new LeaseAcquireResponse(5, "2030-01-01T00:00:00.000Z");
        var runtime = Runtime();
        using var stopping = new CancellationTokenSource();
        var run = runtime.RunAsync(stopping.Token);

        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (runtime.State != AgentState.Active && DateTime.UtcNow < deadline) await Task.Delay(10);
        Assert.Equal(AgentState.Active, runtime.State);

        await stopping.CancelAsync();
        await run.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal([5L], _cloud.Released);
        Assert.Equal(AgentState.Stopped, runtime.State);
        Assert.Null(runtime.HeldEpoch);
    }

    [Fact]
    public async Task Release_failure_does_not_throw()
    {
        var failing = new FailingReleaseCloud(_cloud);
        var other = new AgentRuntime(failing, _tally, _journal, _identity, new AgentOptions(), _works, _clock, NullLogger<AgentRuntime>.Instance);
        await other.StepAsync(CancellationToken.None);

        await other.ReleaseLeaseAsync();

        Assert.Null(other.HeldEpoch);
    }

    private sealed class FailingReleaseCloud(FakeCloud inner) : ICloudClient
    {
        public Task<RegisterResponse> RegisterAsync(RegisterRequest request, CancellationToken ct) => inner.RegisterAsync(request, ct);
        public Task<CompanyVerifyResponse> VerifyCompanyAsync(ObservedCompany observed, CancellationToken ct) => inner.VerifyCompanyAsync(observed, ct);
        public Task<LeaseAcquireResponse> AcquireLeaseAsync(string fingerprint, CancellationToken ct) => inner.AcquireLeaseAsync(fingerprint, ct);
        public Task ReleaseLeaseAsync(long epoch, CancellationToken ct) => throw new CloudUnavailableException("down");
        public Task<HeartbeatResponse> HeartbeatAsync(HeartbeatRequest request, CancellationToken ct) => inner.HeartbeatAsync(request, ct);
        public Task<IReadOnlyList<WatermarkDto>> GetWatermarksAsync(CancellationToken ct) => inner.GetWatermarksAsync(ct);
        public Task<VersionResponse> GetVersionAsync(CancellationToken ct) => inner.GetVersionAsync(ct);
    }
}
