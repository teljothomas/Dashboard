using System.Globalization;
using System.Text.Json;

namespace TradeX.Agent.Tally;

/// <summary>Parsed Tally ledger (master) from a collection export.</summary>
public sealed record TallyLedger(string Name, string Parent, decimal ClosingBalance, string? Guid = null, decimal? OpeningBalance = null);

/// <summary>Master kinds the agent imports (contracts <c>MasterRecord.kind</c>).</summary>
public enum TallyMasterKind
{
    Group,
    Ledger,
    StockItem,
    Unit,
    VoucherType,
    CostCentre,
}

/// <summary>One master from a collection export. Only the fields that exist for its kind are filled.</summary>
public sealed record TallyMaster(
    TallyMasterKind Kind,
    string? Guid,
    string Name,
    string? Parent,
    string? UnitName = null,
    decimal? OpeningBalance = null,
    decimal? ClosingBalance = null);

/// <summary>Parsed ledger entry within a voucher.</summary>
public sealed record TallyLedgerEntry(string LedgerName, bool IsDeemedPositive, decimal Amount);

/// <summary>Parsed voucher from a collection export.</summary>
public sealed record TallyVoucher(
    string Guid,
    string? RemoteId,
    string? VchKey,
    string VoucherTypeName,
    string VoucherNumber,
    DateOnly Date,
    decimal Amount,
    long? MasterId,
    bool IsDeleted,
    IReadOnlyList<TallyLedgerEntry> LedgerEntries,
    string? Narration);

/// <summary>Parsed import result from a voucher import response.</summary>
public sealed record TallyImportResult(
    int Created, int Altered, int Deleted, int LastVchId, int LastMid,
    int Combined, int Ignored, int Errors, int Cancelled, int Exceptions, int VchNumber);

/// <summary>What we observed about the currently loaded company (§6 step 3).</summary>
public sealed record TallyCompanyInfo(string Name, string CompanyNumber, string BooksFrom);

/// <summary>Result of a Tally probe: is it reachable, what version, what company is loaded.</summary>
public sealed record TallyProbeInfo(bool Reachable, string? Version, TallyCompanyInfo? Company, string? Error)
{
    public static TallyProbeInfo Unreachable(string reason) => new(false, null, null, reason);
}

/// <summary>
/// Parsers for Tally JSON/JSONEx responses. All parsing is tolerant: missing fields produce defaults,
/// numeric strings are trimmed, dates are yyyyMMdd. Every parser is a static pure function.
/// </summary>
public static class TallyParsers
{
    private static readonly JsonSerializerOptions s_options = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    /// <summary>Parse a ledger collection response JSON string into ledger records.</summary>
    public static IReadOnlyList<TallyLedger> ParseLedgers(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        if (!TryGetCollection(root, out var collection)) return [];

        var list = new List<TallyLedger>();
        foreach (var item in collection.EnumerateArray())
        {
            var name = GetStringValue(item, "name") ?? "";
            var parent = GetStringValue(item, "parent") ?? "";
            var balance = GetDecimalValue(item, "closing balance") ?? GetDecimalValue(item, "closingbalance") ?? 0m;
            var guid = NullIfBlank(GetStringValue(item, "guid"));
            var opening = GetDecimalValue(item, "opening balance") ?? GetDecimalValue(item, "openingbalance");
            if (!string.IsNullOrWhiteSpace(name))
                list.Add(new TallyLedger(name, parent, balance, guid, opening));
        }

        return list;
    }

    /// <summary>
    /// Parse a master collection (group, ledger, stock item, unit, voucher type, cost centre). Tolerant: a missing guid
    /// stays null (the importer decides what to do), blank names are skipped. Does not look at the status field; the
    /// client checks that before parsing.
    /// </summary>
    public static IReadOnlyList<TallyMaster> ParseMasters(string json, TallyMasterKind kind)
    {
        using var doc = JsonDocument.Parse(json);
        if (!TryGetCollection(doc.RootElement, out var collection)) return [];

        var list = new List<TallyMaster>();
        foreach (var item in collection.EnumerateArray())
        {
            var name = GetStringValue(item, "name");
            if (string.IsNullOrWhiteSpace(name)) continue;

            list.Add(new TallyMaster(
                kind,
                NullIfBlank(GetStringValue(item, "guid")),
                name,
                NullIfBlank(GetStringValue(item, "parent")),
                NullIfBlank(GetStringValue(item, "baseunits")) ?? NullIfBlank(GetStringValue(item, "base units")),
                GetDecimalValue(item, "opening balance") ?? GetDecimalValue(item, "openingbalance"),
                GetDecimalValue(item, "closing balance") ?? GetDecimalValue(item, "closingbalance")));
        }

        return list;
    }

