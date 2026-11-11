# PROJECT STATUS

Project: Meat Trading, Processing & Logistics ERP (working name: TradeX ERP)
Current release: none
Project state: FOUNDATION_IN_PROGRESS
Application coding: STARTED (Phase 02 foundation packages and apps exist)
Current stage: READY (WP-03.2 complete; WP-03.3 next)
Current phase: PHASE-03 (2/6)
Current task: WP-03.3
Assigned model: Sonnet 5.5
Last updated: 2026-11-11
Last verified commit: WP-02.3 commit on main (`git log --oneline`)
Next action: WP-03.3

## CURRENT POSITION

Stage: READY
Phase: PHASE-03 Database and core services
Task ID: WP-03.3
Task status: NOT_STARTED
Branch: main (pushed to origin 2026-11-11, owner approved; later pushes still need approval; WP-02.1..02.5 commits are local only)
Last completed work unit: WP-03.2 (Sonnet 5.5, 2026-11-11)

## PHASE TRACKER

Execution order (PROMPT_REGISTRY §1): 01 → 00 → 02 → 03 → 04 → 05 → 06 → 10 → 07 → 08 → 09 → 11 → 12 → 13 → 14 → 15

| Phase | Name | Status | Completion |
|---|---|---|---|
| 00 | Governance and discovery | COMPLETE | Opus part done; Sonnet WPs 4/4 (2026-11-11) |
| 01 | Architecture and contracts | COMPLETE | Baseline v1.0 (WP-01.R / 01.X run on demand) |
| 02 | Application foundation | COMPLETE | 5/5 (gate passed 2026-11-11) |
| 03 | Database and core services | IN_PROGRESS | 2/6 |
| 04 | Authentication and permissions | NOT_STARTED | 0/6 |
| 05 | Tally connector read | NOT_STARTED | 0/9 |
| 06 | Meat trading and inventory | NOT_STARTED | 0/6 |
| 07 | Factory and labour | NOT_STARTED | 0/5 |
| 08 | Drivers, fleet, loans | NOT_STARTED | 0/6 |
| 09 | Trips and logistics | NOT_STARTED | 0/5 |
| 10 | Expenses and approvals | NOT_STARTED | 0/6 |
| 11 | Tally posting | NOT_STARTED | 0/6 |
| 12 | Offline PWA hardening | NOT_STARTED | 0/5 |
| 13 | Reports and reconciliation | NOT_STARTED | 0/6 |
| 14 | Integration and hardening | NOT_STARTED | 0/6 |
| 15 | Pilot acceptance | NOT_STARTED | 0/6 |

## COMPLETED WORK

| Task ID | Deliverable | Test result | Commit |
|---|---|---|---|
| ARCH-000 | 43 governance/architecture/prompt files; reviews A–E in docs/reviews/REV-ARCH-000.md; cross-reference check (WP counts, TS/OD/ADR/BR IDs) clean | n/a (no code); doc consistency checks executed and passing | none (no git yet) |
| WP-00.1 | Integrity check clean (all listed files present; WP counts match registry for all 16 phases); git init -b main; .gitignore; .gitattributes; origin remote recorded (not pushed) | `git log --oneline` + `git status --short` executed at close (1 commit, clean) | first commit on main |
| WP-00.2 | docs/discovery/{TALLY_DISCOVERY,CA_QUESTIONS,OWNER_QUESTIONS}.md; DC-01..15 + all 32 OPEN ODs, each OD once | grep duplicate check: no output; unique OD count 32 = OPEN rows 32; set diff vs register: equal | WP-00.2 commit |
| WP-00.3 | tools/token-report.mjs + test + fixture; DEVELOPMENT_PLAN §5 usage line | `node --test`: tests 6, pass 6, fail 0. Real run (--since 2026-11-11): 39 messages, non-zero totals, 0 malformed; output has counts/paths only | WP-00.3 commit |
| WP-00.4 | Toolchain recorded in docs/QUALITY_GATES.md §1: Node v24.11.0, pnpm 12.8.1, git 2.51.0, Docker CLI 28.4.0 (daemon not running), .NET SDK absent. Phase 00 gate passed | version commands executed 2026-11-11; docker info failed to connect (expected finding); dotnet not found | WP-00.4 commit |
| WP-02.1 | pnpm workspace, strict TS base, ESLint flat (typed) + Prettier, packages/contracts (Zod primitives, 16 error codes, SyncStatus), packages/domain (Money on decimal.js, uuidv7) | domain 57 pass, contracts 34 pass; lint, typecheck, build clean | WP-02.1 commit (70fac61) |
| WP-02.2 | apps/api Fastify 5 foundation: buildApp, config (Zod), request id, error envelope, security headers, pino redaction, /health, graceful shutdown | api 19 pass; build emits runnable JS; `node dist/server.js` and `pnpm --filter api dev` served /health 200 | WP-02.2 commit (5dc9dae) |
| WP-02.3 | apps/web Vite+React 19+Tailwind 4 shell, API client, SyncBanner, money/i18n libs, Playwright smoke | web 20 pass; e2e 1 pass; initial JS 144.62 KB gzip; /api dev proxy verified | WP-02.3 commit (bbced0e) |
| WP-02.4 | deploy/compose.dev.yml (postgres:16.10, loopback only, healthcheck), db-init roles (tradex_owner DDL, tradex_app DML only), .env.example x2, api test:integration + root passthrough, CI workflow (verify + gitleaks), README commands | compose db healthy; tradex_app connects, DML ok, DDL denied; integration script exits 0 (empty suite); CI YAML parses but NOT validated with actionlint | WP-02.4 commit |
| WP-02.5 | Phase 02 gate: install, lint, typecheck, test, integration, build, e2e, audit all executed; QUALITY_GATES §1 DB rows VERIFIED | domain 57, contracts 34, api 19, web 20 pass; e2e 1 pass; audit clean | WP-02.5 commit |
| WP-03.1 | Kysely/pg DB layer; migration runner (checksum, advisory lock, per-migration tx); `0001_core.sql` (shared trigger functions, division, app_setting, number_sequence, audit_log, job, owner_approval, notification); `db:migrate`, `db:codegen`, committed generated types; `/health` runs SELECT 1 (503 on failure); CI role/DB init | integration 29 pass; `db:migrate` twice (apply, no-op); unit api 20; lint, typecheck, build clean | WP-03.1 commit |
| WP-03.2 | Core services under `apps/api/src/modules/core` (audit with shallow diff + ambient actor context, numbers `PREFIX-FY-#####` gap-free, settings with Zod schemas + optimistic version + audit, jobs.enqueue, notifications create/list/countUnread/markRead) and `apps/api/src/jobs` (registry + `JobWorker`: 2 s poll, `FOR UPDATE SKIP LOCKED`, exponential backoff, DEAD at max_attempts, lock-expiry reclaim, graceful stop) | integration 75 pass (46 new: audit 5, numbers 6 incl. 12-way parallel, settings 8, notifications 5, jobs 4, worker 14 incl. two workers 40 jobs); unit api 42; lint, typecheck, build, prettier clean | WP-03.2 commit |

