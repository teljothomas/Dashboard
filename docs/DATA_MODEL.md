# Data Model (conceptual schema v1.0)

Conventions (apply to every table unless stated):
- PK `id uuid` (v7). Standard columns `created_at timestamptz, created_by uuid, updated_at, updated_by, version int`.
- Money `NUMERIC(18,2)`, qty `NUMERIC(14,3)`, rate `NUMERIC(18,4)`, business date `date`.
- Enums as PostgreSQL `text` + `CHECK` constraint (easier migration than `CREATE TYPE`).
- FKs `ON DELETE RESTRICT`. Master data soft-deleted via `archived_at`.
- `[OFF]` = may be created offline (client-generated id, `device_id`, `client_created_at` columns).
- `[IMM]` = immutable after a lock condition; enforced by trigger `forbid_update_when_locked()`.
- `[TALLY]` = written only by the import pipeline; app role has SELECT only via API.
- Every `[OFF]` table and every reference table synced to devices also has `sync_seq bigint` set by trigger
  `assign_sync_seq` from the global sequence `sync_seq_global` on insert/update (pull cursor, SYNC_DESIGN §1).
Migration owners are the phases listed; a phase must not alter another module's tables without an
Opus-approved note in DECISIONS.md.

## 1. Core (Phase 03)

- `division` — code (`MEAT`,`LOGISTICS`) unique, name. Seeded, not user-editable.
- `app_setting` — key pk, value jsonb, updated_by. (financial-year start, stale threshold hours, etc.)
- `number_sequence` — (name, fiscal_year) pk, next_value bigint. Assigned via `UPDATE … RETURNING` in tx.
- `attachment` — sha256 char(64), mime, size_bytes ≤ 10 MB, storage_key, original_name, uploaded_by,
  device_id, scanned_ok bool. Unique (sha256) → re-upload returns existing id.
- `attachment_link` — attachment_id, entity_type, entity_id, role (`BILL`,`PROOF`,`DOC`,`PHOTO`). Unique triple.
- `audit_log` — id bigserial, at, actor_user_id, actor_agent_id, device_id, request_id, action, entity_type,
  entity_id, before jsonb, after jsonb, ip. App DB role: INSERT+SELECT only.
- `job` — kind, payload jsonb, status (`QUEUED`,`RUNNING`,`DONE`,`FAILED`,`DEAD`), run_at, attempts,
  max_attempts, last_error, locked_by, locked_until. Index (status, run_at).
- `owner_approval` — kind (`PRODUCTION_POSTING_ENABLE`,`PRODUCTION_DEPLOY`,`LEDGER_MAPPING_PUBLISH`,
  `DATA_IMPORT`, …), subject jsonb, approved_by, approved_at, note. Append-only.
- `notification` — user_id/role target, kind (`DOC_EXPIRY`,`EMI_DUE`,`SYNC_FAILED`,`APPROVAL_PENDING`,…),
  entity ref, due_at, read_at.

## 2. Identity (Phase 04)

- `app_user` — username unique (lowercase), display_name, phone, password_hash (argon2id), status
  (`ACTIVE`,`DISABLED`,`LOCKED`), failed_logins, locked_until, must_change_password, last_login_at.
- `role` — code unique, name, is_system. System roles: OWNER, ADMIN, ACCOUNTANT, FACTORY_MANAGER, SUPERVISOR, DRIVER.
- `permission` — code pk (e.g. `expense.create`, `expense.approve`, `report.financial.view`). Catalogue in INTERFACES §3.
- `role_permission` — role_id, permission_code, scope (`OWN`,`DIVISION`,`ALL`).
- `user_role` — user_id, role_id, division_id nullable (scope limiter).
- `session` — token_hash char(64) unique, user_id, device_id, created_at, last_seen_at, expires_at,
  absolute_expires_at, revoked_at, user_agent, ip.
- `password_reset` — user_id, code_hash, expires_at (30 min), used_at, issued_by.
- `device` — id (client uuid), user_id, label, platform, first_seen_at, last_sync_at, revoked_at.
- `login_attempt` — username, ip, at, success (for rate limiting/forensics; 90-day retention).

## 3. Offline sync (Phase 03, hardened 12)

- `client_mutation` — mutation_id uuid pk, device_id, user_id, entity_type, entity_id, op (`CREATE`,`UPDATE`,
  `SUBMIT`,`CANCEL`), base_version, received_at, result (`APPLIED`,`CONFLICT`,`REJECTED`), result_body jsonb.
  Replaying a known mutation_id returns stored result (idempotent).
