namespace TradeX.Agent.Core.Runtime;

/// <summary>
/// One held lease at one epoch. <see cref="Token"/> is cancelled when the lease is lost (stale epoch, revoked) or when
/// it expires locally. The local deadline is the time the last successful heartbeat was <em>sent</em> plus the lease
/// time to live minus a margin: the server sets expiry after it receives the request, so the local deadline is always
/// earlier than the server's and no clock agreement is needed. Work must stop at the deadline, because another agent can
/// take the lease the moment the server considers it expired (SYNC_DESIGN section 4).
/// </summary>
public sealed class LeaseSession : IDisposable
{
    /// <summary>Lease time to live on the server (contracts <c>LEASE_TTL_SECONDS</c>).</summary>
    public static readonly TimeSpan ServerTtl = TimeSpan.FromSeconds(90);

    /// <summary>Safety margin below the server TTL.</summary>
    public static readonly TimeSpan Margin = TimeSpan.FromSeconds(10);

    private readonly CancellationTokenSource _cts;

    public LeaseSession(long epoch, string expiresAt, DateTimeOffset sentAt, TimeProvider clock)
    {
        Epoch = epoch;
        ExpiresAt = expiresAt;
        _cts = new CancellationTokenSource(Deadline(sentAt) - clock.GetUtcNow(), clock);
        Token = _cts.Token; // captured once: reading the token after Dispose would throw
    }

    public long Epoch { get; }

    /// <summary>Server reported expiry, for display only.</summary>
    public string ExpiresAt { get; private set; }

    public CancellationToken Token { get; }

    public bool IsLost => _cts.IsCancellationRequested;

    public void Renew(string expiresAt, DateTimeOffset sentAt, TimeProvider clock)
    {
        if (_cts.IsCancellationRequested) return; // a lost lease is never revived: the main loop re-acquires
        ExpiresAt = expiresAt;
        var remaining = Deadline(sentAt) - clock.GetUtcNow();
        if (remaining <= TimeSpan.Zero) _cts.Cancel();
        else _cts.CancelAfter(remaining);
    }

    public void Cancel() => _cts.Cancel();

    public void Dispose() => _cts.Dispose();

    private static DateTimeOffset Deadline(DateTimeOffset sentAt) => sentAt + ServerTtl - Margin;
}
