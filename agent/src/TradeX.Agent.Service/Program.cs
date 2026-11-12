using TradeX.Agent.Core.Config;
using TradeX.Agent.Service;

// TradeXAgent.exe [run | register <code> [--cloud <url>] | status | version]
// With no arguments (or `run`) the process is the agent; under the Service Control Manager it runs as a Windows Service.

var args0 = args.Length == 0 ? "run" : args[0].ToLowerInvariant();
var paths = AgentPaths.Default();

switch (args0)
{
    case "register":
        return await Commands.RegisterAsync(args.Skip(1).ToArray(), paths);
    case "status":
        return Commands.Status(paths);
    case "version":
        Console.WriteLine(AgentInfo.Version);
        return 0;
    case "run":
        return await AgentHost.RunAsync(args.Skip(1).ToArray(), paths);
    default:
        Console.Error.WriteLine("Usage: TradeXAgent.exe [run | register <code> [--cloud <url>] | status | version]");
        return 1;
}
