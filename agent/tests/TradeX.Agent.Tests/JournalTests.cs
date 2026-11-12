using System.Diagnostics;
using Microsoft.Data.Sqlite;
using TradeX.Agent.Core.Journal;
using Xunit;

namespace TradeX.Agent.Tests;

public sealed class JournalTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "tradex-agent-tests-" + Guid.NewGuid().ToString("N"));
    private string Db => Path.Combine(_dir, "journal.db");

    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
    }

    private static string Pragma(string path, string pragma)
    {
        // A pragma such as synchronous is per connection, so the journal's own settings are checked through its behaviour
        // below; journal_mode is stored in the file and can be read from any connection.
        using var connection = new SqliteConnection($"Data Source={path};Pooling=False");
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = $"PRAGMA {pragma};";
        return Convert.ToString(command.ExecuteScalar(), System.Globalization.CultureInfo.InvariantCulture)!;
    }

    [Fact]
    public void Creates_the_schema_in_wal_mode_and_reopens_cleanly()
    {
        using (var journal = AgentJournal.Open(Db))
        {
            Assert.Equal(0, journal.Counts().Pending);
        }

        Assert.Equal("wal", Pragma(Db, "journal_mode"), ignoreCase: true);
        Assert.Equal("1", Pragma(Db, "user_version"));
        using var again = AgentJournal.Open(Db);
        Assert.Equal(0, again.Counts().Pending);
    }

    [Fact]
    public void Post_states_only_move_forward_and_pending_excludes_reported()
    {
        using var journal = AgentJournal.Open(Db);
        journal.RecordPostIntent("o1", 1, "[ERP:1]", new string('a', 64));
        Assert.Equal(PostState.Intent, journal.GetPost("o1", 1)!.State);

        journal.AdvancePost("o1", 1, PostState.Sent);
        journal.AdvancePost("o1", 1, PostState.Responded, "<RESPONSE/>");
        Assert.Equal("<RESPONSE/>", journal.GetPost("o1", 1)!.TallyResponse);
        Assert.Single(journal.PendingPosts());

        Assert.Throws<InvalidOperationException>(() => journal.AdvancePost("o1", 1, PostState.Sent));
        Assert.Throws<InvalidOperationException>(() => journal.AdvancePost("o1", 1, PostState.Responded));

        journal.AdvancePost("o1", 1, PostState.Reported);
        Assert.Empty(journal.PendingPosts());
        Assert.Equal(1, journal.Counts().PostReported);
    }

    [Fact]
    public void The_same_attempt_cannot_be_recorded_twice()
    {
        using var journal = AgentJournal.Open(Db);
        journal.RecordPostIntent("o1", 1, "[ERP:1]", new string('a', 64));
        Assert.Throws<SqliteException>(() => journal.RecordPostIntent("o1", 1, "[ERP:1]", new string('a', 64)));
        journal.RecordPostIntent("o1", 2, "[ERP:1]", new string('a', 64));
        Assert.Equal(2, journal.Counts().PostIntent);
    }

    [Fact]
    public void Imports_are_pending_until_acknowledged()
    {
        using var journal = AgentJournal.Open(Db);
        journal.BeginImport("b1", "VOUCHERS", null, null, @"C:\ProgramData\TradeXAgent\spool\b1.json");

        var pending = journal.PendingImports().Single();
        Assert.Equal("b1", pending.BatchId);
        Assert.Null(pending.FromAlter);
        Assert.Equal(1, journal.Counts().Pending);

        journal.AckImport("b1");
        Assert.Empty(journal.PendingImports());
        Assert.Equal(1, journal.Counts().ImportAcked);
    }

    [Fact]
    public void Key_value_set_get_overwrite_remove()
    {
        using var journal = AgentJournal.Open(Db);
        Assert.Null(journal.GetValue("k"));
        journal.SetValue("k", "1");
        journal.SetValue("k", "2");
        Assert.Equal("2", journal.GetValue("k"));
        journal.RemoveValue("k");
        Assert.Null(journal.GetValue("k"));
    }

    [Fact]
    public void A_file_that_is_not_a_database_fails_the_start_with_a_corrupt_error()
    {
        Directory.CreateDirectory(_dir);
        File.WriteAllBytes(Db, new byte[8192].Select((_, i) => (byte)(i * 31 + 7)).ToArray());

        Assert.Throws<JournalCorruptException>(() => AgentJournal.Open(Db));
    }

    [Fact]
    public void A_newer_schema_version_is_refused()
    {
        using (var journal = AgentJournal.Open(Db)) journal.SetValue("a", "b");
        using (var connection = new SqliteConnection($"Data Source={Db};Pooling=False"))
        {
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = "PRAGMA user_version=99;";
            command.ExecuteNonQuery();
        }

        Assert.Throws<JournalCorruptException>(() => AgentJournal.Open(Db));
    }

    /// <summary>
    /// TS-T13 precursor: a helper process writes post intents and is killed abruptly (no shutdown code runs). Every row the
    /// helper had acknowledged must be readable afterwards and the integrity check must still pass.
    /// </summary>
    [Fact]
    public async Task Journal_survives_an_abrupt_process_kill()
    {
        Directory.CreateDirectory(_dir);
        var helper = Path.Combine(AppContext.BaseDirectory, "TradeX.Agent.JournalKillHelper.exe");
        Assert.True(File.Exists(helper), $"helper not found at {helper}");

        var start = new ProcessStartInfo(helper, $"\"{Db}\"") { RedirectStandardOutput = true, UseShellExecute = false };
        using var process = Process.Start(start)!;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(60));

        var acknowledged = 0;
        while (acknowledged < 40)
        {
            var line = await process.StandardOutput.ReadLineAsync(timeout.Token);
            Assert.NotNull(line);
            if (line.StartsWith("ACK ", StringComparison.Ordinal)) acknowledged = int.Parse(line[4..], System.Globalization.CultureInfo.InvariantCulture);
        }

        process.Kill(entireProcessTree: true);
        await process.WaitForExitAsync(timeout.Token);

        using var journal = AgentJournal.Open(Db); // runs the integrity check
        var rows = journal.PendingPosts().Select(r => r.OutboxId).ToHashSet();
        for (var n = 1; n <= acknowledged; n++) Assert.Contains($"outbox-{n}", rows);
        Assert.All(journal.PendingPosts(), r => Assert.Equal(PostState.Intent, r.State));
    }
}
