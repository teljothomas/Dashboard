using System.Net;

namespace TradeX.Agent.Core.Config;

/// <summary>
/// Agent configuration (<c>%ProgramData%\TradeXAgent\appsettings.json</c>). Holds no secrets
/// (SECURITY section 6): the only secret the agent owns is its private key.
/// </summary>
public sealed class AgentOptions
{
    public const string SectionName = "Agent";

    /// <summary>Origin of the cloud API, for example <c>https://erp.example.com</c>. No path.</summary>
    public string CloudBaseUrl { get; set; } = "";

    /// <summary>Tally HTTP host. Must be loopback (SECURITY section 1, agent refuses anything else).</summary>
    public string TallyHost { get; set; } = "127.0.0.1";

    public int TallyPort { get; set; } = 9000;

    /// <summary>Idle main loop period (TALLY_INTEGRATION section 6: 60 s).</summary>
    public int MainLoopSeconds { get; set; } = 60;

    /// <summary>Heartbeat period on its own timer (30 s; the lease lives 90 s).</summary>
    public int HeartbeatSeconds { get; set; } = 30;

    /// <summary>Minimum time between import cycles (masters, vouchers, balances). Commands and a restart run one at once.</summary>
    public int ImportIntervalSeconds { get; set; } = 300;

    /// <summary>
    /// First month (1-12) of the financial year, used only to size the FULL_RECON window. 4 = April (Indian FY).
    /// The cloud also holds <c>fy_start_month</c>; the agent identity does not carry it yet, so it is set here.
    /// </summary>
    public int FinancialYearStartMonth { get; set; } = 4;

    public int HttpTimeoutSeconds { get; set; } = 30;

    public int MaxRetries { get; set; } = 4;

    /// <summary>Base delay of the exponential retry backoff.</summary>
    public int RetryBaseMilliseconds { get; set; } = 500;

    /// <summary>Returns the list of problems with this configuration (empty when valid).</summary>
    public IReadOnlyList<string> Validate()
    {
        var problems = new List<string>();

        if (!Uri.TryCreate(CloudBaseUrl, UriKind.Absolute, out var cloud))
        {
            problems.Add("CloudBaseUrl must be an absolute URL.");
        }
        else
        {
            var loopbackCloud = cloud.IsLoopback;
            if (cloud.Scheme != Uri.UriSchemeHttps && !(loopbackCloud && cloud.Scheme == Uri.UriSchemeHttp))
            {
                problems.Add("CloudBaseUrl must use https (http only for a loopback development server).");
            }

            if (cloud.AbsolutePath != "/" || !string.IsNullOrEmpty(cloud.Query) || !string.IsNullOrEmpty(cloud.UserInfo))
            {
                problems.Add("CloudBaseUrl must be an origin only (no path, query or credentials).");
            }
        }

        if (!IsLoopbackHost(TallyHost))
        {
            problems.Add("TallyHost must be a loopback address (127.0.0.1, ::1 or localhost).");
        }

        if (TallyPort is < 1 or > 65535) problems.Add("TallyPort must be 1-65535.");
        if (MainLoopSeconds is < 5 or > 3600) problems.Add("MainLoopSeconds must be 5-3600.");
        if (HeartbeatSeconds is < 5 or > 30) problems.Add("HeartbeatSeconds must be 5-30 (lease lives 90 s; a third leaves room for two missed beats).");
        if (ImportIntervalSeconds is < 30 or > 86_400) problems.Add("ImportIntervalSeconds must be 30-86400.");
        if (FinancialYearStartMonth is < 1 or > 12) problems.Add("FinancialYearStartMonth must be 1-12.");
        if (HttpTimeoutSeconds is < 5 or > 300) problems.Add("HttpTimeoutSeconds must be 5-300.");
        if (MaxRetries is < 0 or > 10) problems.Add("MaxRetries must be 0-10.");
        if (RetryBaseMilliseconds is < 10 or > 60_000) problems.Add("RetryBaseMilliseconds must be 10-60000.");

        return problems;
    }

    /// <summary>True only for 127.0.0.0/8, ::1 and the name localhost.</summary>
    public static bool IsLoopbackHost(string host)
    {
        if (string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase)) return true;
        return IPAddress.TryParse(host, out var ip) && IPAddress.IsLoopback(ip);
    }
}
