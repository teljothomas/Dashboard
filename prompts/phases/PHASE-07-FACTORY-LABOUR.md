# PHASE-07 — Factory and Labour

## A. Identity
- Objective: factory profile and operational logs, factory cost summaries, workers, attendance (offline), wage calculation,
  deductions, advance recovery, wage approval/payment events, labour reports.
- Assigned model: Sonnet. Haiku-eligible tasks marked.
- Prerequisites: Phase 10 gate (expense, approval, advance, ledger services exist).
- Provisional assumptions (test only): OD-013 (no statutory deductions, banner shown), OD-021 (accrue on approval), OD-043 (wage rule).
- Requirements: BR-130, BR-140, BR-026 (labour). Docs: DATA_MODEL §9; INTERFACES §2 factory/labour rows; TALLY_INTEGRATION §5 WAGE_* rows.

## B. Context rules
STATUS.md → registry → this WP → Context only. Use expenses/advances/ledger/approvals via their `index.ts` services only.

## C/D. Phase-wide requirements
Wage maths in `packages/domain/src/wages.ts` (pure, exhaustive tests); calc snapshot stored per line; attendance locked after
period APPROVED; worker personal data minimal; scopes DIVISION=MEAT; offline for attendance and factory logs.

---

### WP-07.1 — Factory profile, logs and cost summary
Size M · Haiku: yes (log forms per kind from schema)
Context: DATA_MODEL §9 factory, factory_log; INTERFACES factory rows.
Modify: next migration `NNNN_factory.sql`, `modules/factory/**`, contracts (log value schemas per kind), web features.
Tasks: single-row factory profile; factory_log with per-kind Zod value schemas (temperature, sanitation, maintenance, incident,
meter reading) and offline sync registration; monthly factory cost summary from expenses (group FACTORY, status APPROVED+) and
cost/kg using processing output kg (source ESTIMATE; hidden when output kg missing).
Acceptance: tests for log validation per kind, summary maths, offline registration.
Next: WP-07.2.

### WP-07.2 — Workers, wage rates, attendance
Size L · Haiku: yes (worker CRUD screens)
Context: DATA_MODEL §9 worker, wage_rate, attendance; SYNC_DESIGN §2.3 (uniqueness conflict); OFFLINE_DESIGN §6 TS-O04.
Modify: next migration `NNNN_labour.sql`, `modules/labour/**`, web features.
Tasks: worker CRUD; effective-dated rates (no overlap); daily attendance sheet API + offline entity (bulk per day = one mutation per
worker-day); unique (worker, date) conflict → sync_conflict; supervisor UI: one-screen day sheet with quick toggles + OT hours.
Tests: TS-O04 (two devices same worker/day → conflict, both preserved), rate overlap rejected, locked period rejects edits.
Next: WP-07.3.

### WP-07.3 — Wage calculation
Size L · Haiku: no
Context: DATA_MODEL §9 wage_period, wage_sheet_line, deduction; OD-043, OD-013.
Modify: `packages/domain/src/wages.ts`, `modules/labour/payroll/**`.
Tasks: domain: daily workers = days_present×rate + half_days×rate/2 + ot_hours×ot_rate; monthly workers = salary × paid days /
days in month (provisional, configurable); deductions; proposed advance recovery (≤ outstanding, ≤ configurable % of gross);
rounding to 2 dp HALF_UP at line level only. Period calculate (idempotent recalculation while CALCULATED), snapshot stored.
Tests: ≥ 20 domain cases (mid-month rate change, half-days, zero attendance, recovery caps).
Next: WP-07.4.

### WP-07.4 — Wage approval, payment, advance recovery events
Size M · Haiku: no
Context: TALLY_INTEGRATION §5 WAGE_* rows; INTERFACES §7 ledger/advances; BR-026.
Tasks: approve period (approval engine) → WAGE_ACCRUAL event (Dr WAGES.EXPENSE, Cr PAY.WORKER per worker or aggregated per
OD-016 provisional = per worker); payment per line → WAGE_PAYMENT (Dr PAY.WORKER; Cr CASH/BANK net; Cr ADV.WORKER for recovery)
and `advances.recordPayrollRecovery`; period → PAID → LOCKED; attendance lock.
Tests: TS-A02 (advance 3,000, recovery 1,000 via wages → outstanding 2,000; events balanced; no double recovery).
Next: WP-07.5.

### WP-07.5 — Labour reports, statements, screens, Phase 07 gate
Size M · Haiku: yes (report tables)
Tasks: worker statement (attendance, wages, advances, recoveries, payments), monthly labour cost by division, wage register
(format pending OD-013; label "management register"), screens for periods/approval/payments. Full gate; STATUS next WP-08.1.

## E. Phase acceptance criteria
Attendance captured offline without silent overwrite; wages reproducible from snapshot; events balanced and created once;
recoveries reduce advances exactly.

## F. Verification commands
`pnpm --filter api test:integration && pnpm test && pnpm --filter web e2e && pnpm lint && pnpm typecheck`

## G. Completion requirements
Protocol Step 6.

## H. Failure handling
Wage rule ambiguity → keep provisional rule configurable, record in OD-043; never hard-code statutory deductions.
