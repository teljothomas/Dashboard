using TradeX.Agent.Core.Journal;
using TradeX.Agent.Core.Cloud;

namespace TradeX.Agent.Core.Runtime;

/// <summary>What one look at Tally found (TALLY_INTEGRATION section 6 step 3).</summary>
public sealed record TallyProbeResult(bool Reachable, string? Version, ObservedCompany? Company, string? Error)
{
    public static TallyProbeResult Unreachable(string reason) => new(false, null, null, reason);
}

/// <summary>
/// Looks at Tally on loopback: reachable, version, loaded company. The real client arrives with WP-05.4; until then the
/// service reports Tally as unreachable and therefore never takes the lease.
/// </summary>
public interface ITallyProbe
{
    Task<TallyProbeResult> ProbeAsync(CancellationToken ct);
}

/// <summary>Used until the Tally client exists (WP-05.4). Honest: it always says Tally cannot be reached.</summary>
public sealed class NoTallyClientProbe : ITallyProbe
{
    public Task<TallyProbeResult> ProbeAsync(CancellationToken ct) =>
        Task.FromResult(TallyProbeResult.Unreachable("Tally client not installed in this agent build."));
}

/// <summary>
/// A unit of work that may run only while the lease is held (imports, posting). The token is cancelled the moment the
/// lease is lost, expires locally, or the company stops matching, and work must stop at once (SYNC_DESIGN section 4).
/// </summary>
public interface IAgentWork
{
    Task RunAsync(WorkContext context, CancellationToken leaseToken);
}

public sealed record WorkContext(long Epoch, string PostingMode, AgentJournal Journal)
{
    /// <summary>Commands the cloud sent with the latest heartbeat answer (for example FULL_RECON).</summary>
    public IReadOnlyList<string> Commands { get; init; } = [];

    /// <summary>
    /// Takes a command off the pending list so the work that handles it runs once, not once per heartbeat. Returns true
    /// when the command was pending. The cloud decides whether it keeps sending it.
    /// </summary>
    public Func<string, bool> ConsumeCommand { get; init; } = _ => false;
}

public enum AgentState
{
    Starting,
    WaitingForTally,
    CompanyMismatch,
    LeaseHeldByOther,
    Active,
    LeaseLost,
    Stopped,
}
