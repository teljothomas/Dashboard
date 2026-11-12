using System.Reflection;

namespace TradeX.Agent.Service;

public static class AgentInfo
{
    public const string ServiceName = "TradeXAgent";

    public static string Version { get; } =
        typeof(AgentInfo).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion.Split('+')[0]
        ?? "0.0.0";
}
