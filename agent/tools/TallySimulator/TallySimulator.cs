using System.Net;
using System.Text;

namespace TradeX.Agent.Tools;

/// <summary>
/// A lightweight HTTP listener that impersonates TallyPrime 7.0 for automated testing.
/// Serves fixture JSON responses with controllable fault injection (down, slow, wrong company, malformed).
/// </summary>
public sealed class TallySimulator : IDisposable
{
    private readonly HttpListener _listener;
    private readonly CancellationTokenSource _cts = new();
    private Task? _loop;

    /// <summary>The port the simulator is listening on.</summary>
    public int Port { get; }

    /// <summary>Fault mode: None, Down (refuse connections), Slow (5 s delay), WrongCompany, Malformed.</summary>
    public SimulatorFault Fault { get; set; } = SimulatorFault.None;

    /// <summary>The JSON to return for ledger collection exports.</summary>
    public string LedgerResponse { get; set; } = DefaultLedgerResponse;

    /// <summary>The JSON to return for voucher collection exports.</summary>
    public string VoucherResponse { get; set; } = DefaultVoucherResponse;

    /// <summary>The JSON to return for import requests.</summary>
    public string ImportResponse { get; set; } = DefaultImportResponse;

    /// <summary>Number of requests received.</summary>
    public int RequestCount { get; private set; }

    /// <summary>The last request body received.</summary>
    public string? LastRequestBody { get; private set; }

    /// <summary>The last request headers.</summary>
    public Dictionary<string, string> LastRequestHeaders { get; private set; } = new();

    public TallySimulator(int port = 0)
    {
        Port = port == 0 ? FindFreePort() : port;
        _listener = new HttpListener();
        _listener.Prefixes.Add($"http://127.0.0.1:{Port}/");
    }

    public void Start()
    {
        if (Fault == SimulatorFault.Down) return; // don't even start listening
        _listener.Start();
        _loop = Task.Run(ListenAsync);
    }

    public async Task StopAsync()
    {
        if (_cts.IsCancellationRequested) return;
        await _cts.CancelAsync();
        try { _listener.Stop(); } catch { }
        if (_loop is not null)
        {
            try { await _loop; }
            catch (OperationCanceledException) { }
            catch (HttpListenerException) { }
        }
    }

    public void Dispose()
    {
        try
        {
            if (!_cts.IsCancellationRequested)
            {
                _cts.Cancel();
            }
        }
        catch (ObjectDisposedException) { }

        try { _listener.Stop(); } catch { }
        try { _listener.Close(); } catch { }
        _cts.Dispose();
    }

    private async Task ListenAsync()
    {
        while (!_cts.IsCancellationRequested)
        {
            HttpListenerContext ctx;
            try
            {
                ctx = await _listener.GetContextAsync().WaitAsync(_cts.Token);
            }
            catch (Exception) when (_cts.IsCancellationRequested)
            {
                break;
            }
            catch (HttpListenerException)
            {
                break;
            }

            RequestCount++;

            using var reader = new StreamReader(ctx.Request.InputStream, ctx.Request.ContentEncoding);
            LastRequestBody = await reader.ReadToEndAsync();
            LastRequestHeaders = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (string? key in ctx.Request.Headers.AllKeys)
            {
                if (key is not null) LastRequestHeaders[key] = ctx.Request.Headers[key] ?? "";
            }

            if (Fault == SimulatorFault.Slow)
            {
                try { await Task.Delay(5000, _cts.Token); }
                catch (OperationCanceledException) { ctx.Response.Close(); continue; }
            }

            string responseJson;
            if (Fault == SimulatorFault.Malformed)
            {
                responseJson = "{{{{not json at all!!!!";
            }
            else if (Fault == SimulatorFault.WrongCompany)
            {
                responseJson = """{"status":"0","data":{"error":"Company not found"}}""";
            }
            else
            {
                var tallyRequest = LastRequestHeaders.GetValueOrDefault("tallyrequest", "");
                responseJson = tallyRequest.Equals("Import", StringComparison.OrdinalIgnoreCase)
                    ? ImportResponse
                    : GetExportResponse();
            }

            var bytes = Encoding.UTF8.GetBytes(responseJson);
            ctx.Response.ContentType = "application/json";
            ctx.Response.ContentLength64 = bytes.Length;
            ctx.Response.StatusCode = 200;
            try
            {
                await ctx.Response.OutputStream.WriteAsync(bytes, _cts.Token);
            }
            catch (OperationCanceledException) { }
            ctx.Response.Close();
        }
    }

    private string GetExportResponse()
    {
        var id = LastRequestHeaders.GetValueOrDefault("id", "");
        if (id.Equals("TSPLVoucherColl", StringComparison.OrdinalIgnoreCase))
            return VoucherResponse;
        return LedgerResponse;
    }

    private static int FindFreePort()
    {
        using var l = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        l.Start();
        var port = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return port;
    }

    // -- Default fixtures (minimal, from TALLY_INTEGRATION §8 samples) --

    public static readonly string DefaultLedgerResponse = """
    {
      "status": "1",
      "data": {
        "collection": [
          { "name": { "type": "String", "value": "Cash" }, "parent": { "type": "String", "value": "Cash-in-Hand" }, "closing balance": { "type": "Amount", "value": "50000.00" } },
          { "name": { "type": "String", "value": "Bank Account" }, "parent": { "type": "String", "value": "Bank Accounts" }, "closing balance": { "type": "Amount", "value": "150000.00" } },
          { "name": { "type": "String", "value": "Customer A" }, "parent": { "type": "String", "value": "Sundry Debtors" }, "closing balance": { "type": "Amount", "value": "25000.00" } }
        ]
      }
    }
    """;

    public static readonly string DefaultVoucherResponse = """
    {
      "status": "1",
      "data": {
        "collection": [
          {
            "metadata": {
              "type": "Voucher",
              "remoteid": "00000000-0000-4000-8000-000000000001-00000001",
              "vchkey": "00000000-0000-4000-8000-000000000001-0000b2b3:00000008",
              "vchtype": "Receipt",
              "objview": "Accounting Voucher View"
            },
            "date": { "type": "Date", "value": "20250401" },
            "guid": "00000000-0000-4000-8000-000000000001-00000001",
            "vouchertypename": "Receipt",
            "vouchernumber": "1",
            "isdeleted": false,
            "masterid": { "type": "Number", "value": " 1" },
            "amount": { "type": "Amount", "value": "1000.00" },
            "narration": "Test receipt [ERP:a1b2c3d4-e5f6-7890-abcd-ef1234567890]",
            "allledgerentries": [
              {
                "ledgername": { "type": "String", "value": "Customer A" },
                "isdeemedpositive": { "type": "Logical", "value": false },
                "amount": { "type": "Amount", "value": "1000.00" }
              },
              {
                "ledgername": { "type": "String", "value": "Bank Account" },
                "isdeemedpositive": { "type": "Logical", "value": true },
                "amount": { "type": "Amount", "value": "-1000.00" }
              }
            ]
          }
        ]
      }
    }
    """;

    public static readonly string DefaultImportResponse = """
    {
      "status": "1",
      "data": {
        "import_result": {
          "created": 1,
          "altered": 0,
          "deleted": 0,
          "lastvchid": 70,
          "lastmid": 0,
          "combined": 0,
          "ignored": 0,
          "errors": 0,
          "cancelled": 0,
          "exceptions": 0,
          "vchnumber": 2
        }
      }
    }
    """;
}

public enum SimulatorFault
{
    None,
    Down,
    Slow,
    WrongCompany,
    Malformed,
}
