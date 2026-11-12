namespace TradeX.Agent.Tally;

/// <summary>
/// The read side of Tally that the import pipeline needs. <see cref="TallyClient"/> is the real implementation; tests
/// use the loopback simulator or a scripted fake. Every method throws <see cref="TallyRequestException"/> (or an
/// <see cref="HttpRequestException"/>) when Tally cannot answer correctly, and never returns an empty list for an error.
/// </summary>
public interface ITallyReader
{
    Task<IReadOnlyList<TallyMaster>> ExportMastersAsync(TallyMasterKind kind, CancellationToken ct);

    /// <summary>Ledgers with closing balances (the balance is part of the ledger export).</summary>
    Task<IReadOnlyList<TallyLedger>> ExportLedgersAsync(CancellationToken ct);

    Task<IReadOnlyList<TallyVoucher>> ExportVouchersAsync(CancellationToken ct);
}
