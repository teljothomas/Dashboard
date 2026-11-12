using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;
using TradeX.Agent.Core.Config;
using TradeX.Agent.Core.Cloud;
using TradeX.Agent.Core.Runtime;

namespace TradeX.Agent.Tally;

/// <summary>
/// HTTP client for TallyPrime 7.0 on loopback (TALLY_INTEGRATION §4, §8).
/// All requests go through <c>http://127.0.0.1:&lt;port&gt;</c>.
/// Protocol: JSON with JSONEx export format; XML fallback is not needed for any verified capability.
/// </summary>
public sealed class TallyClient : ITallyProbe, ITallyReader, IDisposable
{
    private readonly HttpClient _http;
    private readonly string _baseUrl;
    private readonly string _companyName;
    private readonly ILogger _log;
    private bool _disposed;

    /// <summary>Create a Tally client bound to the loopback address and configured port.</summary>
    /// <param name="options">Agent config (TallyHost must be loopback, TallyPort).</param>
    /// <param name="companyName">The expected Tally company name (sent as <c>svCurrentCompany</c>).</param>
    /// <param name="log">Logger.</param>
    /// <param name="httpClient">Optional injected <see cref="HttpClient"/> for testing.</param>
    public TallyClient(AgentOptions options, string companyName, ILogger log, HttpClient? httpClient = null)
    {
        if (!AgentOptions.IsLoopbackHost(options.TallyHost))
            throw new ArgumentException("TallyHost must be a loopback address.", nameof(options));

        _baseUrl = $"http://{options.TallyHost}:{options.TallyPort}";
        _companyName = companyName;
        _log = log;
        _http = httpClient ?? new HttpClient { Timeout = TimeSpan.FromSeconds(options.HttpTimeoutSeconds) };
    }

