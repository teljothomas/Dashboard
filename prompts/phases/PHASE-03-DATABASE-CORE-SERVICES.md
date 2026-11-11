# PHASE-03 — Database and Core Services

## A. Identity
- Objective: PostgreSQL access layer, migration runner, core tables and triggers, audit, numbering, jobs,
  attachments, device-sync server endpoints, client offline core (Dexie outbox + sync engine).
- Assigned model: Sonnet. Haiku-eligible tasks marked.
- Prerequisites: Phase 02 COMPLETE (dev DB available).
- Decisions: ADR-004, 006, 011–015, 040, 041, 061. Docs: DATA_MODEL §1, §3; SYNC_DESIGN §1–2; OFFLINE_DESIGN §3–4.

## B. Context rules
STATUS.md → registry → this WP → its Context only.
**Auth seam:** identity arrives in Phase 04. Routes here read `request.ctx` (`{userId, deviceId, permissions}`) populated
by a `requestContext` plugin interface. Tests register a test-only context plugin (in `apps/api/test/`, never imported by
`src/`). Production `buildApp` registers no context provider until WP-04.3 (routes therefore reject with 401 when ctx is absent).

## C/D. Phase-wide requirements
SQL migrations numbered `NNNN_name.sql`, run in a transaction, recorded in `schema_migration(version, name, checksum, applied_at)`;
checksum mismatch aborts. Kysely only with parameters; generated DB types (`kysely-codegen`) committed. Every mutation
service writes audit in the same transaction. Integration tests run on `tradex_test` (truncate between tests).

---

### WP-03.1 — DB layer, migration runner, core schema
Size L · Haiku: no
Context: DATA_MODEL.md conventions + §1; DECISIONS ADR-004/011/012/013/014/015.
Modify: `apps/api/src/db/**`, `apps/api/migrations/0001_core.sql`, `apps/api/package.json` scripts (`db:migrate`, `db:codegen`), `/health`.
Tasks:
1. Migration runner (`db:migrate`) using owner role URL `DATABASE_URL_MIGRATE`; app uses `DATABASE_URL` (tradex_app).
2. `0001_core.sql`: extensions (`pgcrypto`), helper functions/triggers: `set_updated_at`, `bump_version`,
   `assign_sync_seq` (global sequence `sync_seq_global`), `forbid_update_when_locked(lock_column)`; tables division (seed
   MEAT, LOGISTICS), app_setting (seed `tally_stale_hours=24`, `fy_start_month=4`), number_sequence, audit_log (REVOKE
   UPDATE, DELETE from tradex_app), job, owner_approval (append-only), notification.
3. `/health` checks `SELECT 1` (no version details).
4. Integration tests: migrations apply on empty DB twice (idempotent no-op second run); app role cannot UPDATE/DELETE
   audit_log; triggers bump version/updated_at; sync_seq increases monotonically.
Acceptance: tests pass; codegen types compile.
Verify: `pnpm --filter api db:migrate`, `pnpm --filter api test:integration`.
Next: WP-03.2.

### WP-03.2 — Core services: audit, numbering, settings, jobs
Size M · Haiku: yes (settings CRUD tests)
Context: INTERFACES.md §7 (core signatures); DATA_MODEL §1.
Modify: `apps/api/src/modules/core/**`, `apps/api/src/jobs/**`.
Tasks:
1. `core.audit.record(tx, …)` computes shallow JSON diff; captures ctx (user, device, requestId).
2. `core.numbers.next(tx, name, businessDate)` → `PREFIX-FY-#####` (FY Apr–Mar, e.g., `EXP-2026-00001` for FY 2026-27); gap-free per tx.
3. Job worker: poll every 2 s, `FOR UPDATE SKIP LOCKED`, handler registry, exponential backoff, max_attempts → DEAD,
   graceful stop. `core.jobs.enqueue(tx, …)`.
4. Notifications service (create, list for user, mark read).
5. Tests: concurrent `numbers.next` in parallel transactions yields unique sequential numbers; job retry/backoff/DEAD;
   two workers never run the same job.
Acceptance: tests pass, including concurrency tests.
Next: WP-03.3.

