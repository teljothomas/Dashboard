# Synchronization Design (v1.0)

Two independent channels share one rule: **nothing is claimed done until the receiving side has
durably stored it and the sender has a verifiable acknowledgement.**

- Channel D: device (PWA/Dexie) ↔ cloud API. Client side detail: OFFLINE_DESIGN.md.
- Channel T: cloud ↔ Tally agent ↔ TallyPrime. Agent/Tally detail: TALLY_INTEGRATION.md.

## 1. Identity rules

- Every syncable record and every financial event has a UUID v7 created once and never reused.
- Every device mutation has its own `mutationId`; every agent import batch has its own `batchId`.
- Human numbers (EXP-2026-00123) are assigned by the server at first successful sync; offline records show
  "pending number".
- Syncable tables carry `sync_seq bigint` set from one global sequence by trigger on insert/update; pull
  cursors use it (monotonic, no clock-skew problems).

## 2. Channel D — device ↔ cloud

### 2.1 Push
1. Client sends ≤ 50 mutations in creation order, attachments uploaded first (mutation waits for its
   attachment ids).
2. Server, per mutation, in its own transaction: look up `client_mutation` → if present return stored
   result (idempotent replay). Else validate, authorize, apply via the entity handler registered with
   `sync.registerEntity`, write audit, insert `client_mutation` with result, commit.
3. If a mutation for entity X is REJECTED/CONFLICT, later mutations for the same X in the batch return
   `BLOCKED_BY_PREVIOUS`; unrelated mutations continue.
4. Client deletes an outbox entry only on APPLIED; on CONFLICT/REJECTED it keeps the entry, marks the
   record and stops retrying that entity until the user acts.

