using System.Text.Json;
using TradeX.Agent.Core.Cloud;

namespace TradeX.Agent.Core.Registration;

/// <summary>Non-secret facts returned by registration, stored in <c>identity.json</c>.</summary>
public sealed record AgentIdentity(
    string AgentId,
    string CompanyId,
    ExpectedCompany ExpectedCompany,
    string CloudBaseUrl,
    DateTimeOffset RegisteredAt);

public interface IIdentityStore
{
    bool Exists { get; }
    AgentIdentity? Load();
    void Save(AgentIdentity identity);
}

public sealed class FileIdentityStore(string path) : IIdentityStore
{
    public bool Exists => File.Exists(path);

    public AgentIdentity? Load()
    {
        if (!Exists) return null;
        return JsonSerializer.Deserialize<AgentIdentity>(File.ReadAllText(path), CloudClient.Json);
    }

    public void Save(AgentIdentity identity)
    {
        var directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
        var temp = path + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(identity, CloudClient.Json));
        File.Move(temp, path, overwrite: true);
    }
}
