using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using TradeX.Agent.Core.Cloud;

namespace TradeX.Agent.Tally.Import;

/// <summary>A wire record plus the key and content hash the agent uses to skip records the cloud already has.</summary>
public sealed record Keyed<T>(string Key, T Record, string Hash);

/// <summary>What the mapper left out, so the importer can log it once per cycle.</summary>
public sealed class MapReport
{
    public int MastersWithoutGuid { get; set; }
    public int VouchersSkippedNoDate { get; set; }
    public int VouchersSkippedTooManyLines { get; set; }
}

/// <summary>
/// Turns Tally exports into the connector wire records. Pure functions, no I/O. Every string is clipped to the cloud
/// schema limits, because one oversized field would make the cloud reject the whole batch (400) and the same batch
/// would then fail on every cycle.
/// </summary>
public sealed class ImportMapper
{
    public const int MaxVoucherLedgerLines = 200;

    private static readonly string[] PartyGroups = ["Sundry Debtors", "Sundry Creditors"];
    private static readonly string[] BalanceGroups = ["Cash-in-Hand", "Bank Accounts", "Bank OD A/c", "Sundry Debtors", "Sundry Creditors"];

    private static readonly Dictionary<string, string> BaseTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Sales"] = "SALES",
        ["Purchase"] = "PURCHASE",
        ["Receipt"] = "RECEIPT",
        ["Payment"] = "PAYMENT",
        ["Journal"] = "JOURNAL",
        ["Contra"] = "CONTRA",
        ["Credit Note"] = "CREDIT_NOTE",
        ["Debit Note"] = "DEBIT_NOTE",
    };

    private readonly Dictionary<string, string?> _groupParent = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, string?> _voucherTypeParent = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, (bool IsParty, string? Guid)> _ledgers = new(StringComparer.OrdinalIgnoreCase);

    public ImportMapper(
        IReadOnlyList<TallyMaster> groups,
        IReadOnlyList<TallyMaster> voucherTypes,
        IReadOnlyList<TallyLedger> ledgers)
    {
        foreach (var g in groups) _groupParent[g.Name] = g.Parent;
        foreach (var t in voucherTypes) _voucherTypeParent[t.Name] = t.Parent;
        foreach (var l in ledgers) _ledgers[l.Name] = (IsUnder(_groupParent, l.Parent, PartyGroups), l.Guid);
    }

    public MapReport Report { get; } = new();

    // ----- masters -------------------------------------------------------------------------------------------------

    public IReadOnlyList<Keyed<MasterRecordDto>> MapMasters(
        IReadOnlyList<TallyMaster> others, IReadOnlyList<TallyLedger> ledgers)
    {
        var result = new List<Keyed<MasterRecordDto>>();

        foreach (var m in others) result.Add(Wrap(MapMaster(m)));

        foreach (var l in ledgers)
        {
            var guid = GuidOrName("LEDGER", l.Guid, l.Name);
            var dto = new MasterRecordDto(
                "LEDGER", guid, Clip(l.Name, 300),
                Parent: null,
                ParentGroup: NullIfBlank(l.Parent, 500),
                IsParty: _ledgers[l.Name].IsParty,
                OpeningBalance: l.OpeningBalance is { } ob ? Money(ob) : null);
            result.Add(Wrap(dto));
        }

        return result;

        static Keyed<MasterRecordDto> Wrap(MasterRecordDto dto) => new(dto.Kind + "|" + dto.Guid, dto, HashOf(dto));
    }

    private MasterRecordDto MapMaster(TallyMaster m)
    {
        var kind = m.Kind switch
        {
            TallyMasterKind.Group => "GROUP",
            TallyMasterKind.StockItem => "STOCK_ITEM",
            TallyMasterKind.Unit => "UNIT",
            TallyMasterKind.VoucherType => "VOUCHER_TYPE",
            TallyMasterKind.CostCentre => "COST_CENTRE",
            _ => throw new ArgumentOutOfRangeException(nameof(m), "Ledgers are mapped from the ledger export."),
        };

        return new MasterRecordDto(
            kind, GuidOrName(kind, m.Guid, m.Name), Clip(m.Name, 300),
            Parent: m.Kind == TallyMasterKind.Unit ? null : NullIfBlank(m.Parent, 500),
            UnitName: m.Kind == TallyMasterKind.StockItem ? NullIfBlank(m.UnitName, 500) : null);
    }

    /// <summary>
    /// A master without a guid (the export did not return one, NOT VERIFIED until WP-05.7) is keyed by kind and name so
    /// it still reaches the cloud. A rename then shows up as a new master; the cloud keeps the old one.
    /// </summary>
    private string GuidOrName(string kind, string? guid, string name)
    {
        if (!string.IsNullOrWhiteSpace(guid)) return Clip(guid, 128);
        Report.MastersWithoutGuid++;
        return Clip($"NAME:{kind}:{name}", 128);
    }

    // ----- vouchers ------------------------------------------------------------------------------------------------

    public IReadOnlyList<Keyed<VoucherRecordDto>> MapVouchers(IReadOnlyList<TallyVoucher> vouchers)
    {
        var result = new List<Keyed<VoucherRecordDto>>(vouchers.Count);
        foreach (var v in vouchers)
        {
            if (v.Date == default)
            {
                Report.VouchersSkippedNoDate++;
                continue;
            }

            if (v.LedgerEntries.Count > MaxVoucherLedgerLines)
            {
                Report.VouchersSkippedTooManyLines++;
                continue;
            }

            var lines = v.LedgerEntries
                .Where(e => !string.IsNullOrWhiteSpace(e.LedgerName))
                .Select(e =>
                {
                    _ledgers.TryGetValue(e.LedgerName, out var info);
                    return new VoucherLedgerLineDto(Clip(e.LedgerName, 300), info.Guid, Money(e.Amount), info.IsParty);
                })
                .ToList();

            var party = lines.FirstOrDefault(l => l.IsParty)?.LedgerName;
            var typeName = string.IsNullOrWhiteSpace(v.VoucherTypeName) ? "Unknown" : v.VoucherTypeName;

            var dto = new VoucherRecordDto(
                Clip(v.Guid, 128),
                v.MasterId is >= 0 ? v.MasterId : null,
                Clip(typeName, 200),
                BaseTypeOf(typeName),
                Clip(v.VoucherNumber, 100),
                v.Date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                party,
                NullIfBlank(v.Narration, 4000),
                Money(v.Amount),
                IsCancelled: false,
                v.IsDeleted,
                lines);
            result.Add(new Keyed<VoucherRecordDto>(dto.Guid, dto, HashOf(dto)));
        }

        return result;
    }

    /// <summary>Built-in base type of a voucher type, following custom types up through their parents.</summary>
    public string BaseTypeOf(string voucherTypeName)
    {
        var name = voucherTypeName;
        for (var depth = 0; depth < 20 && !string.IsNullOrWhiteSpace(name); depth++)
        {
            if (BaseTypes.TryGetValue(name.Trim(), out var baseType)) return baseType;
            if (!_voucherTypeParent.TryGetValue(name, out var parent) || string.Equals(parent, name, StringComparison.OrdinalIgnoreCase)) break;
            name = parent ?? "";
        }

        return "OTHER";
    }

    // ----- balances ------------------------------------------------------------------------------------------------

    /// <summary>Closing balances of cash, bank and party ledgers (SYNC_DESIGN section 5 step 6), as of the given day.</summary>
    public IReadOnlyList<Keyed<BalanceRecordDto>> MapBalances(IReadOnlyList<TallyLedger> ledgers, DateOnly asOf)
    {
        var day = asOf.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        var result = new List<Keyed<BalanceRecordDto>>();
        foreach (var l in ledgers)
        {
            if (!IsUnder(_groupParent, l.Parent, BalanceGroups)) continue;
            var dto = new BalanceRecordDto(Clip(l.Name, 300), l.Guid is null ? null : Clip(l.Guid, 128), day, Money(l.ClosingBalance));
            result.Add(new Keyed<BalanceRecordDto>(GuidOrKey(l), dto, HashOf(dto)));
        }

        return result;

        static string GuidOrKey(TallyLedger l) => string.IsNullOrWhiteSpace(l.Guid) ? "NAME:" + l.Name : l.Guid;
    }

    // ----- helpers -------------------------------------------------------------------------------------------------

    /// <summary>True when the group, or any ancestor group, is one of <paramref name="roots"/>. Cycle safe.</summary>
    private static bool IsUnder(Dictionary<string, string?> parents, string? group, string[] roots)
    {
        var current = group;
        for (var depth = 0; depth < 20 && !string.IsNullOrWhiteSpace(current); depth++)
        {
            if (roots.Contains(current.Trim(), StringComparer.OrdinalIgnoreCase)) return true;
            if (!parents.TryGetValue(current, out var next) || string.Equals(next, current, StringComparison.OrdinalIgnoreCase)) return false;
            current = next;
        }

        return false;
    }

    /// <summary>Decimal money string with exactly two fraction digits (contracts <c>MoneyString</c>).</summary>
    public static string Money(decimal value) =>
        decimal.Round(value, 2, MidpointRounding.AwayFromZero).ToString("0.00", CultureInfo.InvariantCulture);

    private static string Clip(string value, int max) => value.Length <= max ? value : value[..max];

    private static string? NullIfBlank(string? value, int max) =>
        string.IsNullOrWhiteSpace(value) ? null : Clip(value.Trim(), max);

    internal static string HashOf<T>(T record) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(record, CloudClient.Json))));
}