### 2.2 Pull
`scope=reference` (masters needed offline) and `scope=mine` (records within the user's permission scope).
Cursor = last `sync_seq`. Server returns changes ordered by `sync_seq`, `deleted=true` for archived/revoked.
Local records with pending outbox entries are NOT overwritten by pull; the server copy is stored aside
and compared when the outbox entry resolves.

### 2.3 Conflict rules (no last-write-wins for financial data)
| Situation | Result |
|---|---|
| CREATE with new id | Never a conflict (idempotent by id) |
| CREATE violating a business uniqueness (attendance worker+date from two devices) | CONFLICT → `sync_conflict`, both values preserved |
| UPDATE with stale baseVersion on financial fields (amount, date, category, mode, payee, qty, km) | CONFLICT |
| UPDATE with stale baseVersion, only non-financial fields, disjoint from server changes (e.g. note, delivery_note) | Auto-merge allowed, audited as `MERGED` |
| Any mutation on APPROVED/POSTED/period-locked record | REJECTED `RECORD_LOCKED`; client shows REQUIRES_RECONCILIATION |
| SUBMIT after server already REJECTED/CANCELLED it | REJECTED `INVALID_TRANSITION` |
Conflicts are resolved by the record owner or an approver via `/sync/conflicts/:id/resolve`
(KEEP_SERVER / APPLY_CLIENT / MERGED with explicit values). Resolution is audited.

### 2.4 User-visible status (BR-301)
Server computes `syncStatus` (server part); client overlays local part. Precedence top to bottom:

| Status | Condition |
|---|---|
| LOCAL_ONLY | client outbox holds an unacknowledged mutation for the record |
| FAILED | last push REJECTED (validation) or attachment permanently failed |
| REQUIRES_RECONCILIATION | open sync_conflict, RECORD_LOCKED rejection, posting REJECTED/DEAD/ALTERED_IN_TALLY, or UNCERTAIN > 24 h |
| AWAITING_APPROVAL | server status SUBMITTED |
| AWAITING_TALLY | APPROVED and posting status in PENDING, READY, BLOCKED_MAPPING, BLOCKED_VALIDATION, CLAIMED, FAILED_RETRYABLE, UNCERTAIN (≤ 24 h) |
| POSTED_TO_TALLY | posting status POSTED_VERIFIED |
| SYNCED | stored on server, no approval/posting involved (operational records, drafts) |

## 3. Channel T — posting outbox state machine (ERP → Tally)

| From | Event | To | Actor |
|---|---|---|---|
| — | source approved; `ledger.createEvent` | PENDING | API (same tx as approval) |
| PENDING | build voucher: all keys mapped & valid | READY | job `posting.prepare` |
| PENDING | unmapped key | BLOCKED_MAPPING | job |
| PENDING | other validation failure (closed period, inactive ledger) | BLOCKED_VALIDATION | job |
| BLOCKED_* | mapping approved / issue fixed (job re-evaluates on mapping change) | PENDING | job |
| READY | agent claim with valid epoch (claim TTL 5 min) | CLAIMED | agent |
| CLAIMED | result CREATED and agent re-query confirms | POSTED_VERIFIED | agent |
| CLAIMED | result ALREADY_EXISTS (marker found before send) | POSTED_VERIFIED | agent |
| CLAIMED | Tally returned explicit error (no voucher created, verified absent) | REJECTED | agent |
| CLAIMED | journal shows request never left the PC | FAILED_RETRYABLE | agent |
| CLAIMED | timeout / ack lost / unknown | UNCERTAIN | agent, or job when claim expires |
| UNCERTAIN | verify: marker found | POSTED_VERIFIED | agent |
| UNCERTAIN | verify: marker absent after full-period query on a reachable, matching company | READY | agent |
| FAILED_RETRYABLE | backoff elapsed | READY | job |
| REJECTED | accountant fixes cause and retries | PENDING | user (tally.posting.manage) |
| REJECTED / BLOCKED_* | cancel (event never in Tally) | CANCELLED | user; source record → CANCELLED + audit |
| any non-final | attempt_count ≥ 8 | DEAD | job; alert |
| POSTED_VERIFIED | import sees the voucher altered or deleted in Tally | ALTERED_IN_TALLY | import |

Hard rules:
- An expired claim goes to UNCERTAIN, **never** straight back to READY.
- Resubmission is only allowed from READY, which (after any uncertainty) is reachable only through a
  verify step that proved absence.
- Retry backoff: 1 m, 5 m, 15 m, 1 h, 3 h, 6 h, 12 h, 24 h.
- POSTED_VERIFIED and CANCELLED are final for that outbox row. Corrections use a new REVERSAL event.
- ALTERED_IN_TALLY is never auto-overwritten; accountant reconciles (accept Tally change, or reverse).
- Posting mode DISABLED ⇒ claim returns empty. TEST_ONLY ⇒ only when `tally_company.is_test`.

## 4. Lease (single active agent)

- Acquire: granted if no lease, lease expired, or same agent. The epoch grows when the holder changes **or the
  previous lease had expired** (a gap in holding makes in-flight work uncertain, TS-T10); a live lease the same
  agent already holds keeps its epoch. The lease row is never deleted (release and revoke set `expires_at = now()`),
  so the epoch only ever increases and a stale agent can never match a fresh lease.
- TTL 90 s; heartbeat every 30 s renews. Release on clean shutdown.
- Every mutating connector call checks, in the same DB transaction: `lease.agent_id = caller AND
  lease.epoch = body.epoch AND lease.expires_at > now()`; otherwise 409 LEASE_STALE and the agent must
  stop work, re-acquire, and re-verify any in-flight items (they become UNCERTAIN on the cloud side).
- Second agent for the same company while lease is live ⇒ 409 LEASE_HELD; it idles and retries every 5 min.
  Revoking an agent (admin) also expires its lease.

## 5. Import (Tally → ERP inbox)

1. Agent reads `GET /watermarks`; queries Tally for masters then vouchers with ALTERID > watermark, in
   ALTERID order, batches of ≤ 500.
2. `POST /import-batches` (idempotent by batchId). Server: verify lease, upsert by (company_id, guid) in
   one transaction, parse `[ERP:<uuid>]` markers into `erp_event_id`, update watermark to `toAlterId`
   only after successful apply.
3. Hooks after apply (same tx or queued job): inventory creates "unassigned Tally lines" for new
   sales/purchase inventory lines; trips invoice-linking candidates refresh; posting outbox reconciliation
   (marker match ⇒ POSTED_VERIFIED if not already).
4. Deletions: on agent start and nightly at 02:00 local (if PC on) and on `FULL_RECON` command, agent
   sends `recon-snapshots` of (guid, alterId) for current + previous month (whole FY monthly); vouchers
   missing from the snapshot are flagged `is_deleted_in_tally` (never physically deleted in ERP).
5. ERP-posted voucher changed in Tally (alter_id moved and content hash differs from posted payload) ⇒
   outbox ALTERED_IN_TALLY ⇒ REQUIRES_RECONCILIATION.
6. Balances: after vouchers, agent sends closing balances of cash, bank, party ledgers (`stream=BALANCES`).

## 6. Freshness

`tally.getFreshness()` = min(last_success_at of VOUCHERS, BALANCES). STALE if older than
`app_setting.tally_stale_hours` (default 24). Dashboard shows last heartbeat, lease holder, queue counts
by status, oldest READY age, failures.

## 7. Designed behaviour for mandatory failure scenarios

Test IDs refer to QUALITY_GATES.md §4.

| ID | Scenario | Designed behaviour |
|---|---|---|
| TS-T01 | Tally PC off 24 h | Outbox accumulates READY; dashboard STALE; on start agent drains in order; no loss |
| TS-T02 | Tally closed while agent runs | Probe fails → agent pauses claims, heartbeat tallyReachable=false; in-flight item → journal decides FAILED_RETRYABLE vs UNCERTAIN |
| TS-T03 | Windows restart mid-sync | Journal entries INTENT/SENT without ACKED → verify by marker on restart |
| TS-T04 | Internet drops during import | Tally side done, cloud result unsent → journal keeps result; resent on reconnect (idempotent by attemptNo) |
| TS-T05 | Import ok, ack lost | UNCERTAIN → verify finds marker → POSTED_VERIFIED; no second voucher |
| TS-T06 | Same ERP txn submitted twice | Unique event per source; outbox unique per event; agent pre-send marker check → ALREADY_EXISTS |
| TS-T07 | Wrong company loaded | company/verify mismatch → no claims, no imports; alert |
| TS-T08 | Unmapped ledger | BLOCKED_MAPPING; never creates ledger |
| TS-T09 | Rejected voucher | REJECTED with excerpt; accountant fixes, retries |
| TS-T10 | Agent reconnects after outage | Re-acquire lease (new epoch if expired), verify UNCERTAIN, resume watermarks |
| TS-T11 | Two agents | Second gets LEASE_HELD; stale epoch writes rejected |
| TS-T12 | Imported/posted voucher modified in Tally | Imported: upsert new version; ERP-posted: ALTERED_IN_TALLY |
| TS-T13 | Journal interrupted (power cut) | SQLite WAL + fsync; on open, integrity check; incomplete rows treated as SENT ⇒ verify |
| TS-T14 | Agent upgrade/restart | Graceful stop releases lease after finishing current item; new version re-verifies journal |
| TS-O01..08 | Offline scenarios | OFFLINE_DESIGN.md §6 |