## ACTIVE TASK

Objective: Phase 03 - attachments (WP-03.3 next).
Assigned agent: Sonnet 5.5
Required prompt: prompts/phases/PHASE-03-DATABASE-CORE-SERVICES.md -> WP-03.3
Required context files: per the WP-03.3 Context list
Allowed modifications: per WP-03.3 Modify list
Acceptance criteria: per WP-03.3

## OPEN BLOCKERS

- None for Phase 03. Not blocking: gitleaks and actionlint not installed on the dev PC (secret scan runs in CI; `.github/workflows/ci.yml` is NOT validated with actionlint and has never run on GitHub). .NET SDK absent (blocks WP-05.0).

## OWNER APPROVAL REQUIRED

- Answer docs/discovery/*.md (non-blocking until Phase 05.7/11/15): TALLY_DISCOVERY.md (owner/Tally PC), OWNER_QUESTIONS.md (owner), CA_QUESTIONS.md (CA). Register: docs/OPEN_DECISIONS.md.
- Pushing: owner approved first push 2026-11-11 (main → origin). Further pushes need approval per ADR-063.
- Engage a CA/accountant for ACCT decisions (OD-010..022, OD-033, OD-047, OD-048) before Phase 11 production work.
- Keep Docker Desktop running for DB work (verified running 2026-11-11, dev DB container `tradex-dev-db-1` is up).
- Install .NET 10 SDK on the dev PC (verified absent 2026-11-11) — needed by WP-05.0.
- Later protected operations: VPS purchase/domain (Phase 14), production deploy, live data import, production posting enable (Phase 15).

## QUALITY GATE

Executed 2026-11-11 (WP-03.2 gate; earlier gates below it):
- Lint: pass; Typecheck: pass; Prettier: pass; Unit: pass (domain 57, contracts 34, api 42, web 20); Integration: 75 pass (3 consecutive runs, no flake after one test-clock fix); Build: pass; `db:migrate`: no pending
- E2E and audit not re-run for WP-03.2; no new migration in WP-03.2

WP-03.1 gate: integration 29 pass; unit api 20; lint, typecheck, build clean; `db:migrate` applied then no-op.

Phase 02 gate (WP-02.5):
- Install frozen: pass · Lint: pass · Typecheck: pass · Unit: pass (domain 57, contracts 34, api 19, web 20) · E2E: 1 pass (installed Chrome)
- Integration: pass (empty suite, exit 0; dev DB healthy, tradex_app role verified) · Build: pass (web initial JS 144.62 KB gzip) · `pnpm audit --prod`: no known vulnerabilities
- Security tests: not run · Backup/restore: not run · Secret scan: not run (gitleaks not installed; CI job defined, never run) · CI YAML: not validated (no actionlint)

## NEXT EXACT ACTION

Task ID: WP-03.3
Phase prompt: prompts/phases/PHASE-03-DATABASE-CORE-SERVICES.md
Model: Sonnet 5.5
Precondition: dev DB up (`docker compose -f deploy/compose.dev.yml up -d db`); `apps/api/.env` present (git-ignored). New deps likely: `@fastify/multipart`, `sharp` (check `pnpm audit --prod` after install).
Objective: attachments (storage adapter, upload/download routes, dedupe, link), migration `0002_attachments.sql`
Files to read: the WP-03.3 Context list only (SECURITY.md section 5; DATA_MODEL section 1 attachment tables; INTERFACES section 2 core rows)
Notes from 03.2: services live in `apps/api/src/modules/core/{audit,numbers,settings,jobs,notifications}.ts`, exported as `core` from `modules/core/index.ts`; they take a Kysely `Tx` and write audit in the same transaction. Actor context is ambient (`runWithContext`/`getContext` in `core/context.ts`) or passed as `ctx`; the Phase 04 auth plugin must wrap requests in `runWithContext`. Pass jsonb params through `JSON.stringify` (node-postgres turns JS arrays into PG arrays). Notifications and jobs are system plumbing and are not audited. `JobWorker` is not started by `server.ts` yet (no handlers exist); wire it when the first handler lands. No HTTP routes for core yet (`/notifications` waits for the auth seam, WP-04.3). Integration tests: Node and container clocks can differ by 100+ ms, so use offsets of seconds when mixing JS dates with DB `now()`.
After this: WP-03.4