- `sync_conflict` — entity_type, entity_id, device_id, user_id, base_version, server_version,
  client_payload jsonb, server_snapshot jsonb, status (`OPEN`,`RESOLVED_KEEP_SERVER`,`RESOLVED_APPLY_CLIENT`,
  `RESOLVED_MERGED`), resolved_by, resolved_at, note.

## 4. Tally mirror and connector (Phase 05; posting tables Phase 11)

- `tally_company` — display_name, tally_name, company_number, books_from, fy_start_month, fingerprint
  char(64) = sha256(normalised name|number|books_from|guid-if-available), is_test bool, posting_mode
  (`DISABLED`,`TEST_ONLY`,`PRODUCTION`), production_approval_id → owner_approval.
- `connector_registration_code` — company_id, code_hash, expires_at (15 min), used_at, created_by.
- `connector_agent` — company_id, machine_name, machine_fingerprint, public_key (ECDSA P-256 SPKI PEM),
  agent_version, status (`ACTIVE`,`REVOKED`), registered_at, last_seen_at, last_status jsonb.
- `connector_lease` — company_id pk, agent_id, epoch bigint (increments on every acquisition by a new
  holder), acquired_at, renewed_at, expires_at.
- `connector_heartbeat` — agent_id, at, tally_reachable, company_match, tally_version, local_queue, error.
  Retention 30 days.
- `connector_nonce` — agent_id, nonce, at. Unique (agent_id, nonce); purged after 10 min (replay guard).
- `sync_watermark` — (company_id, stream) pk, stream (`MASTERS`,`VOUCHERS`,`BALANCES`), last_alter_id bigint,
  last_success_at, last_full_recon_at.
- `import_batch` — id (agent uuid, idempotent), company_id, agent_id, epoch, stream, from_alter_id,
  to_alter_id, record_count, payload_sha256, status (`RECEIVED`,`APPLIED`,`REJECTED`), error, received_at, applied_at.
- `[TALLY]` masters: `tally_group`, `tally_ledger` (guid, name, parent_group, is_party, gstin, alter_id,
  opening_balance, archived_in_tally), `tally_stock_item`, `tally_unit`, `tally_voucher_type`,
  `tally_cost_centre`. Unique (company_id, guid) on each.
- `[TALLY]` `tally_voucher` — company_id, guid, master_id, alter_id, voucher_type_name, base_type
  (`SALES`,`PURCHASE`,`RECEIPT`,`PAYMENT`,`JOURNAL`,`CONTRA`,`CREDIT_NOTE`,`DEBIT_NOTE`,`OTHER`),
  voucher_number, voucher_date, reference, party_ledger_guid, narration, amount, is_cancelled,
  is_deleted_in_tally, erp_event_id (parsed from narration marker), last_import_batch_id.
  Unique (company_id, guid).
- `[TALLY]` `tally_voucher_ledger_line` (ledger_guid, amount signed, is_party, cost_centre allocations jsonb),
  `tally_voucher_inventory_line` (stock_item_guid, qty, uom, rate, amount, batch_name, godown).
- `[TALLY]` `tally_balance_snapshot` — company_id, ledger_guid, as_of, closing_balance. (Cash/bank/outstanding.)
- `ledger_mapping` — company_id, posting_key (exact) unique per company, tally_ledger_guid, tally_ledger_name
  (cached), cost_centre_guid nullable, status (`DRAFT`,`APPROVED`), approved_by, approved_at.
  Must reference an existing imported `tally_ledger`. Never creates ledgers.
- `posting_outbox` (Phase 11; created empty in Phase 10 so modules can enqueue) — financial_event_id unique,
  company_id, status (SYNC_DESIGN §3), voucher_payload jsonb, payload_sha256, attempt_count, next_attempt_at,
  last_attempt_at, last_error_code, last_error, claimed_agent_id, claimed_epoch, claim_expires_at,
  tally_guid, tally_master_id, tally_voucher_number, verified_at.
- `posting_attempt` — outbox_id, attempt_no, agent_id, epoch, started_at, finished_at, outcome (`CREATED`,
  `ALREADY_EXISTS`,`REJECTED`,`TIMEOUT`,`TRANSPORT_ERROR`,`VERIFIED`,`VERIFY_NOT_FOUND`), response_excerpt (≤2 KB).

## 5. Ledger core — financial events (Phase 10)

