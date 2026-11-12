using System.Globalization;
using Microsoft.Data.Sqlite;

namespace TradeX.Agent.Core.Journal;

public sealed class JournalCorruptException(string message, Exception? inner = null) : Exception(message, inner);

public enum PostState
{
    Intent = 0,
    Sent = 1,
    Responded = 2,
    Reported = 3,
}

public enum ImportState
{
    Prepared,
    Acked,
}

public sealed record PostJournalRow(string OutboxId, int AttemptNo, string Marker, string PayloadSha256, PostState State, string? TallyResponse);

public sealed record ImportJournalRow(string BatchId, string Stream, long? FromAlter, long? ToAlter, ImportState State, string? PayloadPath);

public sealed record JournalCounts(int PostIntent, int PostSent, int PostResponded, int PostReported, int ImportPrepared, int ImportAcked)
{
    /// <summary>Rows that still need recovery or acknowledgement (TALLY_INTEGRATION section 6 step 4).</summary>
    public int Pending => PostIntent + PostSent + PostResponded + ImportPrepared;
}

/// <summary>
/// Local SQLite journal <c>journal.db</c> (TALLY_INTEGRATION section 6): WAL, <c>synchronous=FULL</c>, integrity check on
/// open. Every write is one auto-committed statement, so a process kill leaves either the old or the new row, never a
/// partial one. Post states only move forward: INTENT, SENT, RESPONDED, REPORTED. The row is written before Tally is
/// contacted; after a crash any row not REPORTED goes through the verification flow before new work (section 7).
/// </summary>
public sealed class AgentJournal : IDisposable
{
    private const int SchemaVersion = 1;

    private readonly SqliteConnection _connection;
    private readonly TimeProvider _clock;
    private readonly object _gate = new();

    private AgentJournal(SqliteConnection connection, TimeProvider clock)
    {
        _connection = connection;
        _clock = clock;
    }

    /// <summary>Opens or creates the journal. Throws <see cref="JournalCorruptException"/> if the integrity check fails.</summary>
    public static AgentJournal Open(string path, TimeProvider? clock = null)
    {
        var directory = Path.GetDirectoryName(Path.GetFullPath(path));
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);

