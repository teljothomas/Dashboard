# Business Requirements Baseline (v1.0, 2026-11-11)

Requirement IDs (BR-*) are referenced by phase prompts instead of restating requirements.
Change only through `docs/DECISIONS.md` (Opus). Unknowns live in `docs/OPEN_DECISIONS.md`.

## 1. Entity and divisions

- BR-001 One legal entity, one current bank account, one consolidated set of books (in Tally).
- BR-002 Two operational divisions: `MEAT` (Division A: trading + processing) and `LOGISTICS` (Division B).
- BR-003 Frozen and fresh meat are product categories inside MEAT, not companies or divisions.
- BR-004 Consolidated financial reporting comes from Tally. Division-wise reporting is management reporting in the ERP.
- BR-005 No separate legal entities, balance sheets or inter-company accounting.

## 2. Scale (design point; must grow without rewrite)

- BR-010 20–30 financial transactions/day (600–900/month). Design headroom: 10x.
- BR-011 10–20 factory workers, 4–5 trucks (refrigerated and normal), one rented factory.
- BR-012 Payment modes: cash, UPI, bank transfer, credit, partial payment, settlement.
- BR-013 Primary devices: Android phones. Desktop browser for owner/accountant.

## 3. Accounting responsibility (fixed)

- BR-020 Tally is the official accounting system and source of truth for books.
- BR-021 Tally→ERP (read-only import, never re-entered in ERP): sales/purchase invoices, credit/debit notes,
  receipts, payments, journal and other vouchers, cash/bank entries, parties, ledgers, groups, stock items,
  units, voucher types, cost centres.
- BR-022 ERP→Tally (after approval + validation, through a durable queue): factory rent, electricity, water,
  utilities, labour wages and advances, driver advances and settlements, diesel, toll, parking, vehicle
  maintenance, other operational expenses, loan principal/interest, lease entries.
- BR-023 Operational-only records (no voucher unless an accounting entry is required): attendance, trip
  kilometres, maintenance schedules, checklists, driver performance, internal allocation, delivery proof, planning.
- BR-024 External logistics trips: ERP captures trip, costs, profitability and invoice-ready data; the owner
  creates the official invoice in Tally; ERP links the imported Tally invoice to the trip. ERP never issues invoices.
- BR-025 Internal trips: no revenue, no voucher. Costs may be allocated to MEAT for management reports only.
- BR-026 Advances (driver, labour) are assets until settled against actual expenses, returned cash or
  payroll recovery. Example: advance 5,000; diesel 3,500, toll 500, parking 200, returned 800 → advance fully cleared.
- BR-027 Loans: EMI split into principal (liability reduction) and interest (expense). Depreciation separate.
  Leases: treatment configurable, approved by CA. Never treat whole EMI as expense.
- BR-028 Decisions requiring CA validation are recorded in OPEN_DECISIONS (category ACCT) and never invented.

## 4. Tally topology (fixed)

- BR-030 Exactly one designated Windows PC runs TallyPrime 7.0 with the authoritative company.
- BR-031 The PC need not run 24/7. ERP stays fully usable when it is off; Tally-bound items queue.
- BR-032 On PC start: agent auto-starts, verifies identity, Tally, company; posts approved items; imports changes; verifies.
- BR-033 Exactly one active sync agent per company (cloud lease). Tally port never exposed publicly.
- BR-034 Multiple existing Tally company copies are never merged automatically.

## 5. Functional modules

- BR-100 Identity & access: login/logout, Argon2id hashing, sessions, password reset, users, roles (Owner,
  Administrator, Accountant, Factory Manager, Supervisor, Driver, custom), approval permissions, activity log.
  Drivers see only their own records and no sensitive financials.
- BR-110 Dashboard: sales, purchases, expenses, Tally cash/bank balances, receivables/payables, inventory,
  factory/labour/vehicle costs, trip profitability, external logistics revenue, internal logistics cost, EMI
  commitments, approval queue, sync status, failures, last successful sync. Labels separate accounting
  figures, management estimates, cash balance and bank balance.
- BR-120 Meat trading & inventory: products, FROZEN/FRESH categories, SKU, UoM, parties, Tally sales/purchase
  import, stock receipts and movements, lots, processing, expiry, spoilage, wastage, returns, adjustments,
  stock counts, valuation (method = OD), product profitability. No duplicate invoices.
- BR-130 Factory: one factory profile, rent, electricity, water, refrigeration, sanitation, repairs, packaging,
  consumables, operational records, attachments, monthly summary, cost/kg where inputs are reliable.
- BR-140 Labour: workers, attendance, daily/monthly wages, overtime, advances, deductions, wage calculation,
  approval, payment status, statements, monthly cost, Tally posting after approval.
- BR-150 Drivers: profiles, fixed salary, trip payment, allowances, advances, settlements, deductions,
  statements, trip history, performance, licence/document expiry reminders.
- BR-160 Fleet: vehicles, refrigerated/normal, reefer units, owned/loan/lease, insurance, permits, fitness,
  PUC, service schedules, repairs, tyres, diesel, toll, parking, km, efficiency, downtime, expenses, profitability.
- BR-170 Trips: number, date, INTERNAL/EXTERNAL, customer, vehicle, driver, origin, destination, route,
  start/end km, distance, cargo, charges, diesel, toll, parking, allowance, other expenses, delivery status, proof.
- BR-180 Loans & leases: lender/lessor, reference, principal, interest, EMI, dates, outstanding, schedule,
  payment history, forecast, due alerts.
- BR-190 Expenses & approvals: categories, division allocation, date, amount, mode, payee, description,
  photo/bill, files, creator, approver, history, Tally posting state, duplicate prevention, reports.
- BR-200 Cash/bank reconciliation: Tally authoritative; statement upload, matching, cash count, unmatched and
  duplicate detection, history. Never double-post what Tally already has.
- BR-210 Reports: consolidated and division management reports, Tally P&L/BS reference, sales, purchases,
  outstanding, cash/bank, inventory, factory, labour, driver, vehicle profitability, internal vs external
  trips, diesel efficiency, EMI forecast, expense analysis, monthly/annual, Excel and PDF export.
  Every report states data source (TALLY / ERP_MANAGEMENT / ESTIMATE) and freshness.

## 6. Offline (field use)

- BR-300 Installable Android PWA; offline capture of expenses, attendance, trips, operational records, photos.
- BR-301 Every record shows one of: LOCAL_ONLY, SYNCED, AWAITING_APPROVAL, AWAITING_TALLY,
  POSTED_TO_TALLY, FAILED, REQUIRES_RECONCILIATION. Never show "synced" for local-only data.
- BR-302 No last-write-wins for financial records; explicit conflicts with audit history.

## 7. Non-functional

- BR-400 Infrastructure target ≈ ₹1,200–2,000/month (to be confirmed with real pricing; OD-030).
- BR-401 No microservices, Kubernetes, Redis, extra databases, or AI APIs for ordinary operations.
- BR-402 Security per `docs/SECURITY.md`; backups with tested restore; audit log on every mutation.
- BR-403 Simple enough for daily use by non-technical staff on low-end Android phones; English UI first,
  regional language later (OD-041).
