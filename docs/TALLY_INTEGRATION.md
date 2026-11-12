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

- Enable TallyPrime to act as server on a local port (default 9000). Documented menu path (WP-05.1,
  DOC_ONLY, not yet seen on the 7.0 test PC; confirm in WP-05.7): Exchange > Data Synchronization >
  Data Synchronization Configuration; set "TallyPrime act as" to Server (or Both), choose the Port, leave
  "Enable ODBC" No. A company must be loaded. Source: https://help.tallysolutions.com/pre-requisites-for-integrations/.
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

Implementation notes (WP-05.3, `agent/`, solution `TradeX.TallyAgent.sln`):
- Projects built so far: `src/TradeX.Agent.Core` (signing, DPAPI key store, cloud client, journal, lease/heartbeat runtime,
  status), `src/TradeX.Agent.Service` (`TradeXAgent.exe`, net10.0-windows, Windows Service host, `run`, `register`, `status`,
  `version`), `tests/TradeX.Agent.Tests` (xUnit v3), `tests/TradeX.Agent.JournalKillHelper` (crash test helper).
  `Tally` and `tools/TallySimulator` arrive with WP-05.4; until then the service uses `NoTallyClientProbe` (Tally always
  unreachable), so a real service never takes the lease. The extension points are `ITallyProbe` and `IAgentWork`.
- Key file ACL: SYSTEM and Administrators full, no inheritance. `install.ps1` adds read for the service account after
  `register`. The key is generated in memory and written only after the cloud accepts the registration.
- Local lease deadline = time the last successful heartbeat was sent + 90 s TTL - 10 s margin (no clock agreement needed);
  work is cancelled by token at that deadline, on LEASE_STALE and on a 401. `HeartbeatSeconds` is limited to 30.
- Journal states beyond section 6: `import_journal.state` is `PREPARED` then `ACKED`. Post states only move forward.
- `register` flags: `register <code> [--cloud <url>]` (writes `appsettings.json` when given). Exit codes: 0 ok, 1 failed,
  2 not configured or not registered, 3 journal corrupt.
- Installed .NET: the agent is framework dependent; the Tally PC needs the .NET 10 Runtime machine-wide.

Implementation notes (WP-05.5, import pipeline, `TradeX.Agent.Tally/Import`):
- `ImportWork : IAgentWork` implements main loop steps 4, 5 and 7 (no posting). It runs only while the lease is held and
  the company verified (the runtime gates that). Order per loop: resend every unacknowledged `import_journal` row, then, if
  due, read Tally, then send, then reconcile.
- Due = first run after start, `ImportIntervalSeconds` (default 300, 30 to 86400) since the last good cycle, or a
  `REFRESH_MASTERS` / `FULL_RECON` command from the heartbeat. Commands are taken off `PendingCommands` once
  (`WorkContext.ConsumeCommand`); the cloud does not queue commands yet (`lease.ts` returns `[]`), so nothing sends them today.
- ALTERID is not used (section 8 b, c NOT VERIFIED). Every cycle exports the whole ledger and voucher collections and
  sends only records whose content hash differs from what the cloud last acknowledged (in memory; empty after a restart,
  so a restart resends everything once, which is idempotent). Alter ids go on the wire as null.
- Read first, send second: masters (optional kinds, then ledgers), vouchers, ledgers again as balances, all from one read.
  Any Tally failure (HTTP error, status not 1, malformed JSON, timeout) abandons the cycle: nothing is sent and no
  reconciliation runs. Exports now throw on status other than 1 instead of returning an empty list, because an empty list
  would make a reconciliation flag every voucher deleted. Optional master kinds (group, unit, stock item, voucher type, cost
  centre) are NOT VERIFIED: a failure on one is logged and that kind is skipped for the cycle.
