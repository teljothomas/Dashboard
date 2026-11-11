# TallyPrime 7.0 Integration Design (v1.0)

State machines and cloud protocol: SYNC_DESIGN.md §3–5. Connector API: INTERFACES.md §5.
This file covers the Tally PC, the agent internals and the Tally protocol.

## 1. Fixed topology

One designated Windows PC, one TallyPrime 7.0 installation, one authoritative company, one agent.
No other PC runs a Tally copy as part of this solution. The PC may be off; nothing in the cloud waits on it.

## 2. Discovery checklist (non-destructive; owner + Sonnet in Phase 00, answers → OPEN_DECISIONS)

Read-only questions/observations. Do not change Tally data, settings or licences while discovering.

| ID | Check | How (non-destructive) | Record in |
|---|---|---|---|
| DC-01 | Which PC is designated; Windows edition/version; who logs in | Owner answer; `winver` screenshot | OD-001 |
| DC-02 | TallyPrime exact version/release | Tally Help > About (screenshot) | OD-002 |
| DC-03 | Licence edition, serial, TSS validity | Tally licence screen (owner reads, no changes) | OD-002 |
| DC-04 | Company name, number, books-from, FY | Gateway > company info (screenshot) | OD-003 |
| DC-05 | Data path and disk free space | Tally company data path display | OD-003 |
| DC-06 | Other PCs holding company copies? which is authoritative? | Owner answer | OD-004 |
| DC-07 | Backup routine and last restore test | Owner answer | OD-005 |
| DC-08 | Test company availability | Owner answer | OD-006 |
| DC-09 | Is Tally HTTP server enabled? port? | Connectivity settings view only | below §3 |
| DC-10 | Windows Firewall inbound rule state for the Tally port | `Get-NetFirewallRule` read-only | §3 |
| DC-11 | Inventory maintained in Tally with stock items? batches/godowns? | Stock summary view | OD-011 |
| DC-12 | Cost centres in use? | Chart of accounts view | OD-017 |
| DC-13 | Existing ledgers for diesel, toll, wages, advances, loans | List of ledgers export (read) | OD-016 |
| DC-14 | Internet reliability and power backup at the PC | Owner answer | risk register |
| DC-15 | .NET runtime/admin rights available to install a Windows service | Owner answer | Phase 05 |

Multiple company copies are never merged automatically; reconciliation is an accountant task (OD-004).

## 3. Tally PC configuration (applied in Phase 05 only with owner approval)

- Enable TallyPrime to act as server on a local port (default 9000) — exact menu path to be confirmed during
  WP-05.1 and written into §8.
- Windows Firewall: explicit inbound **block** rule for that port on all profiles; agent connects to
  `127.0.0.1` only. Agent refuses to start if configured host is not loopback.
- Tally must be running with the authoritative company loaded for sync; agent never starts/closes Tally
  automatically in v1 (optional later: notify user "Open Tally to sync").

## 4. Protocol strategy

- Preferred: TallyPrime 7.0 native JSON over HTTP POST to `http://127.0.0.1:<port>`.
- Fallback: XML envelope (long-standing Tally integration format) only for capabilities JSON does not cover.
- **Nothing about request/response shapes is assumed.** WP-05.1 (spike) must, against official TallyPrime
  7.0 developer documentation and the test company: confirm request headers/body for (a) company info,
  (b) collection export of ledgers/groups/stock items/units/voucher types/cost centres with ALTERID filter,
  (c) voucher export by date range and ALTERID, (d) ledger closing balances, (e) voucher import (create),
  (f) import response (created/errors/last voucher id), (g) whether REMOTEID/GUID can be supplied on import,
  (h) how a voucher can be queried by narration/reference marker, (i) error format for unknown ledger,
  (j) character encoding. Results go in §8 with captured sanitised samples under
  `agent/tests/fixtures/tally/` and the simulator is built to match them exactly.

## 5. Voucher building (cloud side, `tally` module, Phase 11)

Input: `financial_event` + lines + approved `ledger_mapping` + company settings. Output: protocol-neutral
voucher JSON stored in `posting_outbox.voucher_payload` (agent translates to the verified wire format).

| Event type | Default voucher type (OD-020) | Lines |
|---|---|---|
| EXPENSE_PAYMENT | ERP Payment | Dr expense key(s) / Cr CASH.MAIN or BANK.CURRENT |
| EXPENSE_CREDIT | ERP Journal | Dr expense / Cr PAY.PARTY |
| ADVANCE_ISSUE | ERP Payment | Dr ADV.DRIVER/WORKER / Cr cash or bank |
| ADVANCE_SETTLEMENT | ERP Journal | Dr expenses, Dr cash returned, Dr PAY recovery / Cr ADV (+ Cr cash if reimbursed) |
| WAGE_ACCRUAL | ERP Journal | Dr WAGES.EXPENSE / Cr PAY.WORKER (OD-021) |
| WAGE_PAYMENT | ERP Payment | Dr PAY.WORKER / Cr cash or bank; advance recovery: Cr ADV.WORKER |
| DRIVER_PAY_ACCRUAL / DRIVER_PAYMENT | ERP Journal / ERP Payment | per OD-022 |
| LOAN_EMI | ERP Payment | Dr LOAN.PRINCIPAL, Dr LOAN.INTEREST / Cr BANK.CURRENT |
| LEASE_PAYMENT | ERP Payment | per lease_treatment (OD-015) |
| REVERSAL | same type as original | mirror lines, narration "Reversal of <original marker>" |

