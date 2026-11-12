using System.Globalization;
using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using TradeX.Agent.Core.Cloud;
using TradeX.Agent.Core.Config;
using TradeX.Agent.Core.Journal;
using TradeX.Agent.Core.Runtime;

namespace TradeX.Agent.Tally.Import;

/// <summary>Journal <c>kv</c> keys written by the import pipeline (read by the status command).</summary>
public static class ImportKeys
{
    public const string LastSuccessAt = "import.last_success_at";
    public const string LastError = "import.last_error";
    public const string LastReconAt = "import.last_recon_at";
}

/// <summary>
/// Import side of the agent main loop (TALLY_INTEGRATION section 6 steps 4, 5 and 7, SYNC_DESIGN section 5), run only
/// while the lease is held and the company is verified. One cycle:
/// <list type="number">
/// <item>Resend every journalled batch the cloud has not acknowledged (the batch id makes a resend idempotent).</item>
/// <item>If due (interval, restart, command): read masters, vouchers and ledger balances from Tally. Any Tally failure
/// ends the cycle with nothing sent and nothing reconciled.</item>
/// <item>Send masters, vouchers, balances in batches of at most 500. Every batch is written to disk and journalled
/// PREPARED before the network write and ACKED only after the cloud answered, so a network loss after the Tally read
/// loses nothing (TS-T04). A stream with nothing new still sends one empty batch: that is what moves the cloud
/// freshness clock.</item>
/// <item>Reconciliation snapshot (start, nightly at 02:00 local, FULL_RECON): the guids Tally holds in the window.</item>
/// </list>
/// ALTERID is not used (NOT VERIFIED): every cycle exports the whole collection and the agent skips records whose
/// content hash it already sent; the cloud dedupes by guid and content hash anyway, so skipping is only a traffic saving.
/// </summary>
public sealed class ImportWork(
    ICloudClient cloud,
    ITallyReader tally,
    AgentOptions options,
    string payloadDirectory,
    TimeProvider clock,
    ILogger<ImportWork> log) : IAgentWork
{
    private static readonly TimeOnly NightlyAt = new(2, 0);
    private static readonly TallyMasterKind[] OptionalKinds =
    [
        TallyMasterKind.Group,
        TallyMasterKind.Unit,
        TallyMasterKind.StockItem,
        TallyMasterKind.VoucherType,
        TallyMasterKind.CostCentre,
    ];

    // key "STREAM|key" -> content hash of what the cloud acknowledged. In memory only: after a restart everything is
    // resent once, which is safe (idempotent) and is wanted anyway (restart also reconciles).
    private readonly Dictionary<string, string> _acknowledged = new();
    private DateTimeOffset? _lastCycleAt;
    private DateOnly? _lastReconDay;
    private bool _refreshPending;
    private bool _fullReconPending;
    private bool _refusedThisCycle;

    public async Task RunAsync(WorkContext context, CancellationToken leaseToken)
    {
        leaseToken.ThrowIfCancellationRequested();

        // Step 4: journal recovery comes before any new work.
        await ResendPendingAsync(context, leaseToken).ConfigureAwait(false);

        if (context.ConsumeCommand(AgentCommands.RefreshMasters)) _refreshPending = true;
        if (context.ConsumeCommand(AgentCommands.FullRecon)) _fullReconPending = true;

        var now = clock.GetUtcNow();
        var due = _lastCycleAt is null
                  || _refreshPending
                  || _fullReconPending
                  || now - _lastCycleAt.Value >= TimeSpan.FromSeconds(options.ImportIntervalSeconds);
        if (!due) return;

        try
        {
            await CycleAsync(context, now, leaseToken).ConfigureAwait(false);
        }
        catch (Exception ex) when (IsTallyFailure(ex, leaseToken))
        {
            // Tally went away or answered wrongly in the middle of the read. Nothing was sent for this cycle and no
            // reconciliation ran (an empty or partial export must never flag vouchers deleted). Try again next loop.
            log.LogWarning("Import cycle abandoned, Tally did not answer correctly: {Reason}", ex.Message);
            context.Journal.SetValue(ImportKeys.LastError, "Tally read failed: " + ex.Message);
        }
    }

    private static bool IsTallyFailure(Exception ex, CancellationToken leaseToken) => ex switch
    {
        TallyRequestException => true,
        HttpRequestException => true,
        JsonException => true,
        TaskCanceledException => !leaseToken.IsCancellationRequested, // HttpClient timeout, not a lost lease
        _ => false,
    };

    private async Task CycleAsync(WorkContext context, DateTimeOffset now, CancellationToken ct)
    {
        _refusedThisCycle = false;
        if (_refreshPending) ClearAcknowledged(ImportStreams.Masters);

        // ---- read everything from Tally first; nothing is sent until the whole read worked -------------------------
        var ledgers = await tally.ExportLedgersAsync(ct).ConfigureAwait(false);
        var optional = new Dictionary<TallyMasterKind, IReadOnlyList<TallyMaster>>();
        foreach (var kind in OptionalKinds)
        {
            try
            {
                optional[kind] = await tally.ExportMastersAsync(kind, ct).ConfigureAwait(false);
            }
            catch (TallyRequestException ex)
            {
                // Group, unit, voucher type, cost centre collections are NOT VERIFIED (section 8 b). The cycle goes on
                // without that kind; the mapper falls back to the documented direct parent.
                log.LogWarning("Master kind {Kind} is not available from Tally ({Reason}); skipped this cycle.", kind, ex.Message);
                optional[kind] = [];
            }
        }

        var vouchers = await tally.ExportVouchersAsync(ct).ConfigureAwait(false);

        var mapper = new ImportMapper(optional[TallyMasterKind.Group], optional[TallyMasterKind.VoucherType], ledgers);
        var masterRecords = mapper.MapMasters(OptionalKinds.SelectMany(k => optional[k]).ToList(), ledgers);
        var voucherRecords = mapper.MapVouchers(vouchers);
        var local = clock.GetLocalNow();
        var balanceRecords = mapper.MapBalances(ledgers, DateOnly.FromDateTime(local.DateTime));

        var report = mapper.Report;
        if (report.MastersWithoutGuid > 0)
            log.LogWarning("{Count} masters came without a guid and are keyed by name (confirm in WP-05.7).", report.MastersWithoutGuid);
        if (report.VouchersSkippedNoDate > 0)
            log.LogWarning("{Count} vouchers skipped: no readable date.", report.VouchersSkippedNoDate);
        if (report.VouchersSkippedTooManyLines > 0)
            log.LogWarning("{Count} vouchers skipped: more than {Max} ledger lines.", report.VouchersSkippedTooManyLines, ImportMapper.MaxVoucherLedgerLines);

        // ---- send: masters, vouchers, balances (SYNC_DESIGN section 5) ----------------------------------------------
        await SendStreamAsync(context, ImportStreams.Masters, masterRecords, ct).ConfigureAwait(false);
        await SendStreamAsync(context, ImportStreams.Vouchers, voucherRecords, ct).ConfigureAwait(false);
        await SendStreamAsync(context, ImportStreams.Balances, balanceRecords, ct).ConfigureAwait(false);

        // ---- reconciliation ----------------------------------------------------------------------------------------
        var today = DateOnly.FromDateTime(local.DateTime);
        var nightlyDue = _lastReconDay is null
                         || (TimeOnly.FromDateTime(local.DateTime) >= NightlyAt && _lastReconDay < today);
        if (_fullReconPending || nightlyDue)
        {
            await ReconAsync(context, vouchers, _fullReconPending, today, ct).ConfigureAwait(false);
            _lastReconDay = today;
            _fullReconPending = false;
            context.Journal.SetValue(ImportKeys.LastReconAt, now.ToString("O", CultureInfo.InvariantCulture));
        }

        _refreshPending = false;
        _lastCycleAt = now;
        context.Journal.SetValue(ImportKeys.LastSuccessAt, now.ToString("O", CultureInfo.InvariantCulture));
        if (!_refusedThisCycle) context.Journal.RemoveValue(ImportKeys.LastError); // a refusal stays visible until a clean cycle
    }

    // ----- sending ---------------------------------------------------------------------------------------------------

    private async Task SendStreamAsync<T>(WorkContext context, string stream, IReadOnlyList<Keyed<T>> items, CancellationToken ct)
    {
        var changed = items.Where(i => !_acknowledged.TryGetValue(stream + "|" + i.Key, out var h) || h != i.Hash).ToList();

        if (changed.Count == 0)
        {
            // Nothing new: still tell the cloud the read worked (moves last_success_at; stale detection depends on it).
            await SendBatchAsync(context, stream, new List<Keyed<T>>(), ct).ConfigureAwait(false);
            return;
        }

        foreach (var chunk in changed.Chunk(ImportStreams.MaxRecordsPerBatch))
        {
            ct.ThrowIfCancellationRequested();
            await SendBatchAsync(context, stream, chunk, ct).ConfigureAwait(false);
        }
    }

    private async Task SendBatchAsync<T>(WorkContext context, string stream, IReadOnlyList<Keyed<T>> chunk, CancellationToken ct)
    {
        var batchId = Guid.NewGuid().ToString();
        var request = new ImportBatchRequest<T>(batchId, context.Epoch, stream, chunk.Select(c => c.Record).ToList());
        var json = JsonSerializer.Serialize(request, CloudClient.Json);

        var path = Path.Combine(payloadDirectory, batchId + ".json");
        WriteDurably(path, json);
        context.Journal.BeginImport(batchId, stream, null, null, path); // PREPARED before the network write

        var accepted = await PostAndAckAsync(context.Journal, batchId, json, path, ct).ConfigureAwait(false);
        if (accepted)
        {
            foreach (var item in chunk) _acknowledged[stream + "|" + item.Key] = item.Hash;
        }
    }

    /// <summary>
    /// Posts one batch. Returns true when the cloud applied it. A permanent refusal (validation, id reuse) is logged,
    /// the journal row is closed so it cannot block everything after it, and false is returned so the records are not
    /// remembered as sent. Lease, auth and network failures propagate: the row stays PREPARED and is resent next cycle.
    /// </summary>
    private async Task<bool> PostAndAckAsync(AgentJournal journal, string batchId, string json, string path, CancellationToken ct)
    {
        try
        {
            await cloud.PostImportBatchAsync(json, ct).ConfigureAwait(false);
        }
        catch (CloudApiException ex) when (IsPermanentRefusal(ex))
        {
            log.LogError("The cloud refused import batch {BatchId} for good ({Code}); it will not be resent.", batchId, ex.Code);
            journal.SetValue(ImportKeys.LastError, $"Batch refused: {ex.Code}");
            _refusedThisCycle = true;
            journal.AckImport(batchId);
            TryDelete(path);
            return false;
        }

        journal.AckImport(batchId);
        TryDelete(path);
        return true;
    }

    private static bool IsPermanentRefusal(CloudApiException ex) =>
        !ex.IsLeaseStale && !ex.IsLeaseHeld && !ex.IsAuthFailure
        && ex.StatusCode is HttpStatusCode.BadRequest or HttpStatusCode.Conflict or HttpStatusCode.UnprocessableEntity
            or HttpStatusCode.RequestEntityTooLarge;

    /// <summary>Resends journalled batches the cloud never acknowledged, oldest first, under the current epoch.</summary>
    private async Task ResendPendingAsync(WorkContext context, CancellationToken ct)
    {
        foreach (var row in context.Journal.PendingImports())
        {
            ct.ThrowIfCancellationRequested();

            if (row.PayloadPath is null || !File.Exists(row.PayloadPath))
            {
                // The data is gone but it is not lost: Tally still has it and the next cycle exports it again.
                log.LogWarning("Import batch {BatchId} has no payload file; closing the journal row.", row.BatchId);
                context.Journal.AckImport(row.BatchId);
                continue;
            }

            // The epoch may have changed since the batch was prepared (TS-T10). The batch id keeps the resend idempotent.
            var node = JsonNode.Parse(await File.ReadAllTextAsync(row.PayloadPath, ct).ConfigureAwait(false))!.AsObject();
            node["epoch"] = context.Epoch;

            log.LogInformation("Resending unacknowledged import batch {BatchId} ({Stream}).", row.BatchId, row.Stream);
            await PostAndAckAsync(context.Journal, row.BatchId, node.ToJsonString(), row.PayloadPath, ct).ConfigureAwait(false);
        }
    }

    // ----- reconciliation --------------------------------------------------------------------------------------------

    private async Task ReconAsync(
        WorkContext context, IReadOnlyList<TallyVoucher> vouchers, bool full, DateOnly today, CancellationToken ct)
    {
        DateOnly from, to;
        if (full)
        {
            // Whole financial year: FY start month of this year (or last year if it has not started yet) for 12 months.
            var startYear = today.Month >= options.FinancialYearStartMonth ? today.Year : today.Year - 1;
            from = new DateOnly(startYear, options.FinancialYearStartMonth, 1);
            to = from.AddMonths(12).AddDays(-1);
        }
        else
        {
            // Current and previous month.
            var thisMonth = new DateOnly(today.Year, today.Month, 1);
            from = thisMonth.AddMonths(-1);
            to = thisMonth.AddMonths(1).AddDays(-1);
        }

        // Vouchers Tally holds inside the window. One whose date could not be read is listed too: its window is
        // unknown, and listing it can only prevent a deletion flag, never cause one. Tally's own deleted flag is not listed.
        var refs = vouchers
            .Where(v => !v.IsDeleted && (v.Date == default || (v.Date >= from && v.Date <= to)))
            .Select(v => new ReconVoucherRef(v.Guid))
            .ToList();

        if (refs.Count > 50_000)
        {
            log.LogError("Reconciliation skipped: {Count} vouchers exceed the 50,000 limit of one snapshot.", refs.Count);
            return;
        }

        var request = new ReconSnapshotRequest(
            Guid.NewGuid().ToString(), context.Epoch,
            from.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            to.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            full, refs);

        // A snapshot is recomputed from Tally on every attempt, so it is not journalled: if this call fails the
        // cycle is retried and builds a fresh one.
        var response = await cloud.PostReconSnapshotAsync(request, ct).ConfigureAwait(false);
        log.LogInformation(
            "Reconciliation {Kind} {From}..{To}: {Listed} vouchers listed, {Flagged} flagged deleted in Tally.",
            full ? "full" : "routine", request.PeriodFrom, request.PeriodTo, refs.Count, response.MissingMarkedDeleted);
    }

    // ----- helpers ---------------------------------------------------------------------------------------------------

    private void ClearAcknowledged(string stream)
    {
        var prefix = stream + "|";
        foreach (var key in _acknowledged.Keys.Where(k => k.StartsWith(prefix, StringComparison.Ordinal)).ToList())
            _acknowledged.Remove(key);
    }

    /// <summary>Writes the file and forces it to disk before the journal row that points at it exists.</summary>
    private static void WriteDurably(string path, string content)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        using var stream = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough);
        using (var writer = new StreamWriter(stream, new System.Text.UTF8Encoding(false), leaveOpen: true)) writer.Write(content);
        stream.Flush(flushToDisk: true);
    }

    private static void TryDelete(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (IOException)
        {
            // Left behind harmlessly: the journal row is closed, nothing reads this file again.
        }
    }
}
