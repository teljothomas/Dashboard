using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using TradeX.Agent.Core.Cloud;

namespace TradeX.Agent.Tests.Fakes;

/// <summary>
/// In-process stand-in for the cloud import endpoints, applying the same rules as
/// <c>apps/api/src/modules/tally/importApply.ts</c>: lease epoch check, batches idempotent by id (hash of stream and
/// records, not of the epoch), upsert by guid with a content hash, reconciliation that flags vouchers missing from a
/// snapshot window and clears the flag for those listed. It is NOT the Node API: the Node side is covered by the api
/// integration suite (WP-05.2); this exists so the agent's recovery paths run against the real wire JSON.
/// </summary>
public sealed class FakeApiServer
{
    public sealed record StoredVoucher(string Guid, string Hash, string Date, string? Narration, string Amount, bool DeletedInTally, JsonObject Record);

    private readonly Dictionary<string, (string Hash, ImportBatchResponse Result)> _batches = new();
    private readonly Dictionary<string, string> _masters = new();   // "KIND|guid" -> hash
    private readonly Dictionary<string, string> _balances = new();  // key -> hash
    public Dictionary<string, StoredVoucher> Vouchers { get; } = new();

    /// <summary>The epoch a lease holder must present. Raise it to simulate a new lease generation.</summary>
    public long Epoch { get; set; } = 1;

    /// <summary>Every call fails as if the network were down; nothing is applied.</summary>
    public bool NetworkDown { get; set; }

    /// <summary>The next import batch is applied, then the answer is "lost" (the agent sees the network fail).</summary>
    public bool DropNextBatchAnswer { get; set; }

    /// <summary>The next import batch is refused with this error (permanent refusal).</summary>
    public CloudApiException? RefuseNextBatch { get; set; }

    public List<(string Stream, int Records, long Epoch, string BatchId)> AppliedBatches { get; } = [];
    public List<int> BatchSizes => AppliedBatches.Select(b => b.Records).ToList();
    public int Created { get; private set; }
    public int Updated { get; private set; }
    public int Unchanged { get; private set; }
    public Dictionary<string, int> SuccessCount { get; } = new() { ["MASTERS"] = 0, ["VOUCHERS"] = 0, ["BALANCES"] = 0 };
    public List<ReconSnapshotRequest> Snapshots { get; } = [];
    public bool FullReconStamped { get; private set; }
    public int MastersStored => _masters.Count;
    public int BalancesStored => _balances.Count;

    public ImportBatchResponse PostBatch(string batchJson)
    {
        if (NetworkDown) throw new CloudUnavailableException("network down");

        var body = JsonNode.Parse(batchJson)!.AsObject();
        var epoch = body["epoch"]!.GetValue<long>();
        if (epoch != Epoch) throw new CloudApiException(HttpStatusCode.Conflict, "LEASE_STALE", "stale epoch", null);

        if (RefuseNextBatch is { } refusal)
        {
            RefuseNextBatch = null;
            throw refusal;
        }

        var id = body["batchId"]!.GetValue<string>();
        var stream = body["stream"]!.GetValue<string>();
        var records = body["records"]!.AsArray();
        var hash = Sha(stream + records.ToJsonString());

        if (_batches.TryGetValue(id, out var old))
        {
            if (old.Hash != hash) throw new CloudApiException(HttpStatusCode.Conflict, "IDEMPOTENCY_MISMATCH", "reused id", null);
            return old.Result;
        }

        int created = 0, updated = 0, unchanged = 0;
        foreach (var node in records)
        {
            var record = node!.AsObject();
            var recordHash = Sha(record.ToJsonString());
            switch (stream)
            {
                case "VOUCHERS":
                {
                    var guid = record["guid"]!.GetValue<string>();
                    var stored = new StoredVoucher(
                        guid, recordHash, record["voucherDate"]!.GetValue<string>(),
                        record["narration"]?.GetValue<string>(), record["amount"]!.GetValue<string>(), false, record);
                    if (!Vouchers.TryGetValue(guid, out var existing)) { Vouchers[guid] = stored; created++; }
                    else if (existing.Hash != recordHash) { Vouchers[guid] = stored with { DeletedInTally = existing.DeletedInTally }; updated++; }
                    else unchanged++;
                    break;
                }

                case "MASTERS":
                    Upsert(_masters, record["kind"]!.GetValue<string>() + "|" + record["guid"]!.GetValue<string>(), recordHash);
                    break;

                default:
                    Upsert(_balances, record["ledgerName"]!.GetValue<string>(), recordHash);
                    break;
            }
        }

        void Upsert(Dictionary<string, string> table, string key, string recordHash)
        {
            if (!table.TryGetValue(key, out var existing)) { table[key] = recordHash; created++; }
            else if (existing != recordHash) { table[key] = recordHash; updated++; }
            else unchanged++;
        }

        var result = new ImportBatchResponse("APPLIED", created, updated, unchanged);
        _batches[id] = (hash, result);
        AppliedBatches.Add((stream, records.Count, epoch, id));
        SuccessCount[stream]++;
        Created += created;
        Updated += updated;
        Unchanged += unchanged;

        if (DropNextBatchAnswer)
        {
            DropNextBatchAnswer = false;
            throw new CloudUnavailableException("answer lost");
        }

        return result;
    }

    public ReconSnapshotResponse PostRecon(ReconSnapshotRequest request)
    {
        if (NetworkDown) throw new CloudUnavailableException("network down");
        if (request.Epoch != Epoch) throw new CloudApiException(HttpStatusCode.Conflict, "LEASE_STALE", "stale epoch", null);

        Snapshots.Add(request);
        var listed = request.Vouchers.Select(v => v.Guid).ToHashSet();
        var flagged = 0;
        foreach (var (guid, v) in Vouchers.ToList())
        {
            var inWindow = string.CompareOrdinal(v.Date, request.PeriodFrom) >= 0 && string.CompareOrdinal(v.Date, request.PeriodTo) <= 0;
            if (!inWindow) continue;
            if (!listed.Contains(guid) && !v.DeletedInTally) { Vouchers[guid] = v with { DeletedInTally = true }; flagged++; }
            else if (listed.Contains(guid) && v.DeletedInTally) Vouchers[guid] = v with { DeletedInTally = false };
        }

        if (request.IsFull) FullReconStamped = true;
        return new ReconSnapshotResponse(flagged);
    }

    private static string Sha(string text) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)));
}
