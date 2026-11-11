# PHASE-06 — Meat Trading and Inventory

## A. Identity
- Objective: parties, product master (FROZEN/FRESH), UoM, locations, lots, stock movements, Tally sales/purchase line
  assignment without duplication, processing, expiry/wastage/spoilage/returns, stock counts, inventory reports.
- Assigned model: Sonnet. Haiku-eligible tasks marked.
- Prerequisites: Phase 05 gate (05.7 may be BLOCKED). Provisional OD-040, OD-011, OD-044 assumptions allowed (test data only).
- Requirements: BR-003, BR-021, BR-120. Docs: DATA_MODEL §6–7; INTERFACES §2 parties/inventory rows; SYNC_DESIGN §2.3.

## B. Context rules
STATUS.md → registry → this WP → Context only. Do not load Tally agent code; use `tally` module service interface only.

## C/D. Phase-wide requirements
Quantities NUMERIC(14,3) in base UoM; conversions explicit; movements immutable once POSTED; write-offs require approval
(uses a simple inventory-local approval until Phase 10's generic engine exists — then migrated in WP-10.3, noted there);
Tally-sourced data read-only; scopes DIVISION=MEAT. Never create sales/purchase invoices.

---

### WP-06.1 — Parties and product master
Size M · Haiku: yes (CRUD screens/tests after first entity)
Context: DATA_MODEL §6, §7 (category, uom, product, location); INTERFACES parties/inventory master rows.
Modify: migration `0006_inventory_master.sql`, `apps/api/src/modules/parties/**`, `modules/inventory/master/**`, contracts, web features.
Tasks: party API — the `party` table already exists from WP-05.2 migration (do not recreate; extend with a new
migration only if a column is missing) — Tally fields read-only, link ERP party ↔ tally ledger; categories with FROZEN/FRESH roots; UoM + conversions;
products (SKU unique, link to tally stock item, lot_tracked default per OD-040 provisional); locations; reference sync
registration (scope=reference) for product/uom/location/party-lite.
Acceptance: CRUD + validation + permission tests; tally-linked fields cannot be edited via API.
Next: WP-06.2.

### WP-06.2 — Lots and stock movements
Size L · Haiku: no
Context: DATA_MODEL §7 (lot, movement, views); SYNC_DESIGN §2.3.
Modify: migration `0007_stock.sql`, `modules/inventory/stock/**`, `packages/domain/src/stock.ts`.
Tasks: lot create/lookup; movement service (types per DATA_MODEL), sign rules by type, immutability trigger after POSTED;
write-off approval flow (local); `v_stock_balance`, `v_stock_expiring`; negative-stock guard (configurable: block or warn, default block);
offline registration for stock_movement drafts; domain tests for sign rules and balance maths.
Acceptance: tests for each movement type, immutability, approval, no negative balance.
Next: WP-06.3.

### WP-06.3 — Tally sales/purchase line assignment (no duplication)
Size M · Haiku: no
Context: DATA_MODEL §4 tally_voucher_inventory_line, §7 movement unique index; SYNC_DESIGN §5 step 3.
Modify: `modules/inventory/tally-lines/**`, hook registration `tally.onVouchersImported`.
Tasks: on import, queue unassigned inventory lines (SALES → ISSUE_SALE, PURCHASE → RECEIPT_PURCHASE, credit/debit notes → RETURN_IN/OUT);
map tally stock item → product (unmapped list); assignment endpoint choosing lot/location (FIFO-by-expiry suggestion for issues);
unique (voucher guid, line) prevents double movements; voucher later altered/deleted in Tally → flag movement REQUIRES_RECONCILIATION
(never auto-delete).
Tests: TS-A10 (re-import same voucher twice → one movement), altered voucher flagging, unmapped stock item listing.
Next: WP-06.4.

### WP-06.4 — Processing, expiry, wastage, returns, counts
Size L · Haiku: yes (count sheet UI after pattern)
Context: DATA_MODEL §7 processing_batch, stock_count; OD-044 provisional.
Modify: `modules/inventory/processing/**`, `counts/**`, web features.
Tasks: processing batch (consume inputs, produce outputs, yield %); expiry write-off job suggestions (daily, notification);
wastage/spoilage with reason + photo; returns linked to Tally credit/debit notes when available; stock count → variance →
approval → ADJUST movements. Note in UI: Tally reflection of write-offs pending OD-011/OD-047.
Acceptance: domain tests for yield and variance; integration tests for approval paths.
Next: WP-06.5.

### WP-06.5 — Inventory reports
Size M · Haiku: yes (report table components)
Context: DATA_MODEL §7 views, §13; INTERFACES §6 report envelope.
Modify: `modules/inventory/reports/**`, views migration `0008_inventory_views.sql`.
Tasks: balances by product/lot/location; expiring in N days; movement ledger; wastage summary; valuation (weighted average,
source=ESTIMATE until OD-011 answered); product profitability from imported Tally sales/purchase lines (source=TALLY, as-of).
Acceptance: report envelope with correct source/asOf; numbers verified against fixture data by tests.
Next: WP-06.6.

### WP-06.6 — Web screens and Phase 06 gate
Size M · Haiku: yes. Mobile screens: products, stock balance, receive/issue assignment queue, wastage capture (offline),
processing, counts. Full gate; STATUS next WP-10.1.

## E. Phase acceptance criteria
Inventory reflects Tally sales/purchases exactly once; operational movements approved/immutable; reports labelled by source.

## F. Verification commands
`pnpm --filter api test:integration && pnpm test && pnpm lint && pnpm typecheck && pnpm build`

## G. Completion requirements
Protocol Step 6.

## H. Failure handling
Tally inventory data shape unclear → rely on TALLY_INTEGRATION §8 fixtures; if missing, ESC (do not invent fields).
