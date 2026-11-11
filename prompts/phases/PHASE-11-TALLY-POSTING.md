# PHASE-11 — ERP-to-Tally Financial Posting

## A. Identity
- Objective: ledger mapping, voucher building, outbox processing, agent posting with verification, uncertain-ack recovery,
  altered-in-Tally detection, reversal posting, admin UI — proven against the simulator and a TEST company.
- Assigned model: Sonnet. **Opus critical review REV-11 mandatory** (WP-11.6). Haiku only for UI lists.
- Prerequisites: Phase 09 gate; Phase 05 complete (05.7 required only for the test-company part of 11.6).
- Hard rule: posting mode PRODUCTION is never enabled in this phase. Only `is_test=true` companies receive vouchers.
- Requirements: BR-022, BR-033. Decisions: ADR-021, 025, 030–035. Docs: SYNC_DESIGN §3, §5–7; TALLY_INTEGRATION §5, §7, §8, §10;
  INTERFACES §5 outbox rows, §2 tally mapping/outbox rows; DATA_MODEL §4 ledger_mapping, posting_*.

## B. Context rules
STATUS.md → registry → this WP → Context only. Module code other than `ledger` and `tally` is out of scope.

## C/D. Phase-wide requirements
Never auto-create ledgers. Never mark POSTED without re-query. Expired claim → UNCERTAIN, never READY. Resubmission only after
verified absence. Every attempt recorded in posting_attempt. All state changes audited and mirrored to financial_event.posting_status.

---

### WP-11.1 — Ledger mapping
Size M · Haiku: yes (mapping list screen after API)
Context: DATA_MODEL §4 ledger_mapping, §5 posting keys; INTERFACES mapping rows; OD-016, OD-017.
Modify: next migration `NNNN_posting.sql` (ledger_mapping; posting tables already exist from 10.1), `modules/tally/mapping/**`, web.
Tasks: list posting keys in use (from events) + catalogue with mapping status; set mapping to an existing mirrored ledger
(search); approve (tally.mapping.approve); for non-test companies approval also requires owner_approval LEDGER_MAPPING_PUBLISH;
mapping changes re-trigger prepare job for BLOCKED_MAPPING items; mapping history in audit.
Tests: cannot map to non-existent/archived ledger; approval rules; re-trigger.
Next: WP-11.2.

### WP-11.2 — Voucher builder and prepare job
Size L · Haiku: no
Context: TALLY_INTEGRATION §5; SYNC_DESIGN §3 rows PENDING/BLOCKED; OD-020 provisional voucher types.
Tasks: builder per event type table (protocol-neutral JSON: voucherType, date, narration with marker, reference, lines with ledger
name+guid, amount, dr/cr, cost centre); validations (balanced, ledgers active, date within company books, mode allows company);
payload sha256; job transitions PENDING→READY/BLOCKED_*; reversal events build mirror vouchers referencing original marker.
Tests: golden-file tests per event type (fixtures reviewed by Opus in 11.6), blocked paths, deterministic payload hash.
Next: WP-11.3.

### WP-11.3 — Cloud outbox protocol
Size L · Haiku: no
Context: INTERFACES §5 outbox rows; SYNC_DESIGN §3–4.
Tasks: claim (lease+epoch+mode checks, FIFO by voucher_date then created_at, ≤10, claim TTL 5 min), result, uncertain list,
verify-result, claim-expiry job → UNCERTAIN, FAILED_RETRYABLE backoff schedule, DEAD after 8, notifications/alerts, mirror status
to financial_event, admin retry/cancel (cancel only when last verify proved absence or never claimed).
Tests: every transition in SYNC_DESIGN §3 table incl. illegal ones rejected; stale epoch rejected; expired claim → UNCERTAIN.
Next: WP-11.4.

### WP-11.4 — Agent posting and recovery
Size L · Haiku: no
Context: TALLY_INTEGRATION §7, §8 (import + query-by-marker rows must be VERIFIED; if not, mark BLOCKED + ESC and stop this WP).
Modify: `agent/src/**` posting components, TallySimulator (import endpoint + faults: reject, timeout after commit, ack lost,
duplicate detection, restart mid-request).
Tasks: implement algorithm §7 exactly; journal transitions with fsync; startup recovery; result resend after network loss;
pre-send ledger existence check and marker check; strict sequential posting.
Tests (simulator): TS-T02, TS-T03, TS-T05, TS-T06, TS-T08, TS-T09, TS-T13 + happy path; each asserts exactly one voucher in simulator state.
Next: WP-11.5.

### WP-11.5 — Altered-in-Tally detection, reversal posting, admin UI
Size M · Haiku: yes (outbox list UI)
Context: SYNC_DESIGN §3 last row, §5 step 5; ADR-025.
Tasks: import hook compares posted payload hash vs imported voucher → ALTERED_IN_TALLY; deleted → same; reconciliation actions
(accept Tally version with note / create reversal); reversal posting path end-to-end; posting dashboard widget (counts by state,
oldest READY age, failures).
Tests: TS-T12 for ERP-posted vouchers; TS-A06 posting path; TS-A07 (duplicate prevention across re-claim and re-import).
Next: WP-11.6.

### WP-11.6 — Failure suite, test-company acceptance, Opus critical review, gate
Size L · Sonnet + Opus REV-11
Tasks:
1. Run full simulator suite (TS-T01..T13 relevant, TS-A06, TS-A07) — all must pass.
2. Test company (requires WP-05.7 done + OD-006; mapping to test ledgers per OD-016 provisional): post one of each event type,
   verify in Tally (owner/accountant screenshot), force ack loss (disconnect network after send) and confirm no duplicate.
   Evidence → `docs/evidence/WP-11.6.md`. If prerequisites missing: mark this part BLOCKED, continue with gate on simulator results.
3. Opus REV-11 over builder, outbox state machine, agent algorithm, journal, golden fixtures. Fix CRITICAL/HIGH.
4. Gate; STATUS next WP-12.1. STATUS OWNER APPROVAL REQUIRED keeps "Production posting enable (Phase 15)".

## E. Phase acceptance criteria
No path can create a duplicate voucher or mark an unverified voucher as posted; every TS-T/TS-A posting test passes on simulator;
test-company evidence recorded (or explicitly BLOCKED); REV-11 approved.

## F. Verification commands
`pnpm --filter api test:integration`, `dotnet test agent/TradeX.TallyAgent.sln`, `pnpm test`, `pnpm lint`, `pnpm typecheck`.

## G. Completion requirements
Protocol Step 6; TALLY_INTEGRATION §8 updated with any live findings.

## H. Failure handling
Any doubt whether a voucher exists in Tally → state UNCERTAIN and verification; never "retry to see". Simulator vs real
differences → real wins; update simulator and re-run full suite.