- Batches of at most 500. Each batch is written to `%ProgramData%\TradeXAgent\import\<batchId>.json` (flushed), journalled
  `PREPARED`, posted, then `ACKED` and the file deleted. A resend rewrites `epoch` to the current lease epoch; the batch id keeps
  it idempotent (the cloud hash ignores the epoch). A stream with nothing new still sends one empty batch: the cloud
  freshness clock (`last_success_at`) only moves on an applied batch.
- Permanent refusals (400, 409 other than lease errors, 422, 413) are logged, the journal row is closed so it cannot block
  later batches, the records are not remembered as sent, and `import.last_error` stays set until a clean cycle. Lease stale,
  lease held, 401 and network failures keep the row `PREPARED`.
- Reconciliation snapshot: on start, then nightly (first cycle at or after 02:00 local, once per local day), and on
  `FULL_RECON`. Routine window = previous and current month; full window = whole financial year from
  `FinancialYearStartMonth` (default 4, the cloud holds `fy_start_month` but the identity does not carry it yet), one request
  with `isFull=true`. Tally's own deleted vouchers are not listed; a voucher with an unreadable date is always listed
  (listing can only prevent a deletion flag). Not journalled: a failed snapshot is rebuilt from a fresh read.
- Mapping limits (confirm in WP-05.7): masters without a guid are keyed `NAME:<KIND>:<name>`; voucher export carries no
  party, cancelled flag or inventory lines, so `partyLedgerName` is the first ledger line whose ledger sits under Sundry
  Debtors or Sundry Creditors (through group parents when the group export works), `isCancelled` is always false and
  `inventoryLines` are not sent; base type follows the voucher type's parent chain, else `OTHER`; balances are sent for
  ledgers under Cash-in-Hand, Bank Accounts, Bank OD A/c, Sundry Debtors, Sundry Creditors; vouchers with more than 200 ledger
  lines or no readable date are skipped and counted in the log. Strings are clipped to the cloud limits so one record cannot
  poison a batch.

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

Status legend: `DOC_ONLY` = taken from official documentation, never run against Tally (WP-05.7 must confirm);
`NOT VERIFIED — do not rely` = nothing documented. Primary source: JSON integration page
https://help.tallysolutions.com/tally-prime-integration-using-json-1/ (updated 2026-05-20) and its five linked payload
samples (voucher import payload/response, voucher collection payload/response, ledger collection payload).
Request shape: HTTP POST to `http://127.0.0.1:<port>`; headers `content-type`, `version: 1`, `tallyrequest`
(Export/Import), `type` (Data/Collection/Object/Function), `id`, optional `detailed-response`; body keys
`static_variables`, `fetchlist`/`fetch_List`, `tdlmessage`, `tallymessage`. `svCurrentCompany` is mandatory in
`static_variables` (without it Tally uses the active company, so the agent must always send it). Use JSONEx
(`svExportFormat` / `svVchImportFormat` = `jsonex`; recommended for new integrations from 7.0). No XML fallback
needed for the rows below that are DOC_ONLY.