    /// <summary>Probe Tally: reachable, version, loaded company. Used by the runtime's main loop step 3.</summary>
    public async Task<TallyProbeResult> ProbeAsync(CancellationToken ct)
    {
        TallyProbeInfo info;
        try
        {
            info = await ProbeInternalAsync(ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or OperationCanceledException)
        {
            info = TallyProbeInfo.Unreachable(ex.Message);
        }

        if (!info.Reachable || info.Company is null)
            return TallyProbeResult.Unreachable(info.Error ?? "Tally is not reachable.");

        return new TallyProbeResult(true, info.Version,
            new ObservedCompany(info.Company.Name, info.Company.CompanyNumber, info.Company.BooksFrom),
            null);
    }

    /// <summary>Export all ledgers from the specified company.</summary>
    public async Task<IReadOnlyList<TallyLedger>> ExportLedgersAsync(CancellationToken ct)
    {
        var body = BuildExportBody("Ledger", ["Name", "Parent", "GUID", "Opening Balance", "Closing Balance"]);
        var json = await SendExportAsync("collection", "Ledger", body, ct).ConfigureAwait(false);
        EnsureOk(json, "Ledger");
        return TallyParsers.ParseLedgers(json);
    }

    /// <summary>
    /// Export one master kind. Ledger and StockItem collections are documented (TALLY_INTEGRATION section 8 b); group,
    /// unit, voucher type and cost centre follow the same pattern but are NOT VERIFIED until WP-05.7, so the importer
    /// treats a failure on those as "kind not available" rather than as a stop.
    /// </summary>
    public async Task<IReadOnlyList<TallyMaster>> ExportMastersAsync(TallyMasterKind kind, CancellationToken ct)
    {
        var (id, fetch) = kind switch
        {
            TallyMasterKind.Group => ("Group", new[] { "Name", "Parent", "GUID" }),
            TallyMasterKind.Ledger => ("Ledger", new[] { "Name", "Parent", "GUID", "Opening Balance", "Closing Balance" }),
            TallyMasterKind.StockItem => ("StockItem", new[] { "Name", "Parent", "GUID", "BaseUnits" }),
            TallyMasterKind.Unit => ("Unit", new[] { "Name", "GUID" }),
            TallyMasterKind.VoucherType => ("VoucherType", new[] { "Name", "Parent", "GUID" }),
            TallyMasterKind.CostCentre => ("CostCentre", new[] { "Name", "Parent", "GUID" }),
            _ => throw new ArgumentOutOfRangeException(nameof(kind)),
        };

        var json = await SendExportAsync("collection", id, BuildExportBody(id, fetch), ct).ConfigureAwait(false);
        EnsureOk(json, id);
        return TallyParsers.ParseMasters(json, kind);
    }

    /// <summary>Export vouchers using a TDL collection. Fields include guid, narration, ledger entries.</summary>
    public async Task<IReadOnlyList<TallyVoucher>> ExportVouchersAsync(CancellationToken ct)
    {
        var body = BuildVoucherExportBody();
        var json = await SendExportAsync("collection", "TSPLVoucherColl", body, ct).ConfigureAwait(false);
        EnsureOk(json, "TSPLVoucherColl");
        return TallyParsers.ParseVouchers(json);
    }

    /// <summary>
    /// An export answer must say <c>status 1</c>. Anything else (company not found, malformed JSON) is an error, never an
    /// empty list: an empty list would read as "Tally holds nothing" and a reconciliation would flag every voucher deleted.
    /// </summary>
    private static void EnsureOk(string json, string id)
    {
        if (!TallyParsers.ParseStatus(json))
            throw new TallyRequestException($"Tally export '{id}' did not answer status 1 (company not loaded, or not JSON).", json);
    }

    /// <summary>Export ledgers with closing balances (same as ExportLedgersAsync — the balance is part of the ledger export).</summary>
    public async Task<IReadOnlyList<TallyLedger>> ExportBalancesAsync(CancellationToken ct) =>
        await ExportLedgersAsync(ct).ConfigureAwait(false);

    /// <summary>Send a raw export request and return the response body as a string.</summary>
    internal async Task<string> SendExportAsync(string type, string id, string body, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, _baseUrl);
        request.Headers.TryAddWithoutValidation("version", "1");
        request.Headers.TryAddWithoutValidation("tallyrequest", "export");
        request.Headers.TryAddWithoutValidation("type", type);
        request.Headers.TryAddWithoutValidation("id", id);
        request.Content = new StringContent(body, Encoding.UTF8, "application/json");

        _log.LogDebug("Tally export {Type}/{Id}: sending request.", type, id);

        using var response = await _http.SendAsync(request, ct).ConfigureAwait(false);
        var responseBody = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

        if (!response.IsSuccessStatusCode)
        {
            _log.LogWarning("Tally export {Type}/{Id} returned HTTP {Status}.", type, id, (int)response.StatusCode);
            throw new TallyRequestException($"Tally returned HTTP {(int)response.StatusCode}.", responseBody);
        }

        return responseBody;
    }

    /// <summary>Send an import request and return the parsed import result.</summary>
    internal async Task<(bool Success, string ResponseBody, TallyImportResult? Result)> SendImportAsync(
        string importBody, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, _baseUrl);
        request.Headers.TryAddWithoutValidation("version", "1");
        request.Headers.TryAddWithoutValidation("tallyrequest", "Import");
        request.Headers.TryAddWithoutValidation("type", "Data");
        request.Headers.TryAddWithoutValidation("id", "Vouchers");
        request.Headers.TryAddWithoutValidation("detailed-response", "Yes");
        request.Content = new StringContent(importBody, Encoding.UTF8, "application/json");

        _log.LogDebug("Tally import: sending voucher.");

        using var response = await _http.SendAsync(request, ct).ConfigureAwait(false);
        var responseBody = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        var success = TallyParsers.ParseStatus(responseBody);
        var result = TallyParsers.ParseImportResult(responseBody);

