# Open Decisions Register

Owner: decisions listed here are NOT made. Agents must not invent answers.
Each item states who decides, which work it blocks, and the provisional development assumption
(used only for development/test data, never for production postings).

Categories: TALLY (topology/licence), ACCT (needs CA/accountant), BIZ (owner), OPS (operations/infra).
Status: OPEN | ANSWERED (record answer + date, then Opus folds it into DECISIONS.md via WP-01.R).

| ID | Cat | Question | Decider | Blocks | Provisional dev assumption | Status |
|---|---|---|---|---|---|---|
| OD-001 | TALLY | Which Windows PC is the designated Tally computer? Its Windows version, user account, always-on habits. | Owner | WP-05.7 (real-Tally acceptance) | Agent developed against simulator | OPEN |
| OD-002 | TALLY | TallyPrime 7.0 licence edition (Silver/Gold), serial, renewal (TSS) status. Is TSS active (needed for some connectivity features)? | Owner | WP-05.7 | — | OPEN |
| OD-003 | TALLY | Exact company name, company number, books-from date, financial year, data path. | Owner | WP-05.7, Phase 11 | Test company "ERP TEST CO" | OPEN |
| OD-004 | TALLY | Do other PCs hold separate Tally company copies? If yes, which is authoritative and how will historical differences be reconciled (manually, by accountant)? | Owner + CA | Phase 15 go-live | Single copy assumed for dev | OPEN |
| OD-005 | TALLY | Current Tally backup practice and restore test. | Owner | Phase 15 | — | OPEN |
| OD-006 | TALLY | Is a non-production test company available on the Tally PC (or a second licence/educational mode PC) for integration testing? | Owner | WP-05.7, WP-11.6 | Simulator only until answered | OPEN |
| OD-007 | TALLY | Does the Tally company use a company password / TallyVault / user security? If yes, how may the agent be granted read and import access without storing a plaintext password? | Owner + CA | WP-05.1, WP-05.7 | Test company without password | OPEN |
| OD-010 | ACCT | GST treatment for expenses (input credit on diesel = none; repairs, rent, utilities), RCM on transport (GTA), GST on external freight. | CA | WP-11.1 mapping for GST lines | Expenses posted gross, no GST split | OPEN |
| OD-011 | ACCT | Inventory valuation method (FIFO / weighted average) and whether Tally inventory is maintained with stock items. | CA | WP-06.5 valuation report | Weighted average, management view only | OPEN |
| OD-012 | ACCT | Depreciation method/rates for trucks, reefer units, factory equipment; posted by CA in Tally or by ERP? | CA | Phase 13 vehicle profitability | ERP shows depreciation as management estimate only | OPEN |
| OD-013 | ACCT | Payroll statutory treatment (PF/ESI/PT/TDS applicability, wage register format). | CA | WP-07.5 posting | No statutory deductions; flag shown | OPEN |
| OD-014 | ACCT | Truck loan accounting: ledger per loan, interest ledger, posting from lender schedule vs ERP-computed schedule. | CA | WP-08.6 posting | Lender schedule entered manually, principal/interest split per schedule | OPEN |
| OD-015 | ACCT | Lease accounting treatment (operating expense vs right-of-use asset/lease liability). | CA | WP-08.6 lease posting | Lease rent as expense (configurable flag, test only) | OPEN |
| OD-016 | ACCT | Ledger mapping: exact Tally ledgers for each ERP posting key; driver/worker advance ledgers (one per person under a group vs one control ledger + ERP sub-ledger). | CA | WP-11.1 production mapping | One ledger per person under "Loans & Advances (Asset)" in test company | OPEN |
| OD-017 | ACCT | Use Tally cost centres for divisions (MEAT, LOGISTICS)? | CA | WP-11.2 voucher builder | Yes, cost category "Division" in test company | OPEN |
| OD-018 | ACCT | Opening balances and cut-over date for ERP operational data (advances outstanding, loan outstanding, stock lots). | CA + Owner | Phase 15 | Synthetic test data | OPEN |
| OD-019 | ACCT | Internal logistics cost allocation basis (per km, per trip, per kg, actual trip cost). | Owner + CA | WP-09.5 | Actual trip cost allocated 100% to MEAT | OPEN |
| OD-020 | ACCT | Voucher types to use for ERP postings (Payment, Journal, custom "ERP Payment"/"ERP Journal"). | CA | WP-11.2 | Custom voucher types "ERP Payment", "ERP Journal" in test company | OPEN |
| OD-021 | ACCT | Wage payment: posted as expense on payment, or accrued monthly then paid? | CA | WP-07.5 | Accrue on approval of wage sheet, pay separately | OPEN |
| OD-022 | ACCT | Trip payments/allowances to drivers: expense on trip close, or through salary? | CA | WP-08.5 | Expense on trip close via driver payable | OPEN |
| OD-030 | OPS | VPS provider and plan (Indian region), domain name, object storage for off-site backups. Owner purchases. | Owner | Phase 14 staging deploy | Local Docker only | OPEN |
| OD-031 | OPS | Error monitoring: Sentry free tier (external SaaS) vs logs-only. | Owner | WP-14.5 | Logs + uptime check only | OPEN |
| OD-032 | OPS | Password reset channel: admin-issued reset code only, or email/SMS/WhatsApp provider. | Owner | WP-04.4 | Admin-issued one-time reset code | OPEN |
| OD-033 | OPS | Data retention periods (attachments, audit logs) — statutory books retention ≥ 8 years under Indian law to be confirmed by CA. | CA | Phase 14 | Retain everything | OPEN |
| OD-040 | BIZ | Product master list, SKUs, units (kg, box, carton), lot tracking required for which products? | Owner | WP-06.1 seed | Lots mandatory for FROZEN, optional FRESH | OPEN |
| OD-041 | BIZ | UI languages required (English + Malayalam/Tamil/Hindi/other?). | Owner | Phase 12/15 | English only, i18n-ready strings | OPEN |
| OD-042 | BIZ | Approval thresholds per role/category (e.g., supervisor up to ₹2,000, owner above). | Owner | WP-10.3 | All financial items need Owner or Accountant approval | OPEN |
| OD-043 | BIZ | Wage rules: daily vs monthly workers, OT multiplier, holidays, half-days. | Owner | WP-07.3 | Daily rate × days + OT hours × OT rate | OPEN |
| OD-044 | BIZ | Processing yield records needed (input kg → output kg per SKU) for cost/kg? | Owner | WP-06.4 | Yes, optional per batch | OPEN |
| OD-047 | ACCT | Must ERP stock write-offs (wastage, spoilage, expiry, count adjustments) be reflected in Tally (e.g. stock journal / physical stock voucher), and who posts them? | CA | WP-06.4 (Tally reflection), Phase 11 scope | ERP-only management records; no voucher | OPEN |
| OD-048 | ACCT | UPI payments: always from the business current account, or sometimes personal accounts/wallets? Ledger to credit for each. | Owner + CA | WP-10.2 payment modes, WP-11.1 mapping | UPI = BANK.CURRENT | OPEN |
| OD-045 | BIZ | Existing spreadsheet/WhatsApp data to migrate, and from which date. | Owner | Phase 15 | None | OPEN |
