// TallySimulator standalone entry point (for manual testing, not used in xUnit tests).
using TradeX.Agent.Tools;

var port = args.Length > 0 && int.TryParse(args[0], out var p) ? p : 9000;
Console.WriteLine($"TallySimulator starting on http://127.0.0.1:{port}/ ...");

using var sim = new TallySimulator(port);
sim.Start();

Console.WriteLine("Listening. Press Ctrl+C to stop.");
var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };
try { await Task.Delay(Timeout.Infinite, cts.Token); }
catch (OperationCanceledException) { }

await sim.StopAsync();
Console.WriteLine($"Stopped after {sim.RequestCount} requests.");

