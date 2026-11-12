using TradeX.Agent.Core.Journal;
using System.Globalization;
using System.Text;
using TradeX.Agent.Core.Registration;

namespace TradeX.Agent.Core.Runtime;

public sealed record StatusSnapshot(
    AgentIdentity? Identity,
    string State,
    long? LeaseEpoch,
    string? LeaseExpiresAt,
    string? LastHeartbeatAt,
    bool? LastHeartbeatOk,
    bool? TallyReachable,
    string? TallyVersion,
    string? PostingMode,
    string? LastError,
    string? UpdatedAt,
    JournalCounts Counts)
{
    /// <summary>Builds a snapshot from the identity file and the journal (what the running service mirrored there).</summary>
    public static StatusSnapshot Read(AgentIdentity? identity, AgentJournal journal)
    {
        static bool? Flag(string? value) => value switch { "true" => true, "false" => false, _ => null };

        var epoch = journal.GetValue(StatusKeys.LeaseEpoch);
        var version = journal.GetValue(StatusKeys.TallyVersion);
        return new StatusSnapshot(
            identity,
            journal.GetValue(StatusKeys.State) ?? "NotRunning",
            long.TryParse(epoch, NumberStyles.None, CultureInfo.InvariantCulture, out var e) ? e : null,
            journal.GetValue(StatusKeys.LeaseExpiresAt),
            journal.GetValue(StatusKeys.LastHeartbeatAt),
            Flag(journal.GetValue(StatusKeys.LastHeartbeatOk)),
            Flag(journal.GetValue(StatusKeys.TallyReachable)),
            string.IsNullOrEmpty(version) ? null : version,
            journal.GetValue(StatusKeys.PostingMode),
            journal.GetValue(StatusKeys.LastError),
            journal.GetValue(StatusKeys.UpdatedAt),
            journal.Counts());
    }
}

/// <summary>Plain text for <c>TradeXAgent.exe status</c>: lease, last heartbeat, journal counts, last error.</summary>
public static class StatusFormatter
{
    public static string Format(StatusSnapshot s)
    {
        static string Or(string? value, string fallback = "-") => string.IsNullOrEmpty(value) ? fallback : value;
        static string YesNo(bool? value) => value switch { true => "yes", false => "no", null => "unknown" };

        var text = new StringBuilder();
        text.AppendLine("TradeX Tally agent");
        text.AppendLine(s.Identity is null
            ? "  Registered:       no (run: TradeXAgent.exe register <code>)"
            : $"  Registered:       yes, agent {s.Identity.AgentId}, company {s.Identity.CompanyId}");
        if (s.Identity is not null)
        {
            text.AppendLine($"  Expected company: {s.Identity.ExpectedCompany.TallyName} (books from {s.Identity.ExpectedCompany.BooksFrom})");
            text.AppendLine($"  Cloud:            {s.Identity.CloudBaseUrl}");
        }

        text.AppendLine($"  State:            {s.State} (as of {Or(s.UpdatedAt)})");
        text.AppendLine(s.LeaseEpoch is null
            ? "  Lease:            not held"
            : $"  Lease:            epoch {s.LeaseEpoch}, server expiry {Or(s.LeaseExpiresAt)}");
        text.AppendLine($"  Last heartbeat:   {Or(s.LastHeartbeatAt, "never")} (ok: {YesNo(s.LastHeartbeatOk)})");
        text.AppendLine($"  Tally:            reachable {YesNo(s.TallyReachable)}, version {Or(s.TallyVersion, "unknown")}");
        text.AppendLine($"  Posting mode:     {Or(s.PostingMode, "DISABLED")}");
        text.AppendLine(
            $"  Journal:          pending {s.Counts.Pending} (post intent {s.Counts.PostIntent}, sent {s.Counts.PostSent}, " +
            $"responded {s.Counts.PostResponded}, import prepared {s.Counts.ImportPrepared}); " +
            $"reported {s.Counts.PostReported}, import acked {s.Counts.ImportAcked}");
        text.AppendLine($"  Last error:       {Or(s.LastError, "none")}");
        return text.ToString();
    }
}
