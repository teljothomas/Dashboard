using TradeX.Agent.Core.Journal;

// Test helper for the journal crash test (TS-T13 precursor). Opens the journal, then writes post intents one by one and
// prints "ACK <n>" only after the write returned. The test kills this process abruptly and checks that every acknowledged
// row is present after reopening. Never shipped; lives under tests/.
if (args.Length != 1)
{
    Console.Error.WriteLine("usage: JournalKillHelper <journal-path>");
    return 1;
}

using var journal = AgentJournal.Open(args[0]);
for (var n = 1; ; n++)
{
    journal.RecordPostIntent($"outbox-{n}", 1, $"[ERP:{n}]", new string('a', 64));
    Console.WriteLine($"ACK {n}");
    Console.Out.Flush();
}