### WP-03.3 — Attachments
Size M · Haiku: no
Context: SECURITY.md §5; DATA_MODEL §1 (attachment tables); INTERFACES §2 core rows.
Modify: `apps/api/src/modules/core/attachments/**`, migration `0002_attachments.sql`.
Tasks:
1. `StorageAdapter` interface + `LocalFsStorage` (ATTACHMENTS_DIR, sharded by sha256 prefix, atomic write via temp+rename).
2. `POST /api/v1/attachments` multipart (`@fastify/multipart`, 10 MB limit, 1 file): magic-byte sniff (JPEG/PNG/WebP/PDF),
   image re-encode (sharp) stripping metadata, sha256 dedupe, row insert, audit.
3. `GET /api/v1/attachments/:id` streams with correct type, `X-Content-Type-Options`, attachment disposition for PDF;
   access check delegates to a resolver registered by the owning module (`attachments.registerAccessResolver(entityType, fn)`);
   unlinked attachments visible only to uploader.
4. `core.attachments.link(...)`.
5. Tests TS-S03: spoofed extension, oversize, polyglot/unknown type → 415/413; duplicate upload returns same id; EXIF removed.
Acceptance: TS-S03 cases pass.
Next: WP-03.4.

### WP-03.4 — Device sync server (push/pull/conflicts)
Size L · Haiku: no
Context: SYNC_DESIGN.md §1–2; INTERFACES.md §4; DATA_MODEL §3.
Modify: `apps/api/src/modules/sync/**`, migration `0003_sync.sql`, `packages/contracts/src/sync.ts`.
Tasks:
1. Tables client_mutation, sync_conflict; `device` upsert lives in Phase 04 — here store device_id as uuid without FK (FK added in 04.1).
2. `sync.registerEntity(entityType, handler)` registry; handler interface per INTERFACES §7.
3. `POST /sync/push`: per-mutation transaction, idempotent replay, BLOCKED_BY_PREVIOUS semantics, result mapping.
4. `GET /sync/pull`: per scope, cursor = sync_seq, scope filter from handler, `hasMore`.
5. Conflict list/resolve endpoints (KEEP_SERVER / APPLY_CLIENT / MERGED) with audit.
6. Tests with a test-only entity registered from `apps/api/test/` (`test_note` table created by test setup, not a migration):
   replay idempotency; CONFLICT on stale baseVersion for financial-flagged field; disjoint non-financial auto-merge;
   RECORD_LOCKED; BLOCKED_BY_PREVIOUS; pull ordering and cursor resume; 50-mutation limit.
Acceptance: all listed tests pass (covers server side of TS-O03, TS-O05, TS-O08).
Next: WP-03.5.

### WP-03.5 — Client offline core (Dexie outbox and sync engine)
Size L · Haiku: yes (status chip component, banner component from spec)
Context: OFFLINE_DESIGN.md §3–5; SYNC_DESIGN §2.4; INTERFACES §4.
Modify: `apps/web/src/offline/**`, `apps/web/src/components/ui/SyncStatusChip.tsx`, `SyncBanner.tsx`.
Tasks:
1. Dexie schema exactly per OFFLINE_DESIGN §3 with versioned migrations; device id bootstrap.
2. `outbox.ts`: enqueue (same tx as local record write), FIFO read, state updates; user tagging.
3. `syncEngine.ts`: triggers, single-flight (Web Locks), order (attachments placeholder → push → pull), backoff, 401 pause.
4. `status.ts`: derive BR-301 label from local + server state (precedence table).
5. `useOfflineMutation(entityType)` hook used by future module forms (save locally → enqueue → trigger sync).
6. Unit tests with `fake-indexeddb` + mocked fetch: offline create → LOCAL_ONLY; ack → SYNCED; conflict → REQUIRES_RECONCILIATION;
   restart persistence; no duplicate send on concurrent triggers.
Acceptance: tests pass; status derivation table fully covered.
Next: WP-03.6.

### WP-03.6 — Phase 03 gate
Size S. Run full suite + migrations on empty DB + build. Update QUALITY_GATES (`db:migrate`, `test:integration` VERIFIED).
STATUS next action WP-04.1. Commit.

## E. Phase acceptance criteria
Migrations reproducible; audit/numbering/jobs/attachments/sync proven by tests; client outbox persists across restarts;
no production route reachable without ctx (401).

## F. Verification commands
`pnpm --filter api db:migrate && pnpm --filter api test:integration && pnpm test && pnpm typecheck && pnpm lint && pnpm build`

## G. Completion requirements
Protocol Step 6; TASK_LOG lists migrations added.

## H. Failure handling
Concurrency flakiness: fix root cause (locking/isolation), never add retries to tests to hide it. Codegen drift: regenerate, never hand-edit generated types.