- `financial_event` `[IMM]` — event_type (`EXPENSE_PAYMENT`,`EXPENSE_CREDIT`,`ADVANCE_ISSUE`,
  `ADVANCE_SETTLEMENT`,`WAGE_ACCRUAL`,`WAGE_PAYMENT`,`DRIVER_PAY_ACCRUAL`,`DRIVER_PAYMENT`,`LOAN_EMI`,
  `LEASE_PAYMENT`,`REVERSAL`), source_entity, source_id, source_seq int default 1, voucher_date,
  narration, total_amount, company_id, reverses_event_id, replaces_event_id, posting_status (mirror of
  outbox, the ONLY mutable column), created_by, approved_by.
  Unique (source_entity, source_id, event_type, source_seq) — a source can never produce two events of one kind.
- `financial_event_line` `[IMM]` — event_id, line_no, posting_key, dr_cr (`DR`,`CR`), amount > 0,
  division_id, memo. Deferred constraint trigger: Σ DR = Σ CR per event, ≥ 2 lines.
- Posting keys: `<CLASS>.<CODE>[:<subject uuid>]`. Classes: `EXP` (expense category code), `CASH` (`CASH.MAIN`),
  `BANK` (`BANK.CURRENT`), `ADV.DRIVER:<driver_id>`, `ADV.WORKER:<worker_id>`, `PAY.DRIVER:<id>`,
  `PAY.WORKER:<id>`, `PAY.PARTY:<party_id>`, `LOAN.PRINCIPAL:<agreement_id>`, `LOAN.INTEREST`,
  `LEASE.<code>:<agreement_id>`, `WAGES.EXPENSE`, `DRIVER.SALARY`, `DRIVER.TRIPPAY`.

## 6. Parties (Phase 06)

- `party` — name, kinds text[] (`CUSTOMER`,`SUPPLIER`,`TRANSPORT_CUSTOMER`,`LENDER`,`LESSOR`,`VENDOR`),
  phone, gstin, address, tally_ledger_guid nullable unique, source (`TALLY`,`ERP`), archived_at.
  Tally parties auto-upsert from import; ERP-created parties may later be linked to a Tally ledger.

## 7. Inventory (Phase 06)

- `product_category` — code (`FROZEN`,`FRESH`, sub-categories with parent_id).
- `uom` — code (`KG`,`G`,`BOX`,`CTN`,`PCS`), decimals, tally_unit_guid.
- `uom_conversion` — product_id nullable, from_uom, to_uom, factor rate.
- `product` — sku unique, name, category_id, base_uom, lot_tracked, shelf_life_days, storage_temp
  (`FROZEN`,`CHILLED`,`AMBIENT`), tally_stock_item_guid unique nullable, archived_at.
- `stock_location` — code, name, kind (`COLD_STORE`,`CHILLER`,`PROCESSING`,`DISPATCH`,`IN_TRANSIT`).
- `stock_lot` — product_id, lot_code, received_date, expiry_date, supplier_party_id, source_tally_voucher_guid.
  Unique (product_id, lot_code).
- `stock_movement` `[OFF]` `[IMM after status=POSTED]` — movement_type (`RECEIPT_PURCHASE`,`ISSUE_SALE`,
  `PROCESS_CONSUME`,`PROCESS_OUTPUT`,`TRANSFER_OUT`,`TRANSFER_IN`,`WASTAGE`,`SPOILAGE`,`EXPIRY_WRITE_OFF`,
  `RETURN_IN`,`RETURN_OUT`,`ADJUST_PLUS`,`ADJUST_MINUS`,`OPENING`), movement_date, product_id, lot_id,
  location_id, qty (signed, base uom), unit_cost nullable, source_tally_voucher_guid + source_line_no,
  processing_batch_id, stock_count_id, reason, status (`DRAFT`,`PENDING_APPROVAL`,`POSTED`,`REJECTED`).
  Unique (source_tally_voucher_guid, source_line_no) where not null — Tally lines never duplicate.
  Write-offs (WASTAGE/SPOILAGE/EXPIRY/ADJUST_*) need approval. Whether they also post to Tally: OD-011/OD-047.
- `processing_batch` `[OFF]` — batch_no, date, input/output via movements, yield_pct computed, notes.
- `stock_count` / `stock_count_line` — counted_qty vs system_qty, variance; approval creates ADJUST movements.
- View `v_stock_balance` (product, lot, location, qty), `v_stock_expiring`.

## 8. Expenses, approvals, advances (Phase 10)

- `expense_category` — code unique, name, group (`FACTORY`,`LABOUR`,`VEHICLE`,`TRIP`,`ADMIN`,`OTHER`),
  default_division_id, posting_key (`EXP.<code>`), attachment_required_above money, needs_vehicle bool, archived_at.
