# PHASE-08 — Drivers, Fleet, Loans and Leases

## A. Identity
- Objective: vehicles and compliance documents, maintenance/tyres/fuel/downtime, drivers and pay rules, driver advances and
  settlements (reusing the advance engine), driver payables and statements, loan/lease agreements, schedules, EMI postings, forecast.
- Assigned model: Sonnet. Haiku-eligible tasks marked.
- Prerequisites: Phase 07 gate (order per registry; functionally depends on Phase 10).
- Provisional (test only): OD-014 (lender schedule entered manually), OD-015 (lease as expense), OD-022 (trip pay expense on close).
- Requirements: BR-150, 160, 180, 026, 027. Docs: DATA_MODEL §10; INTERFACES §2 fleet/drivers/finance rows; TALLY_INTEGRATION §5.

## B. Context rules
STATUS.md → registry → this WP → Context only. Labour/inventory code is out of scope.

## C/D. Phase-wide requirements
Driver role sees only own driver record, trips, advances, expenses, statement; no financial reports. Fuel entries create their
linked expense through `expenses` service in the same transaction. EMI = principal + interest, never expensed whole (BR-027).
Document expiry reminders via jobs + notifications.

---

### WP-08.1 — Vehicles, reefer units, documents, reminders
Size M · Haiku: yes (CRUD screens)
Context: DATA_MODEL §10 vehicle, reefer_unit, vehicle_document.
Modify: next migration `NNNN_fleet.sql`, `modules/fleet/**`, jobs handler `doc-expiry`.
Tasks: vehicle CRUD (reg no normalisation/uniqueness), reefer units, documents with attachments, daily job creating notifications
at 30/15/7/0 days (idempotent per doc+threshold).
Acceptance: tests for uniqueness, reminder idempotency.
Next: WP-08.2.

### WP-08.2 — Maintenance, tyres, fuel, downtime, efficiency
Size L · Haiku: yes (tyre/downtime screens)
Context: DATA_MODEL §10 service_*, tyre, fuel_entry, downtime; OFFLINE_DESIGN §1.
Tasks: service schedules with due calculation (km/days); service records (offline) linked to an expense; tyres fit/remove; fuel
entry (offline) → creates DIESEL expense (mode/advance aware) atomically; odometer monotonic validation (warn + reason to override);
downtime; fuel efficiency km/l between full-tank fills (domain function).
Tests: due calc, efficiency maths, odometer rule, fuel→expense atomicity, offline registration.
Next: WP-08.3.

### WP-08.3 — Drivers, documents, pay rules, user link
Size M · Haiku: yes (driver CRUD)
Context: DATA_MODEL §10 driver*, INTERFACES drivers rows, §3 DRIVER scope.
Tasks: driver CRUD, link to app_user (unique), licence/document expiry (reuse reminder job), effective-dated pay rules,
OWN-scope enforcement for DRIVER role.
Tests: TS-S02 for drivers (driver A cannot read driver B → 404).
Next: WP-08.4.

### WP-08.4 — Driver advances, settlements, payables, statements
Size L · Haiku: no
Context: DATA_MODEL §8 advance*, §10 driver_payable; TALLY_INTEGRATION §5 DRIVER_* rows; OD-022.
Tasks: driver-facing advance request + settlement UI flows (engine from Phase 10); salary accrual job monthly (DRIVER.SALARY →
PAY.DRIVER via approval); driver payables for trip pay/allowances (hook used by Phase 09); DRIVER_PAYMENT events; statement
(advances, expenses, settlements, payables, payments, balance).
Tests: TS-A01 through driver UI path (API-level), statement balances reconcile with events.
Next: WP-08.5.

### WP-08.5 — Loans and leases
Size L · Haiku: yes (CSV schedule template + parser tests)
Context: DATA_MODEL §10 finance_*; BR-027; OD-014, OD-015.
Modify: next migration `NNNN_finance.sql`, `modules/finance/**`, `packages/domain/src/emi.ts`.
Tasks: agreements (loan/lease, vehicle link), schedule entry/CSV upload with validation (Σ principal = principal; dates ascending;
total = principal + interest), optional reference calculator (reducing balance) shown for comparison only; payments via approval →
LOAN_EMI (Dr LOAN.PRINCIPAL:<id>, Dr LOAN.INTEREST, Cr BANK.CURRENT) / LEASE_PAYMENT per lease_treatment; outstanding; overdue
job; forecast N months; due notifications.
Tests: TS-A03 (EMI 25,000 = principal 18,400 + interest 6,600 → exact lines), partial payments, schedule validation failures.
Next: WP-08.6.

### WP-08.6 — Web screens and Phase 08 gate
Size M · Haiku: yes. Fleet list/detail (docs, service due, fuel efficiency), driver app view (own trips placeholder, advances,
statement), finance screens. Full gate; STATUS next WP-09.1.

## E. Phase acceptance criteria
Compliance reminders work; fuel and maintenance costs flow through expenses; driver data isolated; EMI split correct and balanced.

## F. Verification commands
`pnpm --filter api test:integration && pnpm test && pnpm --filter web e2e && pnpm lint && pnpm typecheck`

## G. Completion requirements
Protocol Step 6.

## H. Failure handling
Lender schedule inconsistencies → reject upload with line-level errors; never auto-adjust amounts.