        var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = path,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Pooling = false,
        }.ToString());

        try
        {
            connection.Open();
            Execute(connection, "PRAGMA journal_mode=WAL;");
            Execute(connection, "PRAGMA synchronous=FULL;");
            Execute(connection, "PRAGMA foreign_keys=ON;");
            CheckIntegrity(connection);
            Migrate(connection);
            return new AgentJournal(connection, clock ?? TimeProvider.System);
        }
        catch (SqliteException ex)
        {
            connection.Dispose();
            throw new JournalCorruptException($"The journal cannot be opened: {ex.Message}", ex);
        }
        catch
        {
            connection.Dispose();
            throw;
        }
    }

    // ----- posting (used from Phase 11; the recovery contract is verified here) ---------------------------------

    public void RecordPostIntent(string outboxId, int attemptNo, string marker, string payloadSha256)
    {
        var now = Now();
        Run(
            """
            INSERT INTO post_journal(outbox_id, attempt_no, marker, payload_sha256, state, tally_response, created_at, updated_at)
            VALUES($id, $attempt, $marker, $sha, 'INTENT', NULL, $now, $now)
            """,
            ("$id", outboxId), ("$attempt", attemptNo), ("$marker", marker), ("$sha", payloadSha256), ("$now", now));
    }

    /// <summary>Moves a post row forward. Backward or repeated moves are rejected (the journal is the recovery record).</summary>
    public void AdvancePost(string outboxId, int attemptNo, PostState next, string? tallyResponse = null)
    {
        lock (_gate)
        {
            var current = GetPostUnlocked(outboxId, attemptNo)
                ?? throw new InvalidOperationException($"No journal row for {outboxId} attempt {attemptNo}.");
            if (next <= current.State)
            {
                throw new InvalidOperationException($"Journal state cannot move from {current.State} to {next}.");
            }

            RunUnlocked(
                "UPDATE post_journal SET state=$state, tally_response=COALESCE($resp, tally_response), updated_at=$now WHERE outbox_id=$id AND attempt_no=$attempt",
                ("$state", ToDb(next)), ("$resp", tallyResponse), ("$now", Now()), ("$id", outboxId), ("$attempt", attemptNo));
        }
    }

    public PostJournalRow? GetPost(string outboxId, int attemptNo)
    {
        lock (_gate) return GetPostUnlocked(outboxId, attemptNo);
    }

    /// <summary>Rows not yet acknowledged by the cloud: these need the verification flow after a restart.</summary>
    public IReadOnlyList<PostJournalRow> PendingPosts()
    {
        lock (_gate)
        {
            using var command = _connection.CreateCommand();
            command.CommandText =
                "SELECT outbox_id, attempt_no, marker, payload_sha256, state, tally_response FROM post_journal WHERE state <> 'REPORTED' ORDER BY created_at, outbox_id, attempt_no";
            return ReadPosts(command);
        }
    }

    // ----- import (resend after network loss) -------------------------------------------------------------------

    public void BeginImport(string batchId, string stream, long? fromAlter, long? toAlter, string? payloadPath)
    {
        var now = Now();
        Run(
            """
            INSERT INTO import_journal(batch_id, stream, from_alter, to_alter, state, payload_path, created_at, updated_at)
            VALUES($id, $stream, $from, $to, 'PREPARED', $path, $now, $now)
            """,
            ("$id", batchId), ("$stream", stream), ("$from", fromAlter), ("$to", toAlter), ("$path", payloadPath), ("$now", now));
    }

    public void AckImport(string batchId) =>
        Run("UPDATE import_journal SET state='ACKED', updated_at=$now WHERE batch_id=$id", ("$now", Now()), ("$id", batchId));

    public IReadOnlyList<ImportJournalRow> PendingImports()
    {
        lock (_gate)
        {
            using var command = _connection.CreateCommand();
            command.CommandText =
                "SELECT batch_id, stream, from_alter, to_alter, state, payload_path FROM import_journal WHERE state <> 'ACKED' ORDER BY created_at, batch_id";
            using var reader = command.ExecuteReader();
            var rows = new List<ImportJournalRow>();
            while (reader.Read())
            {
                rows.Add(new ImportJournalRow(
                    reader.GetString(0),
                    reader.GetString(1),
                    reader.IsDBNull(2) ? null : reader.GetInt64(2),
                    reader.IsDBNull(3) ? null : reader.GetInt64(3),
                    reader.GetString(4) == "ACKED" ? ImportState.Acked : ImportState.Prepared,
                    reader.IsDBNull(5) ? null : reader.GetString(5)));
            }

            return rows;
        }
    }

    // ----- key/value (config hash, last company fingerprint, last status values) --------------------------------

    public string? GetValue(string key)
    {
        lock (_gate)
        {
            using var command = _connection.CreateCommand();
            command.CommandText = "SELECT value FROM kv WHERE key=$key";
            command.Parameters.AddWithValue("$key", key);
            return command.ExecuteScalar() as string;
        }
    }

    public void SetValue(string key, string value) =>
        Run("INSERT INTO kv(key, value) VALUES($key, $value) ON CONFLICT(key) DO UPDATE SET value=excluded.value", ("$key", key), ("$value", value));

    public void RemoveValue(string key) => Run("DELETE FROM kv WHERE key=$key", ("$key", key));

    // ----- counts ------------------------------------------------------------------------------------------------

    public JournalCounts Counts()
    {
        lock (_gate)
        {
            int Count(string sql)
            {
                using var command = _connection.CreateCommand();
                command.CommandText = sql;
                return Convert.ToInt32(command.ExecuteScalar(), CultureInfo.InvariantCulture);
            }

            return new JournalCounts(
                Count("SELECT COUNT(*) FROM post_journal WHERE state='INTENT'"),
                Count("SELECT COUNT(*) FROM post_journal WHERE state='SENT'"),
                Count("SELECT COUNT(*) FROM post_journal WHERE state='RESPONDED'"),
                Count("SELECT COUNT(*) FROM post_journal WHERE state='REPORTED'"),
                Count("SELECT COUNT(*) FROM import_journal WHERE state='PREPARED'"),
                Count("SELECT COUNT(*) FROM import_journal WHERE state='ACKED'"));
        }
    }

    public void Dispose()
    {
        lock (_gate) _connection.Dispose();
    }

    // ----- internals ---------------------------------------------------------------------------------------------

    private string Now() => _clock.GetUtcNow().ToString("O", CultureInfo.InvariantCulture);

    private static string ToDb(PostState state) => state switch
    {
        PostState.Intent => "INTENT",
        PostState.Sent => "SENT",
        PostState.Responded => "RESPONDED",
        PostState.Reported => "REPORTED",
        _ => throw new ArgumentOutOfRangeException(nameof(state)),
    };

    private static PostState FromDb(string value) => value switch
    {
        "INTENT" => PostState.Intent,
        "SENT" => PostState.Sent,
        "RESPONDED" => PostState.Responded,
        "REPORTED" => PostState.Reported,
        _ => throw new JournalCorruptException($"Unknown journal state '{value}'."),
    };

    private PostJournalRow? GetPostUnlocked(string outboxId, int attemptNo)
    {
        using var command = _connection.CreateCommand();
        command.CommandText =
            "SELECT outbox_id, attempt_no, marker, payload_sha256, state, tally_response FROM post_journal WHERE outbox_id=$id AND attempt_no=$attempt";
        command.Parameters.AddWithValue("$id", outboxId);
        command.Parameters.AddWithValue("$attempt", attemptNo);
        return ReadPosts(command).FirstOrDefault();
    }

    private static List<PostJournalRow> ReadPosts(SqliteCommand command)
    {
        using var reader = command.ExecuteReader();
        var rows = new List<PostJournalRow>();
        while (reader.Read())
        {
            rows.Add(new PostJournalRow(
                reader.GetString(0),
                reader.GetInt32(1),
                reader.GetString(2),
                reader.GetString(3),
                FromDb(reader.GetString(4)),
                reader.IsDBNull(5) ? null : reader.GetString(5)));
        }

        return rows;
    }

    private void Run(string sql, params (string Name, object? Value)[] parameters)
    {
        lock (_gate) RunUnlocked(sql, parameters);
    }

    private void RunUnlocked(string sql, params (string Name, object? Value)[] parameters)
    {
        using var command = _connection.CreateCommand();
        command.CommandText = sql;
        foreach (var (name, value) in parameters) command.Parameters.AddWithValue(name, value ?? DBNull.Value);
        command.ExecuteNonQuery();
    }

    private static void Execute(SqliteConnection connection, string sql)
    {
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.ExecuteNonQuery();
    }

    private static void CheckIntegrity(SqliteConnection connection)
    {
        using var command = connection.CreateCommand();
        command.CommandText = "PRAGMA integrity_check;";
        var result = command.ExecuteScalar() as string;
        if (!string.Equals(result, "ok", StringComparison.OrdinalIgnoreCase))
        {
            throw new JournalCorruptException($"Journal integrity check failed: {result}");
        }
    }

    private static void Migrate(SqliteConnection connection)
    {
        using var versionCommand = connection.CreateCommand();
        versionCommand.CommandText = "PRAGMA user_version;";
        var version = Convert.ToInt32(versionCommand.ExecuteScalar(), CultureInfo.InvariantCulture);

        if (version > SchemaVersion)
        {
            throw new JournalCorruptException($"Journal schema version {version} is newer than this agent supports ({SchemaVersion}).");
        }

        if (version == SchemaVersion) return;

        using var transaction = connection.BeginTransaction();
        Execute(connection,
            """
            CREATE TABLE IF NOT EXISTS post_journal(
              outbox_id      TEXT    NOT NULL,
              attempt_no     INTEGER NOT NULL,
              marker         TEXT    NOT NULL,
              payload_sha256 TEXT    NOT NULL,
              state          TEXT    NOT NULL CHECK (state IN ('INTENT','SENT','RESPONDED','REPORTED')),
              tally_response TEXT,
              created_at     TEXT    NOT NULL,
              updated_at     TEXT    NOT NULL,
              PRIMARY KEY (outbox_id, attempt_no)
            );
            CREATE INDEX IF NOT EXISTS post_journal_state ON post_journal(state);
            CREATE TABLE IF NOT EXISTS import_journal(
              batch_id     TEXT PRIMARY KEY,
              stream       TEXT NOT NULL,
              from_alter   INTEGER,
              to_alter     INTEGER,
              state        TEXT NOT NULL CHECK (state IN ('PREPARED','ACKED')),
              payload_path TEXT,
              created_at   TEXT NOT NULL,
              updated_at   TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS kv(
              key   TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            """);
        Execute(connection, $"PRAGMA user_version={SchemaVersion};");
        transaction.Commit();
    }
}
