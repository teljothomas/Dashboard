# PHASE-10 — Expenses, Approvals, Advances and Ledger Core

Executed after Phase 06 and before Phase 07 (ADR-060).

## A. Identity
- Objective: ledger core (financial events + posting outbox enqueue), common expense engine, generic approval engine,
  common advance engine (drivers and workers), reversal workflow, expense capture UI.
- Assigned model: Sonnet. Haiku-eligible tasks marked. Opus review not mandatory here (covered by REV-11), but any
  change to event types or posting keys requires ESC.
- Prerequisites: Phase 06 gate.
- Requirements: BR-022, 026, 190, 301, 302. Decisions: ADR-021, 022, 025. Docs: DATA_MODEL §5, §8; INTERFACES §2 expense rows, §7;
  SYNC_DESIGN §2.3–2.4, §3 (PENDING only).

## B. Context rules
STATUS.md → registry → this WP → Context only. Do not load Tally agent code. Posting beyond PENDING is Phase 11.

## C/D. Phase-wide requirements
Money via domain money; events balanced (DB trigger + domain check); events immutable; one event per (source, type, seq);
approval + event + outbox insert in one transaction; duplicate detection (soft) requires explicit confirmation with reason;
expenses above category threshold require attachment; division mandatory; self-approval forbidden (OWNER exempt).

---

### WP-10.1 — Ledger core: financial events and outbox enqueue
Size L · Haiku: no
Context: DATA_MODEL §5 + posting_outbox row in §4; INTERFACES §7 ledger signatures; TALLY_INTEGRATION §5 table (event types only).
Modify: migration `0009_ledger.sql`, `apps/api/src/modules/ledger/**`, `packages/domain/src/ledger.ts`.
Tasks: tables financial_event, financial_event_line, posting_outbox (+ posting_attempt empty); balance constraint trigger
(deferred), immutability trigger (only posting_status mutable); posting-key grammar validator; `ledger.createEvent`,
`ledger.reverseEvent` (mirror lines, links both ways); posting_status mirror update helper (used in Phase 11).
Tests: unbalanced rejected; duplicate source rejected; reversal mirrors; immutability; outbox row created PENDING.
Next: WP-10.2.

### WP-10.2 — Expense categories and expenses (offline-capable)
Size L · Haiku: yes (category admin screen/tests)
Context: DATA_MODEL §8 expense_category, expense; INTERFACES expense rows; OFFLINE_DESIGN §1, §5.
Modify: migration `0010_expenses.sql`, `modules/expenses/**`, contracts, seed categories (rent, electricity, water, refrigeration,
sanitation, repairs, packaging, consumables, wages, diesel, toll, parking, vehicle maintenance, tyres, insurance, permits,
driver allowance, misc) with groups and default divisions.
Tasks: CRUD (DRAFT only editable), submit/cancel, dedupe fingerprint (category|amount|date|payee|vehicle) + attachment-hash check →
DUPLICATE_SUSPECTED, attachment-required threshold, sync entity registration (create/update/submit/cancel), scope rules
(DRIVER/SUPERVISOR OWN), `syncStatus` computation.
Tests: TS-O01 server side, TS-O03, duplicate warning flow, permission matrix.
Next: WP-10.3.

### WP-10.3 — Generic approval engine
Size M · Haiku: no
Context: DATA_MODEL §8 approval_*; INTERFACES §7 approvals; OD-042 provisional.
Modify: migration `0011_approvals.sql`, `modules/approvals/**`.
Tasks: policies (provisional: all financial items need OWNER or ACCOUNTANT; FACTORY_MANAGER ≤ threshold in MEAT via setting),
request creation on submit, queue filtered by permissions/thresholds, approve/reject with comment, handler registry
(`onApproved` creates financial events in the same transaction), self-approval guard. Migrate Phase 06 write-off approvals to
this engine (keep behaviour; adjust tests).
Tests: threshold routing, self-approval forbidden, approve creates event + outbox atomically (failure rolls back both).
Next: WP-10.4.

### WP-10.4 — Advance engine (drivers and workers)
Size L · Haiku: no
Context: DATA_MODEL §8 advance*, BR-026; TALLY_INTEGRATION §5 rows ADVANCE_*.
Modify: migration `0012_advances.sql`, `modules/advances/**`, `packages/domain/src/advance.ts`.
Tasks: advance request/approve (ADVANCE_ISSUE event), FROM_ADVANCE expenses (no own event), settlement draft (select unsettled
expenses, cash returned, reimbursement), settlement approval (ADVANCE_SETTLEMENT event), outstanding maintenance, payroll
recovery API (`advances.recordPayrollRecovery`) used by Phase 07, statements per payee.
Tests: TS-A01 exact BR-026 numbers produce lines Dr DIESEL 3500, TOLL 500, PARKING 200, CASH 800 / Cr ADV 5000; overspend
reimbursement; partial settlement; expense cannot settle twice; outstanding never negative.
Next: WP-10.5.

### WP-10.5 — Reversal workflow and expense reporting basics
Size M · Haiku: yes (list filters UI)
Context: DECISIONS ADR-025; INTERFACES `/financial-events/:id/reverse`.
Tasks: reverse endpoint (OWNER/ACCOUNTANT + tally.posting.manage), reason required, source record status REVERSED, optional
replacement (new draft cloned); expense list/search/filter API for later reports.
Tests: TS-A06 (reversal event mirrors, original untouched, audit present).
Next: WP-10.6.

### WP-10.6 — Web screens and Phase 10 gate
Size L · Haiku: yes (forms/lists after Sonnet builds expense capture)
Tasks: expense capture (offline, camera, category picker, payment mode, advance selection), my expenses with status chips,
approval queue (desktop + mobile), advance request/settlement screens, category admin. E2E: create offline-capable expense →
submit → approve → AWAITING_TALLY status visible. Full gate; STATUS next WP-07.1.

## E. Phase acceptance criteria
Approved expenses/advances/settlements create balanced immutable events with PENDING outbox rows exactly once; statuses visible.

## F. Verification commands
`pnpm --filter api test:integration && pnpm test && pnpm --filter web e2e && pnpm lint && pnpm typecheck`

## G. Completion requirements
Protocol Step 6.

## H. Failure handling
Accounting ambiguity (e.g., new expense type needing different treatment) → do not improvise posting keys; ESC + OD entry.