    private static string? NullIfBlank(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    /// <summary>Parse a voucher collection response JSON string into voucher records.</summary>
    public static IReadOnlyList<TallyVoucher> ParseVouchers(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        if (!TryGetCollection(root, out var collection)) return [];

        var list = new List<TallyVoucher>();
        foreach (var item in collection.EnumerateArray())
        {
            var voucher = ParseOneVoucher(item);
            if (voucher is not null) list.Add(voucher);
        }

        return list;
    }

    /// <summary>Parse an import response JSON string into an import result.</summary>
    public static TallyImportResult? ParseImportResult(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        if (!root.TryGetProperty("data", out var data)) return null;
        if (!data.TryGetProperty("import_result", out var ir)) return null;

        return new TallyImportResult(
            GetIntProperty(ir, "created"),
            GetIntProperty(ir, "altered"),
            GetIntProperty(ir, "deleted"),
            GetIntProperty(ir, "lastvchid"),
            GetIntProperty(ir, "lastmid"),
            GetIntProperty(ir, "combined"),
            GetIntProperty(ir, "ignored"),
            GetIntProperty(ir, "errors"),
            GetIntProperty(ir, "cancelled"),
            GetIntProperty(ir, "exceptions"),
            GetIntProperty(ir, "vchnumber"));
    }

    /// <summary>Parse the top-level status from any Tally response. "1" = success.</summary>
    public static bool ParseStatus(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.TryGetProperty("status", out var st))
            {
                var val = st.ValueKind == JsonValueKind.String ? st.GetString() : st.ToString();
                return val == "1";
            }

            return false;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    /// <summary>Extract a narration marker <c>[ERP:&lt;uuid&gt;]</c> from text.</summary>
    public static string? ExtractMarker(string? text)
    {
        if (string.IsNullOrEmpty(text)) return null;
        const string prefix = "[ERP:";
        var start = text.IndexOf(prefix, StringComparison.Ordinal);
        if (start < 0) return null;
        var end = text.IndexOf(']', start + prefix.Length);
        if (end < 0) return null;
        return text[(start + prefix.Length)..end];
    }

    private static TallyVoucher? ParseOneVoucher(JsonElement item)
    {
        var guid = GetStringProp(item, "guid") ?? "";
        if (string.IsNullOrEmpty(guid)) return null;

        var remoteId = GetMetadataString(item, "remoteid") ?? GetStringProp(item, "remoteid");
        var vchKey = GetMetadataString(item, "vchkey") ?? GetStringProp(item, "vchkey");
        var voucherType = GetMetadataString(item, "vchtype") ?? GetStringProp(item, "vouchertypename") ?? "";
        var voucherNumber = GetStringProp(item, "vouchernumber") ?? "";

        var date = ParseTallyDate(item);
        var amount = GetDecimalTypedValue(item, "amount") ?? 0m;
        var masterId = GetLongTypedValue(item, "masterid");
        var isDeleted = GetBoolProp(item, "isdeleted");
        var narration = GetStringProp(item, "narration") ?? GetStringValue(item, "narration");

        var entries = new List<TallyLedgerEntry>();
        if (item.TryGetProperty("allledgerentries", out var ale) && ale.ValueKind == JsonValueKind.Array)
        {
            foreach (var entry in ale.EnumerateArray())
            {
                var ledgerName = GetTypedStringValue(entry, "ledgername") ?? "";
                var isPositive = GetTypedBoolValue(entry, "isdeemedpositive");
                var entryAmount = GetDecimalTypedValue(entry, "amount") ?? 0m;
                entries.Add(new TallyLedgerEntry(ledgerName, isPositive, entryAmount));
            }
        }

        return new TallyVoucher(guid, remoteId, vchKey, voucherType, voucherNumber,
            date, amount, masterId, isDeleted, entries, narration);
    }

    private static DateOnly ParseTallyDate(JsonElement item)
    {
        if (item.TryGetProperty("date", out var dp))
        {
            string? dateStr;
            if (dp.ValueKind == JsonValueKind.Object && dp.TryGetProperty("value", out var dv))
                dateStr = dv.GetString();
            else if (dp.ValueKind == JsonValueKind.String)
                dateStr = dp.GetString();
            else
                dateStr = null;

            if (dateStr is not null && DateOnly.TryParseExact(dateStr, "yyyyMMdd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d))
                return d;
        }

        return default;
    }

    private static bool TryGetCollection(JsonElement root, out JsonElement collection)
    {
        collection = default;
        if (root.TryGetProperty("data", out var data) && data.TryGetProperty("collection", out var c) && c.ValueKind == JsonValueKind.Array)
        {
            collection = c;
            return true;
        }

        return false;
    }

    private static string? GetStringProp(JsonElement e, string name)
    {
        foreach (var prop in e.EnumerateObject())
        {
            if (string.Equals(prop.Name, name, StringComparison.OrdinalIgnoreCase) && prop.Value.ValueKind == JsonValueKind.String)
                return prop.Value.GetString();
            if (string.Equals(prop.Name, name, StringComparison.OrdinalIgnoreCase) && prop.Value.ValueKind == JsonValueKind.False)
                return null;
        }

        return null;
    }

    private static bool GetBoolProp(JsonElement e, string name)
    {
        foreach (var prop in e.EnumerateObject())
        {
            if (string.Equals(prop.Name, name, StringComparison.OrdinalIgnoreCase))
            {
                return prop.Value.ValueKind switch
                {
                    JsonValueKind.True => true,
                    JsonValueKind.False => false,
                    JsonValueKind.String => string.Equals(prop.Value.GetString(), "true", StringComparison.OrdinalIgnoreCase)
                                            || prop.Value.GetString() == "Yes",
                    _ => false,
                };
            }
        }

        return false;
    }

    private static string? GetStringValue(JsonElement e, string name)
    {
        foreach (var prop in e.EnumerateObject())
        {
            if (string.Equals(prop.Name, name, StringComparison.OrdinalIgnoreCase))
            {
                if (prop.Value.ValueKind == JsonValueKind.String) return prop.Value.GetString();
                if (prop.Value.ValueKind == JsonValueKind.Object && prop.Value.TryGetProperty("value", out var v))
                    return v.GetString();
            }
        }

        return null;
    }

    private static decimal? GetDecimalValue(JsonElement e, string name)
    {
        var str = GetStringValue(e, name);
        if (str is not null && decimal.TryParse(str.Trim(), NumberStyles.Any, CultureInfo.InvariantCulture, out var d))
            return d;
        return null;
    }

    private static decimal? GetDecimalTypedValue(JsonElement e, string name)
    {
        foreach (var prop in e.EnumerateObject())
        {
            if (!string.Equals(prop.Name, name, StringComparison.OrdinalIgnoreCase)) continue;
            string? raw = null;
            if (prop.Value.ValueKind == JsonValueKind.Object && prop.Value.TryGetProperty("value", out var v))
                raw = v.GetString();
            else if (prop.Value.ValueKind == JsonValueKind.String)
                raw = prop.Value.GetString();
            else if (prop.Value.ValueKind == JsonValueKind.Number)
                return prop.Value.GetDecimal();

            if (raw is not null && decimal.TryParse(raw.Trim(), NumberStyles.Any, CultureInfo.InvariantCulture, out var d))
                return d;
        }

        return null;
    }

    private static long? GetLongTypedValue(JsonElement e, string name)
    {
        foreach (var prop in e.EnumerateObject())
        {
            if (!string.Equals(prop.Name, name, StringComparison.OrdinalIgnoreCase)) continue;
            if (prop.Value.ValueKind == JsonValueKind.Object && prop.Value.TryGetProperty("value", out var v))
            {
                var s = v.GetString()?.Trim();
                if (s is not null && long.TryParse(s, NumberStyles.Any, CultureInfo.InvariantCulture, out var l))
                    return l;
            }
            else if (prop.Value.ValueKind == JsonValueKind.Number)
                return prop.Value.GetInt64();
        }

        return null;
    }

    private static string? GetTypedStringValue(JsonElement e, string name)
    {
        foreach (var prop in e.EnumerateObject())
        {
            if (!string.Equals(prop.Name, name, StringComparison.OrdinalIgnoreCase)) continue;
            if (prop.Value.ValueKind == JsonValueKind.Object && prop.Value.TryGetProperty("value", out var v))
                return v.GetString();
            if (prop.Value.ValueKind == JsonValueKind.String)
                return prop.Value.GetString();
        }

        return null;
    }

    private static bool GetTypedBoolValue(JsonElement e, string name)
    {
        foreach (var prop in e.EnumerateObject())
        {
            if (!string.Equals(prop.Name, name, StringComparison.OrdinalIgnoreCase)) continue;
            if (prop.Value.ValueKind == JsonValueKind.Object && prop.Value.TryGetProperty("value", out var v))
            {
                return v.ValueKind switch
                {
                    JsonValueKind.True => true,
                    JsonValueKind.False => false,
                    _ => false,
                };
            }

            return prop.Value.ValueKind == JsonValueKind.True;
        }

        return false;
    }

    private static string? GetMetadataString(JsonElement item, string name)
    {
        if (item.TryGetProperty("metadata", out var meta) && meta.ValueKind == JsonValueKind.Object)
        {
            foreach (var prop in meta.EnumerateObject())
            {
                if (string.Equals(prop.Name, name, StringComparison.OrdinalIgnoreCase) && prop.Value.ValueKind == JsonValueKind.String)
                    return prop.Value.GetString();
            }
        }

        return null;
    }

    private static int GetIntProperty(JsonElement e, string name)
    {
        foreach (var prop in e.EnumerateObject())
        {
            if (!string.Equals(prop.Name, name, StringComparison.OrdinalIgnoreCase)) continue;
            if (prop.Value.ValueKind == JsonValueKind.Number) return prop.Value.GetInt32();
            if (prop.Value.ValueKind == JsonValueKind.String
                && int.TryParse(prop.Value.GetString(), NumberStyles.Any, CultureInfo.InvariantCulture, out var i))
                return i;
        }

        return 0;
    }
}

