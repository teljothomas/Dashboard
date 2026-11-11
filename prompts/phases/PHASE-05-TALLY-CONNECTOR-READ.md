# PHASE-05 — Tally Connector: Read Foundation

## A. Identity
- Objective: verified Tally protocol knowledge, cloud connector endpoints, Windows agent foundation (registration,
  lease, heartbeat, journal), Tally read client, import pipeline (masters, vouchers, balances, deletions), status UI.
  **No posting in this phase.**
- Assigned model: Sonnet. Opus review REV-05 (WP-05.8). Haiku-eligible tasks marked.
- Prerequisites: Phase 04 COMPLETE. Owner gates: G1 .NET 10 SDK on dev PC (WP-05.0); G2 Tally test company access (WP-05.7 only).
- Requirements: BR-020, 021, 030–034. Decisions: ADR-007, 030–035. Docs: TALLY_INTEGRATION (all), SYNC_DESIGN §4–6,
  INTERFACES §5, DATA_MODEL §4 (excluding ledger_mapping/posting tables).

## B. Context rules
STATUS.md → registry → this WP → Context only. Agent WPs do not load web/API module code beyond the contracts named.
Never connect to a production Tally company in this phase. Never change Tally settings without owner approval.

## C/D. Phase-wide requirements
Cloud: signature middleware on all `/connector/v1/*` except `register`; lease checks in the same DB transaction as writes;
idempotent batches; audit for registration/revocation/posting-mode changes. Agent: .NET 10, nullable enabled, warnings as
errors, async all the way, cancellation tokens, Serilog, no secrets in config/logs, loopback-only Tally host. Imported data
is never edited by the ERP.

---

### WP-05.0 — Prerequisites check
Size S. Verify `dotnet --list-sdks` shows 10.x. If absent → STATUS OWNER APPROVAL REQUIRED "Install .NET 10 SDK", mark
WP-05.0 BLOCKED, and execute WP-05.1 (docs part) and WP-05.2 (cloud side, Node only) meanwhile. Next: WP-05.1.

### WP-05.1 — Protocol spike (documentation verification)
Size M · Haiku: no
Context: TALLY_INTEGRATION §4, §8.
Modify: TALLY_INTEGRATION §3 (menu path) and §8 (table), `agent/tests/fixtures/tally/*.json|xml` (sanitised samples), TASK_LOG.
Tasks:
1. From official TallyPrime 7.0 developer documentation (help.tallysolutions.com / TallyPrime developer reference) confirm items
   (a)–(j) of TALLY_INTEGRATION §4. Cite URL + section for each. Prefer JSON; mark items requiring XML fallback.
2. If a test company is already available (OD-006 answered), capture live sanitised samples; otherwise construct fixtures strictly
   from documented examples and mark them `DOC_ONLY` (to be confirmed in WP-05.7).
3. Fill §8 rows. Anything undocumented → row "NOT VERIFIED — do not rely" and an ESC if it blocks design (e.g., no way to query by
   marker → Opus must decide an alternative identity strategy before Phase 11).
Acceptance: every §4 item has a verified row or an explicit NOT VERIFIED row with consequence; fixtures exist for each verified read.
Next: WP-05.2.

### WP-05.2 — Cloud connector API and Tally mirror schema
Size L · Haiku: yes (mirror table DTO schemas from DATA_MODEL)
Context: INTERFACES §5 and §2 tally rows (non-posting); DATA_MODEL §4; SYNC_DESIGN §4–5; SECURITY §1 agent row.
Modify: migration `0005_tally_mirror.sql`, `apps/api/src/modules/tally/**`, `packages/contracts/src/connector.ts`, `tally.ts`.
Tasks:
1. Tables: tally_company, connector_registration_code, connector_agent, connector_lease, connector_heartbeat, connector_nonce,
   sync_watermark, import_batch, tally_* masters, tally_voucher(+lines), tally_balance_snapshot, `party` minimal upsert hook
   (party table created here if Phase 06 not yet — owner: parties module; coordinate by creating it in this migration and
   documenting in TASK_LOG).
2. Signature verification plugin (ECDSA P-256 SPKI, timestamp window, nonce uniqueness, body hash).
3. Endpoints: register, lease acquire/release, heartbeat, company/verify, watermarks, import-batches, recon-snapshots, version.
   Outbox endpoints are NOT built here.
4. Admin endpoints: companies (create expected identity), registration code, agents list/revoke, `/tally/status`, mirror reads.
5. Import apply: upsert by guid, marker parse `[ERP:<uuid>]`, watermark update after apply, `is_deleted_in_tally` from snapshots,
   balances upsert, hook registry `tally.onVouchersImported(fn)` for later modules.
6. Tests: TS-S05 (expired/reused code, bad signature, replayed nonce, skewed timestamp), TS-T11 (second agent LEASE_HELD, stale
   epoch 409), batch idempotency, watermark only advances on success, deletion snapshot marking, TS-A08/TS-A09 (receipt/payment
   imported once even if batch resent).
Acceptance: tests pass; no endpoint writes without lease check.
Next: WP-05.3.