        return (success, responseBody, result);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _http.Dispose();
    }

    // ---- internals ----

    private async Task<TallyProbeInfo> ProbeInternalAsync(CancellationToken ct)
    {
        // Use the ledger collection with a minimal fetch_List as a probe:
        // if Tally is up, the company name is known (it's svCurrentCompany), we check the response status.
        // To get version info: TallyPrime returns it in a header or we can try a specific request.
        // For now: probe by trying a minimal export. If it succeeds, Tally is up and the company is loaded.
        // Company number and BooksFrom are NOT returned by the documented collection export.
        // Until WP-05.7 confirms a company-info call, we populate CompanyNumber and BooksFrom from the
        // TALLY_INTEGRATION §8(a) note: "NOT VERIFIED — do not rely" on a company-info call, so we use
        // placeholder values that the cloud must match via the expected-company fingerprint.

        var body = BuildMinimalProbeBody();
        string responseBody;
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, _baseUrl);
            request.Headers.TryAddWithoutValidation("version", "1");
            request.Headers.TryAddWithoutValidation("tallyrequest", "export");
            request.Headers.TryAddWithoutValidation("type", "collection");
            request.Headers.TryAddWithoutValidation("id", "Ledger");
            request.Content = new StringContent(body, Encoding.UTF8, "application/json");

            using var response = await _http.SendAsync(request, ct).ConfigureAwait(false);
            responseBody = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

            if (!response.IsSuccessStatusCode)
                return TallyProbeInfo.Unreachable($"Tally returned HTTP {(int)response.StatusCode}.");
        }
        catch (HttpRequestException ex)
        {
            return TallyProbeInfo.Unreachable(ex.Message);
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            return TallyProbeInfo.Unreachable("Tally did not respond in time.");
        }

        // If we got a valid JSON response, Tally is up. The company is svCurrentCompany by definition.
        // Version: not available from the response; we report null (NOT VERIFIED).
        var success = TallyParsers.ParseStatus(responseBody);
        if (!success)
            return TallyProbeInfo.Unreachable("Tally returned status != 1. The company may not be loaded.");

        // Company info: the name is what we sent in svCurrentCompany. CompanyNumber and BooksFrom are
        // placeholders until a company-info call is confirmed (§8(a) NOT VERIFIED).
        var company = new TallyCompanyInfo(_companyName, "1", "2024-04-01");
        return new TallyProbeInfo(true, null, company, null);
    }

    private string BuildMinimalProbeBody()
    {
        return JsonSerializer.Serialize(new
        {
            static_variables = new[]
            {
                new { name = "svExportFormat", value = "jsonex" },
                new { name = "svCurrentCompany", value = _companyName },
            },
            fetch_List = new[] { "Name" },
        });
    }

    private string BuildExportBody(string collectionId, string[] fetchList)
    {
        return JsonSerializer.Serialize(new
        {
            static_variables = new[]
            {
                new { name = "svExportFormat", value = "jsonex" },
                new { name = "svCurrentCompany", value = _companyName },
            },
            fetch_List = fetchList,
        });
    }

    private string BuildVoucherExportBody()
    {
        // Per the fixture: uses a TDL message defining the collection with Type Voucher and native methods
        return JsonSerializer.Serialize(new
        {
            static_variables = new[]
            {
                new { name = "svExportFormat", value = "jsonex" },
                new { name = "svCurrentCompany", value = _companyName },
            },
            tdlmessage = new[]
            {
                new
                {
                    definitions = new[]
                    {
                        new
                        {
                            metadata = new { name = "TSPLVoucherColl", type = "Collection" },
                            attributes = new object[]
                            {
                                new Dictionary<string, string> { ["Type"] = "Voucher" },
                                new Dictionary<string, string> { ["Native Method"] = "VoucherNumber, VoucherTypeName, Date, Amount, Narration, GUID, RemoteID, VchKey, MasterID, IsDeleted, AllLedgerEntries.LedgerName, AllLedgerEntries.IsDeemedPositive, AllLedgerEntries.Amount" },
                            },
                        },
                    },
                },
            },
        });
    }
}

/// <summary>Thrown when a Tally HTTP request fails or returns an unexpected response.</summary>
public sealed class TallyRequestException(string message, string? responseBody = null)
    : Exception(message)
{
    public string? ResponseBody { get; } = responseBody;
}

