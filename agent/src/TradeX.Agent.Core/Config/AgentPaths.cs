namespace TradeX.Agent.Core.Config;

/// <summary>File locations under <c>%ProgramData%\TradeXAgent\</c> (TALLY_INTEGRATION section 6).</summary>
public sealed class AgentPaths
{
    public AgentPaths(string root)
    {
        Root = root;
    }

    public string Root { get; }
    public string ConfigFile => Path.Combine(Root, "appsettings.json");

    /// <summary>DPAPI (LocalMachine) protected PKCS#8 private key. The only secret.</summary>
    public string KeyFile => Path.Combine(Root, "agent.key");

    /// <summary>Non-secret identity returned by registration (agent id, company, expected Tally company).</summary>
    public string IdentityFile => Path.Combine(Root, "identity.json");

    public string JournalFile => Path.Combine(Root, "journal.db");
    public string LogDirectory => Path.Combine(Root, "logs");

    public static AgentPaths Default()
    {
        var overrideRoot = Environment.GetEnvironmentVariable("TRADEX_AGENT_HOME");
        if (!string.IsNullOrWhiteSpace(overrideRoot)) return new AgentPaths(overrideRoot);
        return new AgentPaths(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "TradeXAgent"));
    }
}
