# System Architecture (baseline v1.0, 2026-11-11)

Read with: `docs/DECISIONS.md` (the why). Details live in DATA_MODEL, INTERFACES, SYNC_DESIGN,
TALLY_INTEGRATION, OFFLINE_DESIGN, SECURITY, DEPLOYMENT. This file is the map.

## 1. Context

```
 Android PWA / desktop browser (owner, accountant, managers, supervisors, drivers)
   | HTTPS (cookie session)            Dexie outbox when offline
   v
 Caddy (TLS, static PWA, reverse proxy)            -- one Indian-region VPS, Docker Compose
   v
 API (Node 24 + Fastify, modular monolith, in-process job worker)
   v
 PostgreSQL 16  ── nightly pg_dump + restic ──> off-site object storage
   ^
   | HTTPS, agent-initiated only, ECDSA-signed, lease epoch on every write
 Tally Sync Agent (.NET 10 Windows Service, SQLite journal, DPAPI keys)   -- the ONE Tally PC
   | http://127.0.0.1:9000 (never exposed; Windows Firewall blocks inbound 9000)
   v
 TallyPrime 7.0 (authoritative company)
```

The cloud never initiates a connection to the Tally PC. When the PC is off, posting items wait in
`posting_outbox`; Tally-derived figures display "as of <last successful import>".

## 2. Components and responsibilities

| Component | Owns | Never does |
|---|---|---|
| `apps/web` PWA | UI, offline capture, Dexie outbox, local status display | Business rules that the server does not re-check; financial calculations of record |
| `apps/api` | Validation, authorization, business rules, persistence, audit, approval, voucher building, sync endpoints, jobs, reports | Talk to Tally directly |
| `packages/contracts` | Zod schemas + TS types for every API request/response and sync payload | Runtime I/O |
| `packages/domain` | Pure functions: money, wage calc, advance settlement maths, trip costing, EMI schedule, voucher line balancing | I/O, DB, HTTP |
| `agent/` (.NET) | Registration, lease, heartbeat, Tally reads, voucher import, verification, local journal | Business decisions, ledger creation, editing ERP data |
| PostgreSQL | Single store for all data, queues, sessions, audit | — |

## 3. Repository layout (target)

```
/STATUS.md  /CLAUDE.md  /README.md  /docs/  /prompts/  /.claude/agents/
/package.json  /pnpm-workspace.yaml  /tsconfig.base.json  /.github/workflows/ci.yml
/apps/api/src/
    server.ts  app.ts  config.ts  db/ (kysely.ts, migrate.ts, types.ts)  plugins/ (auth, csrf, ratelimit, errors, audit, requestId)
    modules/<module>/ index.ts (public service API)  routes.ts  service.ts  repo.ts  policy.ts  *.test.ts
    jobs/ (worker.ts, handlers/)
/apps/api/migrations/NNNN_name.sql
/apps/api/test/ (integration helpers, fixtures)
/apps/web/src/
    app/ (router, layout, auth guard)  components/ui/  lib/ (api client, money, format)
    offline/ (db.ts Dexie schema, outbox.ts, syncEngine.ts, status.ts, attachmentsQueue.ts)
    features/<module>/ (pages, forms, hooks)
/apps/web/e2e/ (Playwright)
/packages/contracts/src/<module>.ts   /packages/domain/src/<area>.ts
/agent/TradeX.TallyAgent.sln
    src/TradeX.TallyAgent.Service/  src/TradeX.TallyAgent.Core/  src/TradeX.TallyAgent.Tally/  tools/TallySimulator/
    tests/TradeX.TallyAgent.Tests/
/deploy/ (compose files, Caddyfile, backup scripts, env templates)
```

## 4. Module boundaries

Each API module exposes a typed service in `modules/<m>/index.ts`. Other modules call only that
interface — never another module's `repo.ts` or tables. Reports read through SQL views `rpt_*`
(read-only). This keeps each task's context small: a fleet task needs fleet files + the contracts it uses.