Fields: date = voucher_date; narration = `<human narration> [ERP:<event_uuid>]`; reference = `ERP-<first 8
of uuid>-<event no>`; cost centre allocation per line division when OD-017 = yes; amounts exact 2 dp;
voucher must balance; ledger names taken from the mirror at build time and re-validated by the agent
against Tally before sending. GST lines: none until OD-010 is answered.

## 6. Agent design (.NET 10, `agent/`)

Projects: `Core` (state machine, journal, cloud client, signing), `Tally` (protocol client: JSON + XML
fallback, parsers), `Service` (Windows Service host, scheduling), `tools/TallySimulator` (HTTP fake built
from verified fixtures), `tests` (xUnit).

Main loop (every 60 s when idle, immediately after events):
1. Ensure registration (keys in DPAPI LocalMachine-protected file under `%ProgramData%\TradeXAgent\`).
2. Acquire/renew lease; heartbeat every 30 s on its own timer.
3. Probe Tally (`127.0.0.1:port` reachable, version, loaded company). Verify company with cloud
   (`/company/verify`). Mismatch ⇒ stop work, alert, keep heartbeating.
4. Journal recovery: any local row not ACKED ⇒ verification flow (§7) before new work.
5. Import: masters → vouchers → balances (SYNC_DESIGN §5).
6. Posting: if postingMode allows, claim ≤ 10, post sequentially (§7).
7. Uncertain verification for cloud-reported UNCERTAIN items.

SQLite journal `journal.db` (WAL, synchronous=FULL):
- `post_journal(outbox_id, attempt_no, marker, payload_sha256, state, tally_response, created_at, updated_at)`,
  states `INTENT` → `SENT` → `RESPONDED` → `REPORTED` (cloud acknowledged).
- `import_journal(batch_id, stream, from_alter, to_alter, state, payload_path)` for resend after network loss.
- `kv(key, value)` for config hash, last company fingerprint.

Config `%ProgramData%\TradeXAgent\appsettings.json` (no secrets): cloud base URL, Tally port, intervals.
Secrets: private key only, DPAPI LocalMachine + ACL restricted to service account and Administrators.
Service: auto-start (delayed), recovery = restart after 1 min ×3. Install/uninstall/upgrade by signed
PowerShell scripts in `agent/deploy/`. Logs: Serilog rolling files 7 days + Windows Event Log (errors).
`TradeXAgent.exe status` prints lease, last heartbeat, journal counts, last error.

## 7. Posting and recovery algorithm (agent)

```
for item in claimed:
  if journal has row for item (any attempt) and state != REPORTED: goto VERIFY
  ledgers = validate all ledger names exist in Tally (read); missing -> report REJECTED(MAPPING_STALE)
  if find_by_marker(item.marker) -> report ALREADY_EXISTS(+guid); continue      # pre-send check
  journal INTENT (fsync)
  send import request; journal SENT (fsync) immediately before network write
  on response: journal RESPONDED with parsed result
     created  -> re-query by marker; found -> report CREATED+VERIFIED(guid, masterId, number)
                                      not found -> report UNCERTAIN
     error    -> re-query by marker; not found -> report REJECTED(errorCode, excerpt)
                                      found -> report CREATED+VERIFIED
  on timeout/transport error after SENT -> report UNCERTAIN
  on connection refused before any byte sent (state INTENT) -> report FAILED_RETRYABLE
  cloud ack -> journal REPORTED; if cloud unreachable keep row, resend result later (idempotent)
VERIFY(item): find_by_marker over the voucher date ± 7 days (then whole FY if not found)
  found -> POSTED_VERIFIED; absent and company verified -> report verify-result found=false (cloud -> READY)
```
Never send the same outbox item twice without a VERIFY that proved absence. Never alter or delete vouchers
in Tally in v1 (reversals are new vouchers).

## 8. Verified protocol (filled by WP-05.1 spike — EMPTY until verified)

| Capability | Verified request | Verified response notes | Date | Evidence file |
|---|---|---|---|---|
| (none yet) | | | | |

## 9. Test environments

- Automated: TallySimulator (built from §8 fixtures) — runs in CI on Windows runner or locally.
- Integration acceptance: non-production test company on the designated PC (or a separate PC with
  TallyPrime in a mode permitted by the licence) — OD-006. Posting mode TEST_ONLY.
- Production posting: only after Phase 15 owner approval (`owner_approval.kind = PRODUCTION_POSTING_ENABLE`).

## 10. Never

Create/alter/delete ledgers or masters; expose the port; post without marker; mark posted without re-query;
resubmit after uncertainty without verification; rely on number+date+amount for duplicate detection;
store keys unencrypted; run two agents for one company; touch a company whose fingerprint does not match.