- `expense` `[OFF]` `[IMM after APPROVED]` — expense_no (server), category_id, division_id, expense_date,
  amount, payment_mode (`CASH`,`UPI`,`BANK`,`CREDIT`,`FROM_ADVANCE`), paid_from_key (`CASH.MAIN`/`BANK.CURRENT`),
  advance_id (when FROM_ADVANCE), payee_party_id, payee_text, description, vehicle_id, trip_id,
  status (`DRAFT`,`SUBMITTED`,`APPROVED`,`REJECTED`,`CANCELLED`), dedupe_fingerprint, duplicate_ack_by,
  financial_event_id, device_id, client_created_at.
  FROM_ADVANCE expenses never create their own event; they are consumed by an advance settlement.
- `approval_policy` — entity_type, category_id nullable, max_amount, required_permission, division_id.
- `approval_request` — entity_type, entity_id, status (`PENDING`,`APPROVED`,`REJECTED`), requested_by,
  decided_by, decided_at, comment. History = audit_log. Self-approval forbidden unless role OWNER.
- `advance` `[OFF create]` — advance_no, payee_kind (`DRIVER`,`WORKER`), driver_id / worker_id, issue_date,
  amount, mode (`CASH`,`UPI`,`BANK`), purpose, trip_id, status (`DRAFT`,`SUBMITTED`,`APPROVED`=issued,
  `PARTIALLY_SETTLED`,`SETTLED`,`REJECTED`), outstanding (maintained in tx), financial_event_id (ADVANCE_ISSUE).
- `advance_settlement` — advance_id, settlement_date, expenses_total, cash_returned, payroll_recovery,
  reimbursed_to_payee, status (`DRAFT`,`SUBMITTED`,`APPROVED`), financial_event_id.
  Check: expenses_total + cash_returned + payroll_recovery − reimbursed_to_payee ≤ outstanding.
- `advance_settlement_expense` — settlement_id, expense_id unique (an expense settles once).
  Worked example (BR-026): Dr EXP.DIESEL 3500, Dr EXP.TOLL 500, Dr EXP.PARKING 200, Dr CASH.MAIN 800,
  Cr ADV.DRIVER:<id> 5000.

## 9. Factory and labour (Phase 07)

- `factory` — single row: name, address, rent_amount, landlord_party_id, power_consumer_no, notes.
- `factory_log` `[OFF]` — log_date, kind (`TEMPERATURE`,`SANITATION`,`MAINTENANCE`,`INCIDENT`,`METER_READING`),
  values jsonb (schema per kind in contracts), recorded_by.
- `worker` — code, name, phone, worker_type (`DAILY`,`MONTHLY`), joined_on, left_on, payment_pref, archived_at.
- `wage_rate` — worker_id, effective_from, daily_rate, monthly_salary, ot_hourly_rate. Unique (worker_id, effective_from).
- `attendance` `[OFF]` — worker_id, att_date, status (`PRESENT`,`ABSENT`,`HALF_DAY`,`LEAVE`,`HOLIDAY`),
  ot_hours NUMERIC(5,2), recorded_by, device_id. Unique (worker_id, att_date) → conflicting second entry
  becomes `sync_conflict`, never overwrite. Locked once its wage_period is APPROVED.
- `wage_period` — period_month (first day), status (`OPEN`,`CALCULATED`,`APPROVED`,`PAID`,`LOCKED`).
- `wage_sheet_line` `[IMM after APPROVED]` — period_id, worker_id, days_present, half_days, ot_hours, gross,
  advance_recovery, other_deductions, net, calc_snapshot jsonb (rates + inputs used).
- `deduction` — worker_id, period_id, kind, amount, reason, approved_by.
- `wage_payment` — wage_sheet_line_id, paid_date, amount, mode, financial_event_id (WAGE_PAYMENT).

## 10. Fleet, drivers, finance (Phase 08)

- `vehicle` — reg_no unique, kind (`REEFER`,`NORMAL`), make_model, capacity_kg, ownership (`OWNED`,`LOAN`,
  `LEASE`), finance_agreement_id, odometer_km, status (`ACTIVE`,`IN_REPAIR`,`SOLD`).
- `reefer_unit` — vehicle_id, make, serial, last_service_on.
- `vehicle_document` — vehicle_id, doc_type (`RC`,`INSURANCE`,`PERMIT`,`FITNESS`,`PUC`,`ROAD_TAX`),
  number, valid_from, valid_to, attachment links. Expiry reminders 30/15/7/0 days.
