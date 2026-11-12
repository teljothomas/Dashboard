using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Configuration;
using TradeX.Agent.Core.Config;

namespace TradeX.Agent.Service;

/// <summary>Loads <see cref="AgentOptions"/> from <c>appsettings.json</c> plus <c>TRADEX_AGENT__</c> environment variables.</summary>
public static class Settings
{
    public static AgentOptions Load(AgentPaths paths)
    {
        var configuration = new ConfigurationBuilder()
            .AddJsonFile(paths.ConfigFile, optional: true, reloadOnChange: false)
            .AddEnvironmentVariables("TRADEX_AGENT__")
            .Build();

        var options = new AgentOptions();
        configuration.GetSection(AgentOptions.SectionName).Bind(options);

        // Environment variables use the prefix without the section name: TRADEX_AGENT__CloudBaseUrl.
        configuration.Bind(options);
        return options;
    }

    /// <summary>Records the cloud URL in appsettings.json (creates the file, keeps every other setting).</summary>
    public static void WriteCloudBaseUrl(AgentPaths paths, string cloudBaseUrl)
    {
        Directory.CreateDirectory(paths.Root);
        var root = File.Exists(paths.ConfigFile)
            ? JsonNode.Parse(File.ReadAllText(paths.ConfigFile)) as JsonObject ?? new JsonObject()
            : new JsonObject();

        var section = root[AgentOptions.SectionName] as JsonObject ?? new JsonObject();
        section["CloudBaseUrl"] = cloudBaseUrl;
        root[AgentOptions.SectionName] = section;

        var temp = paths.ConfigFile + ".tmp";
        File.WriteAllText(temp, root.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        File.Move(temp, paths.ConfigFile, overwrite: true);
    }
}
