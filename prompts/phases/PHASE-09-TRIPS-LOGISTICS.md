# PHASE-09 — Trips and Logistics

## A. Identity
- Objective: trip capture (offline, driver-friendly), internal/external classification, assignment, km, trip expenses,
  delivery proof, costing/profitability, external invoice-ready queue and Tally invoice linking, internal cost allocation.
- Assigned model: Sonnet. Haiku-eligible tasks marked.
- Prerequisites: Phase 08 gate.
- Provisional (test only): OD-019 (internal allocation = actual trip cost, 100 % to MEAT), OD-022.
- Requirements: BR-024, BR-025, BR-170. Decisions: ADR-023, ADR-024. Docs: DATA_MODEL §11; INTERFACES §2 trips rows.

## B. Context rules
STATUS.md → registry → this WP → Context only. Use fleet/drivers/expenses/parties/tally via service interfaces.

## C/D. Phase-wide requirements
ERP never generates an official invoice (any printable must say "NOT A TAX INVOICE"). INTERNAL trips: charges NULL,
invoice_status NOT_APPLICABLE, no financial events. Trip state machine enforced server-side; km monotonic per vehicle with
override reason; driver sees own trips only.

---

### WP-09.1 — Trip model, state machine, driver flows
Size L · Haiku: no
Context: DATA_MODEL §11 trip; SYNC_DESIGN §2.3; OFFLINE_DESIGN §1, §6 TS-O02.
Modify: next migration `NNNN_trips.sql`, `modules/trips/**`, contracts, web driver screens.
Tasks: trip CRUD + transitions (PLANNED→STARTED→DELIVERED→CLOSED; CANCELLED from PLANNED/STARTED), checks (EXTERNAL requires
customer; INTERNAL forbids charges), numbering on server, offline entity (create/start/deliver with km + proof attachment),
driver UI: big buttons Start / Delivered, km entry, photo proof.
Tests: transitions, constraints, TS-O02 server side (multiple offline trips, unique numbers), driver scope.
Next: WP-09.2.

### WP-09.2 — Trip expenses and costing
Size M · Haiku: yes (expense link UI)
Context: DATA_MODEL §11 trip_expense; DATA_MODEL §10 fuel_entry, driver_payable.
Tasks: link/unlink expenses (diesel/toll/parking/allowance/other, incl. FROM_ADVANCE); trip cost domain function (direct
expenses + driver trip pay per pay rule; depreciation excluded or ESTIMATE per OD-012); on CLOSE create driver payable accrual
via drivers service (OD-022 provisional).
Tests: costing maths; close idempotent; expense linked to one trip only.
Next: WP-09.3.

### WP-09.3 — External trips: invoice-ready queue and Tally invoice link
Size M · Haiku: no
Context: BR-024, ADR-024; INTERFACES `/trips/invoice-queue`, `/trips/:id/link-invoice`; DATA_MODEL §4 tally_voucher.
Tasks: queue of CLOSED EXTERNAL trips with invoice_status PENDING; invoice data sheet (PDF/print) labelled
"NOT A TAX INVOICE — data for preparing the invoice in Tally"; link endpoint: voucher must be imported, base_type SALES,
not cancelled/deleted, not linked to another trip, party ledger matching trip customer's tally ledger (warn + accountant override
with reason if not); suggestions by customer/date/amount; status LINKED; unlink with reason (audited); voucher later deleted in
Tally → trip flagged REQUIRES_RECONCILIATION.
Tests: TS-A05 (link unique, wrong base type rejected, deleted voucher flags trip).
Next: WP-09.4.

### WP-09.4 — Internal trips: cost allocation
Size M · Haiku: no
Context: BR-025, ADR-023; DATA_MODEL §11 cost_allocation; OD-019.
Tasks: monthly job + on-demand recompute: for CLOSED INTERNAL trips compute allocation rows (basis configurable; provisional actual
cost to MEAT); idempotent per (trip, period); never creates financial events or revenue.
Tests: TS-A04 (internal trip → allocation row, zero events, zero revenue; recompute idempotent).
Next: WP-09.5.

### WP-09.5 — Profitability views, screens, Phase 09 gate
Size M · Haiku: yes (list/report screens)
Tasks: `v_trip_profitability` (external: charges − cost; internal: cost only), vehicle-wise trip summary, dispatcher screens
(plan/assign trips), invoice queue screen. Full gate; STATUS next WP-11.1.

## E. Phase acceptance criteria
Trips captured offline by drivers; external trips reach the invoice queue and link to exactly one Tally sales voucher; internal
trips only produce management allocations.

## F. Verification commands
`pnpm --filter api test:integration && pnpm test && pnpm --filter web e2e && pnpm lint && pnpm typecheck`

## G. Completion requirements
Protocol Step 6.

## H. Failure handling
If GST on freight (OD-010) affects invoice data, show amounts pre-tax with "tax per Tally" note; do not compute tax.
