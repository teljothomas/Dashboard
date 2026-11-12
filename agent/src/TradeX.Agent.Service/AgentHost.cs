using System.Runtime.Versioning;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Serilog;
using Serilog.Events;
using TradeX.Agent.Core.Cloud;
using TradeX.Agent.Core.Config;
using TradeX.Agent.Core.Journal;
using TradeX.Agent.Core.Registration;
using TradeX.Agent.Core.Runtime;
using TradeX.Agent.Core.Security;
using TradeX.Agent.Tally;
using TradeX.Agent.Tally.Import;

namespace TradeX.Agent.Service;

/// <summary>Builds and runs the agent as a console process or, under the Service Control Manager, a Windows Service.</summary>
[SupportedOSPlatform("windows")]
public static class AgentHost
{
    public static async Task<int> RunAsync(string[] args, AgentPaths paths)
    {
        var options = Settings.Load(paths);
        using var logger = CreateLogger(paths);

        var problems = options.Validate();
        if (problems.Count > 0)
        {
            foreach (var problem in problems) logger.Error("Configuration: {Problem}", problem);
            return ExitCodes.NotConfigured;
        }

        AgentIdentity? identity;
        try
        {
            identity = new FileIdentityStore(paths.IdentityFile).Load();
        }
        catch (Exception ex) when (ex is IOException or System.Text.Json.JsonException)
        {
            logger.Error(ex, "identity.json cannot be read.");
            return ExitCodes.NotConfigured;
        }

        if (identity is null)
        {
            logger.Error("This agent is not registered. Run: TradeXAgent.exe register <code>");
            return ExitCodes.NotConfigured;
        }

        AgentJournal journal;
        try
        {
            journal = AgentJournal.Open(paths.JournalFile); // integrity check on start
        }
        catch (JournalCorruptException ex)
        {
            logger.Fatal(ex, "The journal failed its integrity check. Not starting: pending posts cannot be trusted.");
            return ExitCodes.JournalCorrupt;
        }

        using (journal)
        {
            System.Security.Cryptography.ECDsa key;
            try
            {
                key = new DpapiKeyStore(paths.KeyFile).Load();
            }
            catch (KeyStoreException ex)
            {
                logger.Error(ex, "The agent private key cannot be loaded.");
                return ExitCodes.NotConfigured;
            }

            using (key)
            {
                var cloud = CloudClientFactory.CreateSigned(options, key, identity.AgentId, TimeProvider.System, out var http);
                using (http)
                {
                    var builder = Host.CreateApplicationBuilder(args);
                    builder.Services.AddWindowsService(o => o.ServiceName = AgentInfo.ServiceName);
                    builder.Services.AddSerilog(logger, dispose: false);
                    builder.Services.Configure<HostOptions>(o => o.ShutdownTimeout = TimeSpan.FromSeconds(30));
                    builder.Services.AddSingleton(options);
                    builder.Services.AddSingleton(identity);
                    builder.Services.AddSingleton(journal);
                    builder.Services.AddSingleton<ICloudClient>(cloud);
                    builder.Services.AddSingleton(TimeProvider.System);
                    builder.Services.AddSingleton(sp =>
                    {
                        var tallyLog = sp.GetRequiredService<ILoggerFactory>().CreateLogger<TallyClient>();
                        return new TallyClient(options, identity.ExpectedCompany.TallyName, tallyLog);
                    });
                    builder.Services.AddSingleton<ITallyProbe>(sp => sp.GetRequiredService<TallyClient>());
                    builder.Services.AddSingleton<ITallyReader>(sp => sp.GetRequiredService<TallyClient>());
                    builder.Services.AddSingleton<IAgentWork>(sp => new ImportWork(
                        sp.GetRequiredService<ICloudClient>(),
                        sp.GetRequiredService<ITallyReader>(),
                        options,
                        Path.Combine(paths.Root, "import"),
                        sp.GetRequiredService<TimeProvider>(),
                        sp.GetRequiredService<ILoggerFactory>().CreateLogger<ImportWork>()));
                    builder.Services.AddSingleton<AgentRuntime>();
                    builder.Services.AddHostedService<AgentWorker>();

                    using var host = builder.Build();
                    logger.Information("TradeX agent {Version} starting for agent {AgentId}.", AgentInfo.Version, identity.AgentId);
                    await host.RunAsync();
                    logger.Information("TradeX agent stopped.");
                    return ExitCodes.Ok;
                }
            }
        }
    }

    /// <summary>Rolling files (7 days) plus Windows Event Log for errors. No secrets are ever logged.</summary>
    private static Serilog.Core.Logger CreateLogger(AgentPaths paths)
    {
        var configuration = new LoggerConfiguration()
            .MinimumLevel.Information()
            .MinimumLevel.Override("Microsoft", LogEventLevel.Warning)
            .Enrich.WithProperty("Agent", AgentInfo.ServiceName)
            .WriteTo.File(
                Path.Combine(paths.LogDirectory, "agent-.log"),
                rollingInterval: RollingInterval.Day,
                retainedFileCountLimit: 7,
                outputTemplate: "{Timestamp:yyyy-MM-dd HH:mm:ss.fff zzz} [{Level:u3}] {Message:lj}{NewLine}{Exception}");

        configuration.WriteTo.EventLog(
            source: AgentInfo.ServiceName,
            logName: "Application",
            manageEventSource: false, // the install script creates the source (needs admin)
            restrictedToMinimumLevel: LogEventLevel.Error);

        return configuration.CreateLogger();
    }
}

/// <summary>Hosts <see cref="AgentRuntime"/>. Stopping the host cancels the runtime, which releases the lease.</summary>
public sealed class AgentWorker(AgentRuntime runtime, ILogger<AgentWorker> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await runtime.RunAsync(stoppingToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            log.LogCritical(ex, "The agent loop crashed. The service will exit so the recovery policy restarts it.");
            Environment.ExitCode = ExitCodes.Failed;
            throw;
        }
    }
}
