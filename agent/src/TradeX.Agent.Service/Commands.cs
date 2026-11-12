using System.Runtime.Versioning;
using TradeX.Agent.Core.Cloud;
using TradeX.Agent.Core.Config;
using TradeX.Agent.Core.Journal;
using TradeX.Agent.Core.Registration;
using TradeX.Agent.Core.Runtime;
using TradeX.Agent.Core.Security;

namespace TradeX.Agent.Service;

/// <summary>Exit codes shared by the CLI commands and the service host.</summary>
public static class ExitCodes
{
    public const int Ok = 0;
    public const int Failed = 1;
    public const int NotConfigured = 2;
    public const int JournalCorrupt = 3;
}

[SupportedOSPlatform("windows")]
public static class Commands
{
    /// <summary><c>register &lt;code&gt; [--cloud &lt;url&gt;]</c>. Run once, elevated, on the Tally PC.</summary>
    public static async Task<int> RegisterAsync(string[] args, AgentPaths paths)
    {
        string? code = null;
        string? cloud = null;
        for (var i = 0; i < args.Length; i++)
        {
            if (args[i] == "--cloud" && i + 1 < args.Length) cloud = args[++i];
            else if (code is null) code = args[i];
            else
            {
                Console.Error.WriteLine("Usage: TradeXAgent.exe register <code> [--cloud <url>]");
                return ExitCodes.Failed;
            }
        }

        if (code is null)
        {
            Console.Error.WriteLine("Usage: TradeXAgent.exe register <code> [--cloud <url>]");
            return ExitCodes.Failed;
        }

        if (cloud is not null) Settings.WriteCloudBaseUrl(paths, cloud);

        var options = Settings.Load(paths);
        var problems = options.Validate();
        if (problems.Count > 0)
        {
            foreach (var problem in problems) Console.Error.WriteLine($"Configuration: {problem}");
            Console.Error.WriteLine($"Fix {paths.ConfigFile} or pass --cloud <url>.");
            return ExitCodes.NotConfigured;
        }

        var service = new RegistrationService(
            CloudClientFactory.CreateForRegistration(options, out var http),
            new DpapiKeyStore(paths.KeyFile),
            new FileIdentityStore(paths.IdentityFile),
            new WindowsMachineInfo(),
            options.CloudBaseUrl,
            AgentInfo.Version,
            TimeProvider.System);

        using (http)
        {
            try
            {
                var identity = await service.RegisterAsync(code, CancellationToken.None);
                Console.WriteLine($"Registered. Agent {identity.AgentId} for company '{identity.ExpectedCompany.TallyName}'.");
                Console.WriteLine("The private key is stored protected for this machine. Start the TradeXAgent service next.");
                return ExitCodes.Ok;
            }
            catch (RegistrationException ex)
            {
                Console.Error.WriteLine(ex.Message);
                return ExitCodes.Failed;
            }
            catch (CloudApiException ex)
            {
                Console.Error.WriteLine($"The cloud refused the registration: {ex.Code}. {ex.Message}");
                return ExitCodes.Failed;
            }
            catch (CloudUnavailableException ex)
            {
                Console.Error.WriteLine(ex.Message);
                return ExitCodes.Failed;
            }
        }
    }

    /// <summary><c>status</c>: lease, last heartbeat, journal counts, last error (read from identity.json and journal.db).</summary>
    public static int Status(AgentPaths paths)
    {
        AgentIdentity? identity;
        try
        {
            identity = new FileIdentityStore(paths.IdentityFile).Load();
        }
        catch (Exception ex) when (ex is IOException or System.Text.Json.JsonException)
        {
            Console.Error.WriteLine($"identity.json cannot be read: {ex.Message}");
            return ExitCodes.Failed;
        }

        if (!File.Exists(paths.JournalFile))
        {
            Console.Write(StatusFormatter.Format(new StatusSnapshot(
                identity, "NotRunning", null, null, null, null, null, null, null, null, null, new JournalCounts(0, 0, 0, 0, 0, 0))));
            return ExitCodes.Ok;
        }

        try
        {
            using var journal = AgentJournal.Open(paths.JournalFile);
            Console.Write(StatusFormatter.Format(StatusSnapshot.Read(identity, journal)));
            return ExitCodes.Ok;
        }
        catch (JournalCorruptException ex)
        {
            Console.Error.WriteLine(ex.Message);
            return ExitCodes.JournalCorrupt;
        }
    }
}
