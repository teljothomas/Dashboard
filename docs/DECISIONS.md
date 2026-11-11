# Architecture Decision Register

Accepted decisions. Sonnet/Haiku must follow them; changes require an Opus work package (WP-01.R)
that edits this file and records the reason. Format: ID — decision — reason.

## Platform

- ADR-001 Modular monolith: one Node.js API process (HTTP + in-process job worker), one PostgreSQL 16+
  database, one React PWA, one Windows sync agent. — Small team, ~1k txn/month, lowest cost and ops load.
- ADR-002 Monorepo with pnpm workspaces: `apps/web`, `apps/api`, `packages/contracts`, `packages/domain`,
  `agent/` (.NET solution, outside pnpm). — Shared types between web and API; one CI.
- ADR-003 API: Node.js 24 LTS, TypeScript strict, Fastify 5, Zod schemas (shared in `packages/contracts`),
  REST JSON under `/api/v1`. — Fast, typed, schema-first validation.
- ADR-004 DB access: Kysely query builder (parameterised only) with plain SQL migrations run by a small
  migration runner (`apps/api/src/db/migrate.ts`) over numbered files `apps/api/migrations/NNNN_name.sql`,
  recorded in `schema_migration`. Forward-only; every migration reviewed. — Reviewable SQL, no ORM magic.
- ADR-005 Web: React 19 + Vite + TypeScript + Tailwind CSS 4 + TanStack Query + React Router + Dexie 4 +
  vite-plugin-pwa (Workbox). — Matches brief; lightweight on low-end Android.
- ADR-006 Jobs/queues in PostgreSQL tables using `FOR UPDATE SKIP LOCKED`. No Redis, no broker.
- ADR-007 Tally agent: .NET 10 LTS Windows Service (self-contained publish), Microsoft.Data.Sqlite journal,
  DPAPI (LocalMachine scope) for secrets, outbound HTTPS only. Optional tray/status CLI. — Native Windows,
  runs without user login, survives reboots.
- ADR-008 Deployment: Docker Compose on one Indian-region VPS: `caddy` (TLS + static web), `api`,
  `postgres`, `backup` (cron pg_dump + restic to off-site object storage). Staging = separate compose
  project + database on the same VPS (cost trade-off, documented in DEPLOYMENT.md).

## Data and money

- ADR-010 Money `NUMERIC(18,2)` INR; quantities `NUMERIC(14,3)`; rates `NUMERIC(18,4)`. JSON carries decimal
  strings matching `^-?\d{1,16}(\.\d{1,2})?$`. TypeScript uses `decimal.js` via `packages/domain/money.ts`.
- ADR-011 Primary keys UUID v7 (time-ordered), generated client-side for offline-creatable records,
  server-side otherwise. Human numbers (TRIP-2026-00042) from `number_sequence`, assigned on server sync.
- ADR-012 All business tables carry `created_at, created_by, updated_at, updated_by, version` (optimistic
  concurrency). Financial tables are append-only after approval (DB triggers block UPDATE of locked rows).
- ADR-013 `audit_log` append-only (UPDATE/DELETE revoked from app role), stores actor, action, entity,
  before/after JSON diff, request id, device id.
- ADR-014 Soft delete only for master data (`archived_at`). Financial records: never deleted; reversal.
- ADR-015 Timestamps `timestamptz` UTC; business dates `date` in Asia/Kolkata. Financial year Apr–Mar.

## Accounting boundary

- ADR-020 Tally owns books. ERP imports Tally vouchers/masters into read-only `tally_*` tables. ERP never
  edits imported data.
- ADR-021 ERP-originated money movements become `financial_event` rows with balanced
  `financial_event_line` rows keyed by `posting_key` (not Tally ledger names). Ledger names come from
  `ledger_mapping` at voucher-build time. Unmapped key → `BLOCKED_MAPPING`, never auto-create ledgers.
- ADR-022 One common advance engine (`advance`, `advance_settlement`) for drivers and workers.
- ADR-023 Internal trips and cost allocations live only in management tables (`cost_allocation`); never
  become financial events.
- ADR-024 External trips carry `invoice_status` and link to an imported Tally sales voucher by GUID.
- ADR-025 Corrections after posting: `REVERSAL` financial event (mirror lines) + optional replacement event.

## Tally integration

- ADR-030 Agent pulls; cloud never connects inbound to the Tally PC. Agent→cloud over HTTPS with
  HMAC-signed requests (agent secret from one-time registration code).
- ADR-031 Single active agent per Tally company via `connector_lease` with fencing epoch; every agent write
  carries the epoch; stale epochs rejected (409).
- ADR-032 Preferred protocol: TallyPrime 7.0 native JSON over HTTP on 127.0.0.1:9000; XML fallback only where
  JSON lacks a capability. Exact request shapes are verified in spike WP-05.1 and recorded in
  TALLY_INTEGRATION.md §Verified protocol before any posting code is written.
- ADR-033 Idempotency: each posted voucher carries ERP identity in (a) narration marker `[ERP:<event_uuid>]`,
  (b) reference number `ERP-<short>`, and (c) REMOTEID/GUID if verified to be settable. Recovery queries by
  marker before any resubmission. Agent keeps write-ahead SQLite journal.
- ADR-034 Posting mode per company: DISABLED → TEST_ONLY → PRODUCTION. PRODUCTION needs owner approval
  record + company fingerprint match.
- ADR-035 Incremental import by Tally ALTERID watermarks; periodic full-period reconciliation detects
  deletions and alterations.

## Offline

- ADR-040 Client outbox in Dexie; server `POST /api/v1/sync/push` idempotent by `mutation_id`;
  `GET /api/v1/sync/pull` by per-scope cursor. No last-write-wins for financial records; version
  mismatch → explicit conflict record.
- ADR-041 Offline creation allowed; offline edit of server-approved financial records not allowed.

## Security

- ADR-050 Server sessions (opaque 256-bit token, SHA-256 hashed in DB), httpOnly Secure SameSite=Lax cookie,
  14-day idle-sliding expiry, 30-day absolute. CSRF: SameSite + required `X-CSRF-Token` header (double submit).
- ADR-051 Argon2id (`@node-rs/argon2`, m=19456 KiB, t=2, p=1 minimum). Rate-limited login.
- ADR-052 RBAC with permission strings (`expense.approve`) plus row scopes (OWN, DIVISION, ALL) evaluated server-side.

## Process

- ADR-060 Execution order differs from phase numbering: Phase 10 runs after Phase 06 and before 07, because
  07/08/09 depend on the common expense/approval engine. PROMPT_REGISTRY controls order.
- ADR-061 Offline client infrastructure (Dexie outbox + sync endpoints) is built in Phase 03 so module UIs
  are offline-capable from the start; Phase 12 hardens it (PWA install, attachments queue, conflict UI, recovery).
- ADR-062 Commands named in prompts are the canonical script names Phase 02 must create. Until Phase 02
  verifies them, they are marked PLANNED in QUALITY_GATES.md.
- ADR-063 Repository workflow: local git on `main`; one local commit per verified work package (the owner's
  master instruction allows commits once a task is verified). Push, remote creation, force-push and history
  rewrites require owner approval. Owner may change this rule by editing this ADR.
  Status: ACTIVE (2026-11-11). Remote `origin` = https://github.com/teljothomas/Dashboard.git recorded; no push until owner approves.