| Module | API prefix | Tables (see DATA_MODEL) | Depends on (service interfaces) | Phase |
|---|---|---|---|---|
| core | `/api/v1/core` | division, attachment*, number_sequence, job, audit_log, app_setting, owner_approval, notification | — | 03 |
| identity | `/api/v1/auth`, `/api/v1/users` | app_user, role, permission*, user_role, session, device | core | 04 |
| sync | `/api/v1/sync` | client_mutation, sync_conflict | core, identity, entity handlers registered by modules | 03/12 |
| tally | `/connector/v1`, `/api/v1/tally` | tally_*, connector_*, import_batch, sync_watermark, ledger_mapping, posting_outbox, posting_attempt | core | 05/11 |
| parties | `/api/v1/parties` | party | tally (read) | 06 |
| inventory | `/api/v1/inventory` | product*, uom, stock_* , processing_batch | parties, tally (read) | 06 |
| ledger (finance core) | internal only | financial_event, financial_event_line | core, tally (mapping/outbox) | 10 |
| expenses | `/api/v1/expenses`, `/api/v1/approvals` | expense_category, expense, approval_request, approval_policy | ledger, core | 10 |
| advances | `/api/v1/advances` | advance, advance_settlement* | ledger, expenses | 10 |
| factory | `/api/v1/factory` | factory, factory_log | expenses | 07 |
| labour | `/api/v1/labour` | worker, wage_rate, attendance, wage_period, wage_sheet_line, wage_payment, deduction | expenses, advances, ledger | 07 |
| fleet | `/api/v1/fleet` | vehicle, reefer_unit, vehicle_document, service_*, tyre, fuel_entry, downtime | expenses | 08 |
| drivers | `/api/v1/drivers` | driver, driver_document, driver_pay_rule, driver_payable | advances, ledger | 08 |
| finance | `/api/v1/finance` | finance_agreement, finance_schedule_line, finance_payment | ledger | 08 |
| trips | `/api/v1/trips` | trip, trip_expense, trip_proof, cost_allocation | fleet, drivers, expenses, parties, tally (read) | 09 |
| recon | `/api/v1/recon` | bank_statement_*, recon_match, cash_count | tally (read) | 13 |
| reports | `/api/v1/reports`, `/api/v1/dashboard` | views `rpt_*` only | all via views | 13 |

## 5. Request pipeline (every API route)

`requestId` → `session` (load user, roles) → `rateLimit` → `csrf` (mutations) → Zod parse (contracts) →
`authorize(permission, scope)` → service in one DB transaction → `audit.record()` in the same transaction →
response envelope. Errors map to the envelope in INTERFACES §1. Unknown errors → 500 with request id only.

## 6. Record lifecycle (financial)

```
expense / advance / wage sheet / EMI payment  (source document)
  DRAFT -> SUBMITTED -> APPROVED  (or REJECTED / CANCELLED)
               |
               v  on APPROVED (same transaction)
  financial_event (immutable, balanced lines by posting_key) + posting_outbox row
               |
               v  agent
  posting_outbox: PENDING -> READY -> CLAIMED -> SUBMITTED -> POSTED_VERIFIED
                                   (UNCERTAIN -> verify) (REJECTED / BLOCKED_MAPPING / FAILED_RETRYABLE)
  correction: new REVERSAL event (+ optional replacement), never edit.
```
Full state machines: SYNC_DESIGN.md.

## 7. Data provenance and freshness

Every report value is tagged `TALLY` (imported official), `ERP_MANAGEMENT` (allocations/operational) or
`ESTIMATE` (e.g., depreciation estimate before OD-012). Tally-tagged values carry `as_of` =
`sync_watermark.last_success_at`; UI marks STALE if older than 24 h and shows "Tally PC last seen <time>".

## 8. Error handling and logging

- Errors: typed `AppError(code, httpStatus, details)`; codes listed in INTERFACES §1.
- Logs: pino JSON to stdout (Docker log rotation 10 MB x 5). Fields: time, level, reqId, userId, route,
  status, ms. Never log secrets, passwords, cookies, full request bodies of auth routes, or Tally payloads
  beyond 2 KB excerpts.
- Agent: Serilog rolling file (7 days) + Windows Event Log for errors; status endpoint on named pipe.

## 9. Growth path (no rewrite)

10x volume fits one VPS. Next steps if needed, in order: bigger VPS → managed Postgres → move job worker
to a second container of the same image → object storage for attachments (StorageAdapter already
abstracts it). Multi-company is possible because every Tally table is keyed by `company_id`.