### WP-05.3 — Agent foundation
Size L · Haiku: yes (status CLI output formatting, install script comments)
Context: TALLY_INTEGRATION §6; INTERFACES §5; SECURITY §1, §6.
Modify: `agent/**` (new solution), `.github/workflows/ci.yml` (Windows job: build + test), QUALITY_GATES §1 agent row.
Tasks:
1. Solution layout per TALLY_INTEGRATION §6; Worker Service with Windows Service hosting.
2. Key store: generate ECDSA P-256 on registration; persist private key DPAPI LocalMachine-protected file with restrictive ACL.
3. Cloud client: signing handler, retries with jitter, typed DTOs mirroring contracts; registration flow (`TradeXAgent.exe register <code>`).
4. Lease + heartbeat loops; graceful shutdown releases lease.
5. SQLite journal (WAL, synchronous=FULL), schema per §6, integrity check on start.
6. `status` command; Serilog file + Event Log sinks.
7. Install/uninstall/upgrade PowerShell scripts in `agent/deploy/` (service, recovery options, firewall inbound block rule for
   the Tally port, ProgramData ACL). Scripts are written and reviewed, **not executed on the Tally PC** in this WP.
8. xUnit tests: signing canonical string matches Node implementation (shared test vector), lease loss stops work, journal
   survives abrupt process kill (TS-T13 precursor).
Acceptance: `dotnet test` passes; shared signature test vector passes on both sides.
Next: WP-05.4.

### WP-05.4 — Tally read client and simulator
Size L · Haiku: yes (parsers for simple masters from fixtures)
Context: TALLY_INTEGRATION §4, §8, fixtures.
Modify: `agent/src/TradeX.TallyAgent.Tally/**`, `agent/tools/TallySimulator/**`, tests.
Tasks: probe (reachable, version, loaded company), company info, masters by ALTERID, vouchers by ALTERID/date range, balances;
parsers tolerant to documented variations; loopback enforcement; TallySimulator serving fixtures with controllable faults
(down, slow, wrong company, malformed).
Acceptance: parser tests over all fixtures; simulator-driven tests for wrong company (TS-T07) and Tally closed (TS-T02 read side).
Next: WP-05.5.

### WP-05.5 — Import pipeline end-to-end
Size L · Haiku: no
Context: SYNC_DESIGN §5; TALLY_INTEGRATION §6 main loop.
Modify: `agent/src/**` (import orchestration), API tests as needed.
Tasks: main loop steps 1–5 and 7 (no posting); batching ≤ 500; import_journal for resend after network loss; recon snapshots
(start, nightly, FULL_RECON command); company verify gate; commands from heartbeat.
Tests (simulator + test API instance): TS-T01 (simulator down 24 h equivalent then drain), TS-T04 (network drop after Tally read,
resend idempotent), TS-T10 (reconnect, new epoch), TS-T12 (voucher altered → upsert new version; deleted → flagged).
Acceptance: listed scenarios pass in an automated integration test harness (`agent/tests/Integration` with API test server).
Next: WP-05.6.

### WP-05.6 — Web: Tally status and administration
Size M · Haiku: yes (mirror list screens)
Context: INTERFACES §2 tally rows; SYNC_DESIGN §6.
Modify: `apps/web/src/features/tally/**`.
Tasks: status page (last heartbeat, lease holder, watermarks, stale badge), companies + registration code (shown once), agents
revoke, ledgers/vouchers browse (read-only, source label TALLY + as-of).
Acceptance: component tests + e2e for registration-code issue and status display (API seeded).
Next: WP-05.7.

### WP-05.7 — Real Tally acceptance on test company (OWNER GATE G2) — non-blocking for next phase
Size M · Requires: OD-001/002/003/006 answered; owner approval to install agent and apply firewall rule on the Tally PC.
Tasks: owner-assisted install with scripts; register to a `is_test=true` company; confirm §8 DOC_ONLY items live; full import of
test company; TS-T02, TS-T07, TS-T10 manually on real Tally; record evidence (screenshots/log excerpts, sanitised) in
`docs/evidence/WP-05.7.md`. If prerequisites missing → BLOCKED, continue with Phase 06 (Phase 11 production posting stays blocked).

### WP-05.8 — Opus review and Phase 05 gate
Size S · Opus REV-05: signature/lease/import correctness, no inbound exposure, no posting paths. Fix CRITICAL/HIGH. Phase gate.
STATUS next WP-06.1.

## E. Phase acceptance criteria
Agent registers, holds a single lease, imports masters/vouchers/balances idempotently with deletion detection; protocol facts
verified and documented; all listed TS tests pass on simulator; no posting code exists.

## F. Verification commands
`pnpm --filter api test:integration`, `dotnet build agent/TradeX.TallyAgent.sln`, `dotnet test agent/TradeX.TallyAgent.sln`.

## G. Completion requirements
Protocol Step 6; TALLY_INTEGRATION §8 kept current; evidence files for any live check.

## H. Failure handling
Protocol uncertainty → stop guessing, ESC to Opus. Simulator/real mismatch → real behaviour wins; update fixtures + §8 and re-run tests.