- `service_schedule` — vehicle_id, service_type, interval_km, interval_days, last_done_km, last_done_on.
- `service_record` `[OFF]` — vehicle_id, service_date, odometer_km, vendor_party_id, description, expense_id.
- `tyre` — vehicle_id, serial, position, fitted_on, fitted_km, removed_on, removed_km.
- `fuel_entry` `[OFF]` — vehicle_id, trip_id, fuel_date, litres NUMERIC(10,3), rate, amount, odometer_km,
  full_tank, expense_id (fuel is an expense; this row holds the operational data).
- `downtime` — vehicle_id, from_at, to_at, reason.
- `driver` — code, name, phone, user_id unique nullable, licence_no, licence_valid_to, archived_at.
- `driver_document` — driver_id, doc_type, number, valid_to.
- `driver_pay_rule` — driver_id, effective_from, monthly_salary, per_trip_amount, per_km_rate, daily_allowance.
- `driver_payable` — driver_id, source (`TRIP`,`SALARY`,`ALLOWANCE`), source_id, amount, period, status
  (`ACCRUED`,`PAID`), financial_event_id. Treatment per OD-022.
- `finance_agreement` — kind (`LOAN`,`LEASE`), lender_party_id, reference, vehicle_id, principal, annual_rate,
  tenure_months, emi_amount, start_date, end_date, lease_treatment (`EXPENSE`,`ROU_ASSET`; OD-015), status.
- `finance_schedule_line` — agreement_id, installment_no, due_date, principal_part, interest_part, total,
  status (`DUE`,`PAID`,`PARTIAL`,`OVERDUE`). Source: lender schedule entered/uploaded (OD-014), validated so
  Σ principal = principal.
- `finance_payment` — schedule_line_id, paid_date, amount, principal_part, interest_part, mode, financial_event_id.

## 11. Trips (Phase 09)

- `trip` `[OFF]` — trip_no (server), trip_date, kind (`INTERNAL`,`EXTERNAL`), customer_party_id (required
  iff EXTERNAL), vehicle_id, driver_id, origin, destination, route, start_km, end_km, distance_km
  (generated), cargo_desc, cargo_qty_kg, charges (EXTERNAL only; CHECK charges IS NULL when INTERNAL),
  status (`PLANNED`,`STARTED`,`DELIVERED`,`CLOSED`,`CANCELLED`), delivery_note, invoice_status
  (`NOT_APPLICABLE`,`PENDING`,`LINKED`), tally_invoice_guid, closed_at.
  INTERNAL ⇒ invoice_status = NOT_APPLICABLE (CHECK).
- `trip_expense` — trip_id, expense_id unique.
- `cost_allocation` — source_type (`TRIP`), source_id, from_division_id, to_division_id, period_month, amount,
  basis (OD-019), computed_at. Management only; never a financial event.
- View `v_trip_profitability` (charges − direct expenses − driver trip pay; estimate flag for depreciation).

## 12. Reconciliation (Phase 13)

- `bank_statement_import` — attachment_id, account_key, period_from, period_to, row_count, status.
- `bank_statement_line` — import_id, txn_date, description, ref, debit, credit, balance, line_hash unique
  (sha256 of date|amount|ref|description) → duplicate uploads skipped.
- `recon_match` — statement_line_id, tally_voucher_guid, match_type (`AUTO`,`MANUAL`), score, matched_by, unmatched_reason.
- `cash_count` — count_date, counted_amount, denominations jsonb, tally_cash_balance, tally_as_of, variance, note.

## 13. Reporting views (Phase 13)

`rpt_division_pnl_mgmt`, `rpt_expense_analysis`, `rpt_vehicle_profitability`, `rpt_trip_comparison`,
`rpt_fuel_efficiency`, `rpt_labour_cost`, `rpt_driver_statement`, `rpt_emi_forecast`, `rpt_outstanding`
(from tally_balance_snapshot + vouchers), `rpt_inventory_valuation`, `rpt_sync_health`. Each view exposes a
`source` column (`TALLY`,`ERP_MANAGEMENT`,`ESTIMATE`) and, for Tally data, `as_of`.

## 14. Integrity checklist (enforced in migrations)

FKs everywhere; CHECK amount > 0 on money lines; balanced-event trigger; immutability triggers on
`[IMM]` tables; unique constraints listed above; partial unique indexes for Tally source lines;
`audit_log` privileges; app DB role has no DDL rights; migration role separate.
