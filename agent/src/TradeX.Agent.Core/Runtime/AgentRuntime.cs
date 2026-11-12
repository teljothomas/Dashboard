using TradeX.Agent.Core.Journal;
using System.Globalization;
using Microsoft.Extensions.Logging;
using TradeX.Agent.Core.Cloud;
using TradeX.Agent.Core.Config;
using TradeX.Agent.Core.Registration;

namespace TradeX.Agent.Core.Runtime;

/// <summary>Keys under which the runtime mirrors its state into the journal <c>kv</c> table for the status command.</summary>
public static class StatusKeys
{
    public const string State = "status.state";
    public const string LeaseEpoch = "status.lease_epoch";
    public const string LeaseExpiresAt = "status.lease_expires_at";
    public const string LastHeartbeatAt = "status.last_heartbeat_at";
    public const string LastHeartbeatOk = "status.last_heartbeat_ok";
    public const string LastError = "status.last_error";
    public const string TallyReachable = "status.tally_reachable";
    public const string TallyVersion = "status.tally_version";
    public const string PostingMode = "status.posting_mode";
    public const string CompanyFingerprint = "company_fingerprint";
    public const string UpdatedAt = "status.updated_at";
}

/// <summary>
/// The agent's control loop (TALLY_INTEGRATION section 6). The main loop probes Tally, verifies the company with the
/// cloud, acquires the lease and runs the registered work while the lease is held. The heartbeat runs on its own timer
/// and is the only thing that renews the lease; a stale epoch, a revoked agent or a missed deadline cancels the lease
/// token, which stops work at once. Shutdown releases the lease so a standby agent can take over quickly.
/// </summary>
public sealed class AgentRuntime(
    ICloudClient cloud,
    ITallyProbe tally,
    AgentJournal journal,
    AgentIdentity identity,
    AgentOptions options,
    IEnumerable<IAgentWork> works,
    TimeProvider clock,
    ILogger<AgentRuntime> log)
{
    private readonly object _gate = new();
    private readonly List<IAgentWork> _works = works.ToList();
    private LeaseSession? _session;
    private TallyProbeResult _probe = TallyProbeResult.Unreachable("not probed yet");
    private bool _companyMatch;
    private string? _lastError;

    public AgentState State { get; private set; } = AgentState.Starting;

    public string PostingMode { get; private set; } = "DISABLED";

    public IReadOnlyList<string> PendingCommands { get; private set; } = [];

    /// <summary>Epoch of the held lease, or null.</summary>
    public long? HeldEpoch
    {
        get
        {
            lock (_gate) return _session is { IsLost: false } s ? s.Epoch : null;
        }
    }

    /// <summary>Token of the held lease (already cancelled when none is held). Exposed for tests and diagnostics.</summary>
    public CancellationToken LeaseToken
    {
        get
        {
            lock (_gate) return _session?.Token ?? new CancellationToken(canceled: true);
        }
    }

    /// <summary>Runs until <paramref name="stopping"/> is cancelled, then releases the lease.</summary>
    public async Task RunAsync(CancellationToken stopping)
    {
        var heartbeats = Task.Run(() => HeartbeatLoopAsync(stopping), CancellationToken.None);
        try
        {
            while (!stopping.IsCancellationRequested)
            {
                await StepAsync(stopping).ConfigureAwait(false);
                await Task.Delay(TimeSpan.FromSeconds(options.MainLoopSeconds), clock, stopping).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested)
        {
            // normal shutdown
        }
        finally
        {
            await heartbeats.ConfigureAwait(false);
            await ReleaseLeaseAsync().ConfigureAwait(false);
            SetState(AgentState.Stopped);
        }
    }

    /// <summary>One main loop iteration: probe, verify company, acquire lease, run work.</summary>
    public async Task StepAsync(CancellationToken ct)
    {
        TallyProbeResult probe;
        try
        {
            probe = await tally.ProbeAsync(ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            probe = TallyProbeResult.Unreachable(ex.Message);
        }

        lock (_gate) _probe = probe;

        if (!probe.Reachable || probe.Company is null)
        {
            _companyMatch = false;
            RecordError(probe.Error ?? "Tally is not reachable.");
            SetState(AgentState.WaitingForTally);
            return;
        }

        CompanyVerifyResponse verified;
        try
        {
            verified = await cloud.VerifyCompanyAsync(probe.Company, ct).ConfigureAwait(false);
        }
        catch (CloudApiException ex)
        {
            RecordError($"Company verification failed: {ex.Code}");
            return;
        }
        catch (CloudUnavailableException ex)
        {
            RecordError(ex.Message);
            return;
        }

        if (!verified.Match)
        {
            // Mismatch: stop work, alert, keep heartbeating (so the cloud sees companyMatch=false).
            // The lease is kept so heartbeats go on; no work runs while the company does not match.
            _companyMatch = false;
            RecordError($"The company open in Tally ('{probe.Company.TallyName}') does not match the expected company ('{identity.ExpectedCompany.TallyName}').");
            log.LogError("Company mismatch: Tally has '{Observed}', expected '{Expected}'. Work is stopped.", probe.Company.TallyName, identity.ExpectedCompany.TallyName);
            SetState(AgentState.CompanyMismatch);
            return;
        }

        _companyMatch = true;
        journal.SetValue(StatusKeys.CompanyFingerprint, verified.Fingerprint);

        if (HeldEpoch is null && !await TryAcquireAsync(verified.Fingerprint, ct).ConfigureAwait(false)) return;

        await RunWorkAsync(ct).ConfigureAwait(false);
    }

    /// <summary>Sends one heartbeat if a lease is held. Called by the heartbeat timer; public for tests.</summary>
    public async Task HeartbeatOnceAsync(CancellationToken ct)
    {
        LeaseSession? session;
        TallyProbeResult probe;
        lock (_gate)
        {
            session = _session;
            probe = _probe;
        }

        if (session is null) return;
        if (session.IsLost)
        {
            LoseLease(session, "lease expired locally");
            return;
        }

        var sentAt = clock.GetUtcNow();
        var request = new HeartbeatRequest(
            session.Epoch, probe.Reachable, probe.Version, _companyMatch, journal.Counts().Pending, _lastError);

        try
        {
            var response = await cloud.HeartbeatAsync(request, ct).ConfigureAwait(false);
            session.Renew(response.ExpiresAt, sentAt, clock);
            PostingMode = response.PostingMode;
            PendingCommands = response.Commands;
            journal.SetValue(StatusKeys.LastHeartbeatAt, sentAt.ToString("O", CultureInfo.InvariantCulture));
            journal.SetValue(StatusKeys.LastHeartbeatOk, "true");
            PersistStatus();
        }
        catch (CloudApiException ex) when (ex.IsLeaseStale || ex.IsAuthFailure)
        {
            LoseLease(session, ex.IsAuthFailure ? "authentication failed (agent revoked?)" : "lease is stale");
        }
        catch (CloudApiException ex)
        {
            journal.SetValue(StatusKeys.LastHeartbeatOk, "false");
            RecordError($"Heartbeat rejected: {ex.Code}");
        }
        catch (CloudUnavailableException ex)
        {
            // No answer: keep working until the local deadline (the token cancels itself), then the lease is gone.
            journal.SetValue(StatusKeys.LastHeartbeatOk, "false");
            RecordError(ex.Message);
        }
    }

    /// <summary>Releases the held lease (best effort, short timeout). Safe to call when none is held.</summary>
    public async Task ReleaseLeaseAsync()
    {
        LeaseSession? session;
        lock (_gate)
        {
            session = _session;
            _session = null;
        }

        if (session is null) return;
        var wasLost = session.IsLost;
        session.Cancel();
        session.Dispose();
        if (wasLost) return;

        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        try
        {
            await cloud.ReleaseLeaseAsync(session.Epoch, timeout.Token).ConfigureAwait(false);
            log.LogInformation("Lease released at epoch {Epoch}.", session.Epoch);
        }
        catch (Exception ex) when (ex is CloudApiException or CloudUnavailableException or OperationCanceledException)
        {
            log.LogWarning("Lease release failed ({Reason}); it will expire on its own.", ex.Message);
        }
    }

    private async Task HeartbeatLoopAsync(CancellationToken stopping)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(options.HeartbeatSeconds), clock);
        try
        {
            while (await timer.WaitForNextTickAsync(stopping).ConfigureAwait(false))
            {
                try
                {
                    await HeartbeatOnceAsync(stopping).ConfigureAwait(false);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    log.LogError(ex, "Heartbeat failed unexpectedly.");
                    RecordError("Heartbeat failed unexpectedly.");
                }
            }
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested)
        {
            // normal shutdown
        }
    }

    private async Task<bool> TryAcquireAsync(string fingerprint, CancellationToken ct)
    {
        var sentAt = clock.GetUtcNow();
        try
        {
            var lease = await cloud.AcquireLeaseAsync(fingerprint, ct).ConfigureAwait(false);
            lock (_gate) _session = new LeaseSession(lease.Epoch, lease.ExpiresAt, sentAt, clock);
            journal.SetValue(StatusKeys.LeaseEpoch, lease.Epoch.ToString(CultureInfo.InvariantCulture));
            journal.SetValue(StatusKeys.LeaseExpiresAt, lease.ExpiresAt);
            log.LogInformation("Lease acquired at epoch {Epoch}.", lease.Epoch);
            SetState(AgentState.Active);
            return true;
        }
        catch (CloudApiException ex) when (ex.IsLeaseHeld)
        {
            RecordError("Another agent holds the lease.");
            SetState(AgentState.LeaseHeldByOther);
            return false;
        }
        catch (CloudApiException ex)
        {
            RecordError($"Lease acquire failed: {ex.Code}");
            SetState(ex.Code == "COMPANY_MISMATCH" ? AgentState.CompanyMismatch : AgentState.WaitingForTally);
            return false;
        }
        catch (CloudUnavailableException ex)
        {
            RecordError(ex.Message);
            return false;
        }
    }

    private async Task RunWorkAsync(CancellationToken ct)
    {
        LeaseSession? session;
        lock (_gate) session = _session;
        if (session is null || session.IsLost) return;

        var context = new WorkContext(session.Epoch, PostingMode, journal);
        foreach (var work in _works)
        {
            if (session.IsLost) break;
            try
            {
                await work.RunAsync(context, session.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (session.Token.IsCancellationRequested && !ct.IsCancellationRequested)
            {
                LoseLease(session, "lease lost during work");
                return;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                log.LogError(ex, "Work item {Work} failed.", work.GetType().Name);
                RecordError($"{work.GetType().Name} failed: {ex.Message}");
            }
        }

        if (!session.IsLost) SetState(AgentState.Active);
    }

    private void LoseLease(LeaseSession session, string reason)
    {
        lock (_gate)
        {
            if (!ReferenceEquals(_session, session)) return;
            _session = null;
        }

        session.Cancel();
        session.Dispose();
        journal.SetValue(StatusKeys.LastHeartbeatOk, "false");
        RecordError($"Lease lost: {reason}.");
        log.LogWarning("Lease lost at epoch {Epoch}: {Reason}. Work stopped.", session.Epoch, reason);
        SetState(AgentState.LeaseLost);
    }

    private void RecordError(string message)
    {
        _lastError = message;
        journal.SetValue(StatusKeys.LastError, message);
    }

    private void SetState(AgentState state)
    {
        State = state;
        PersistStatus();
    }

    private void PersistStatus()
    {
        TallyProbeResult probe;
        lock (_gate) probe = _probe;
        journal.SetValue(StatusKeys.State, State.ToString());
        journal.SetValue(StatusKeys.PostingMode, PostingMode);
        journal.SetValue(StatusKeys.TallyReachable, probe.Reachable ? "true" : "false");
        journal.SetValue(StatusKeys.TallyVersion, probe.Version ?? "");
        journal.SetValue(StatusKeys.UpdatedAt, clock.GetUtcNow().ToString("O", CultureInfo.InvariantCulture));
        if (HeldEpoch is null)
        {
            journal.RemoveValue(StatusKeys.LeaseEpoch);
            journal.RemoveValue(StatusKeys.LeaseExpiresAt);
        }
    }
}
