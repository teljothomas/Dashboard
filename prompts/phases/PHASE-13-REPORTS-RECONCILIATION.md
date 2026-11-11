# PHASE-13 — Reports, Dashboard and Reconciliation

## A. Identity
- Objective: reporting framework with provenance/freshness, Excel/PDF export, dashboard, management and Tally-reference reports,
  bank/cash reconciliation.
- Assigned model: Sonnet. **Opus review REV-13** of financial interpretation (WP-13.6). Haiku-eligible tasks marked.
- Prerequisites: Phase 12 gate. Owner: sample bank statement export (CSV/XLSX) from the current bank for WP-13.5.
- Requirements: BR-004, BR-110, BR-200, BR-210. Docs: DATA_MODEL §12–13; INTERFACES §2 recon/report rows, §6; ARCHITECTURE §7.

## B. Context rules
STATUS.md → registry → this WP → Context only. Reports read only `rpt_*` views and tally mirror tables; no writes to other modules.

## C/D. Phase-wide requirements
Every figure carries source TALLY / ERP_MANAGEMENT / ESTIMATE and as-of for Tally data; stale banner when beyond threshold;
consolidated figures never add internal allocations as revenue; exports include the source/as-of footer; formula-injection guard;
report permissions (driver: none of report.financial.*); queries indexed and p95 < 1 s on 10× seed.

---

### WP-13.1 — Reporting framework and exports
Size M · Haiku: no
Context: INTERFACES §6; SECURITY §4 (formula injection).
Tasks: report registry (id, permission, params schema, query fn, columns with source), envelope builder, freshness via
`tally.getFreshness`, XLSX export (exceljs) and PDF export (pdfmake, no headless browser), streaming for large XLSX.
Tests: envelope shape, footer present in exports, injection guard, permission denial (TS-S01 for financial reports).
Next: WP-13.2.

### WP-13.2 — Dashboard
Size M · Haiku: yes (tiles UI)
Context: BR-110; SYNC_DESIGN §6.
Tasks: `/dashboard` permission-filtered tiles: sales/purchases (TALLY), expenses (ERP, by status), cash vs bank balances (TALLY,
separate tiles), receivables/payables (TALLY), inventory value (ESTIMATE until OD-011), factory/labour/vehicle costs, trip
profitability, external logistics revenue (TALLY-linked) vs internal logistics cost (ERP_MANAGEMENT), EMI due next 30 days,
approval queue count, sync health (last heartbeat, last success, failures, BLOCKED_MAPPING count).
Tests: role-based tile visibility; labels/sources correct.
Next: WP-13.3.

### WP-13.3 — Management reports
Size L · Haiku: yes (views after first two are reviewed)
Context: DATA_MODEL §13 view list.
Modify: next migration `NNNN_report_views.sql`, `modules/reports/**`.
Tasks: division management P&L (Tally voucher amounts by cost centre/ledger mapping + ERP allocations clearly separated),
expense analysis, factory costs, labour costs, driver statements, vehicle profitability, internal vs external trips, fuel
efficiency, EMI forecast, monthly/annual comparisons.
Tests: fixture-based numeric tests per report; consolidated total excludes internal allocation revenue (TS-A04 report side).
Next: WP-13.4.

### WP-13.4 — Tally reference reports
Size M · Haiku: no
Context: DATA_MODEL §4 tally tables; TALLY_INTEGRATION §8 (balances/group capabilities).
Tasks: customer/supplier outstanding, cash/bank book view, sales/purchase registers, P&L/BS reference from imported group/ledger
balances (if §8 lacks a verified capability for group balances: extend agent BALANCES stream in a sub-task `WP-13.4a` with tests,
or ESC). Always labelled "Reference copy of Tally — Tally is authoritative".
Tests: totals equal fixture sums; stale flag behaviour.
Next: WP-13.5.

### WP-13.5 — Bank and cash reconciliation
Size L · Haiku: yes (parser for a second bank format following the first)
Context: DATA_MODEL §12; BR-200.
Tasks: statement upload (attachment) → parser per bank profile (configurable column mapping), line_hash duplicate skip; auto-match
to Tally bank vouchers (amount + date ± 3 days + reference similarity, score), manual match/unmatch with reason, unmatched lists
both sides, reconciliation history; cash count vs Tally cash balance with variance note. Never creates vouchers.
Tests: duplicate upload skipped, auto-match precision on fixtures, manual override audited.
Next: WP-13.6.

### WP-13.6 — Opus review and Phase 13 gate
Size S · Opus REV-13: provenance labels, consolidated vs division logic, no double counting, cash vs bank separation, estimates
labelled. Fix CRITICAL/HIGH. Gate; STATUS next WP-14.1.

## E. Phase acceptance criteria
All BR-210 reports available in JSON/XLSX/PDF with provenance; dashboard role-filtered; reconciliation works without posting.

## F. Verification commands
`pnpm --filter api test:integration && pnpm test && pnpm --filter web e2e && pnpm lint && pnpm typecheck && pnpm build`

## G. Completion requirements
Protocol Step 6.

## H. Failure handling
A figure whose source cannot be classified is not shown until classified (ESC if needed).