| Item | Capability | Status | Verified request | Response notes / consequence | Date | Evidence |
|---|---|---|---|---|---|---|
| (a) | Company info | NOT VERIFIED — do not rely | none documented as a request type | Company identity check (BR-020 fingerprint) cannot rely on a company-info call. Candidate: Company collection or a report export; decide in WP-05.7. `svCurrentCompany` selects the company but returns no identity. | 2026-11-12 | none |
| (b) | Ledger collection export | DOC_ONLY | headers `tallyrequest: export`, `type: collection`, `id: Ledger`; body `fetch_List` Name, Parent, Closing Balance | Stock items also documented (`id: StockItem`). Groups, units, voucher types, cost centres: NOT VERIFIED (likely the same collection pattern, confirm). **ALTERID filter: NOT VERIFIED.** Consequence: incremental master sync cannot assume ALTERID; plan full master re-export plus compare until confirmed. | 2026-11-12 | fixtures/tally/request-ledger-collection.json |
| (c) | Voucher export | DOC_ONLY | `id: TSPLVoucherColl` with a `tdlmessage` collection definition (`Type: Voucher`, `Native Method` list) | Response has `guid`, `remoteid`, `vchkey`, `masterid`, `isdeleted`, `allledgerentries` (amount strings, `isdeemedpositive`). **Date-range and ALTERID filters: NOT VERIFIED.** Consequence: until confirmed, import by re-exporting a date window and diffing by `guid`; the watermark design in SYNC_DESIGN §4 must not depend on ALTERID. | 2026-11-12 | fixtures/tally/request-voucher-collection.json, response-voucher-collection.json |
| (d) | Ledger closing balances | DOC_ONLY | ledger collection with `fetch_List` containing `Closing Balance` | Value format and sign convention not shown in a sample. Parse tolerant, confirm in WP-05.7. | 2026-11-12 | fixtures/tally/request-ledger-collection.json |
| (e) | Voucher import (create) | DOC_ONLY (partial) | headers `tallyrequest: Import`, `type: Data`, `id: Vouchers`; `svVchImportFormat: jsonex`; body `tallymessage` with `metadata {type: Voucher, vchtype, action: Create, objview}` | Documented body is a Sales invoice only. Receipt/Payment/Journal body shape NOT VERIFIED. Blocks Phase 11 design, not Phase 05. | 2026-11-12 | fixtures/tally/request-voucher-import-headers.json |
| (f) | Import response | DOC_ONLY | `detailed-response: Yes` gives counts | `data.import_result`: created, altered, deleted, `lastvchid`, `lastmid`, combined, ignored, errors, cancelled, exceptions, vchnumber. Only counts: no per-voucher error text. Posting verification therefore must re-query (already mandatory). | 2026-11-12 | fixtures/tally/response-voucher-import.json |
| (g) | GUID/REMOTEID supplied on import | NOT VERIFIED — do not rely | none | Neither term appears in the documented import sample. Export returns `guid` and `remoteid`. Consequence: the ERP cannot assume it chooses the voucher GUID; marker in narration remains the identity (ADR-031) and the agent must capture the GUID by re-query after posting. | 2026-11-12 | none |
| (h) | Query voucher by narration/reference marker | NOT VERIFIED — do not rely | none | No documented filter in the collection sample, and the sample export carries no narration key. Fallback: export the voucher collection with `Narration` as a native method (undocumented, confirm) and match `[ERP:<uuid>]` client-side. **If narration cannot be exported, an alternative identity strategy needs an Opus decision before Phase 11 (ESC then).** Confirm first in WP-05.7. | 2026-11-12 | none |
| (i) | Unknown-ledger error format | NOT VERIFIED — do not rely | none | Only `status` "1"/"0" and the `errors` counter are documented. Treat any `errors > 0` or `status != "1"` as failure and re-query. | 2026-11-12 | none |
| (j) | Encoding | DOC_ONLY | `content-type: application/json;charset=utf-8` (ASCII/UTF-8 with BOM) or `;charset=utf-16` (UTF-16 LE BOM) | Tally replies in UTF-16 only when a charset is specified; the charset must match the real payload. Plain `application/json` needs no charset. Agent: send UTF-8, decode by BOM/charset, test with a non-ASCII ledger name in WP-05.7. | 2026-11-12 | JSON page, headers table |

## 9. Test environments

- Automated: TallySimulator (built from §8 fixtures) — runs in CI on Windows runner or locally.
- Integration acceptance: non-production test company on the designated PC (or a separate PC with
  TallyPrime in a mode permitted by the licence) — OD-006. Posting mode TEST_ONLY.
- Production posting: only after Phase 15 owner approval (`owner_approval.kind = PRODUCTION_POSTING_ENABLE`).

## 10. Never

Create/alter/delete ledgers or masters; expose the port; post without marker; mark posted without re-query;
resubmit after uncertainty without verification; rely on number+date+amount for duplicate detection;
store keys unencrypted; run two agents for one company; touch a company whose fingerprint does not match.
