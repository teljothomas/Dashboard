# PHASE-02 — Application Foundation

## A. Identity
- Objective: monorepo scaffolding, API and web foundations, shared packages, dev database, test tooling, CI —
  and verification of every canonical command in QUALITY_GATES §1.
- Assigned model: Sonnet. Haiku-eligible tasks marked.
- Prerequisites: Phase 00 COMPLETE. Docker daemon available for WP-02.4 (else mark 02.4 BLOCKED and do 02.5 partially).
- Decisions: ADR-001..006, ADR-010, ADR-062. Requirements: BR-013, BR-401.

## B. Context rules
STATUS.md → registry → this WP. Context packet only. No business modules in this phase.

## C/D. Phase-wide engineering requirements
TypeScript `strict`, `noUncheckedIndexedAccess`, ES modules, Node 24. Use current stable versions at install time;
lockfile committed. ESLint flat config (typescript-eslint recommended-type-checked) + Prettier. No `any` without
justification comment. Config validated with Zod at startup (fail fast). Logging with pino (redact
`req.headers.cookie`, `authorization`, `password`, `*.secret`). Vitest for unit tests.

---

### WP-02.1 — Monorepo scaffolding and shared packages
Size M · Haiku: yes (lint/format configs, editorconfig)
Context: ARCHITECTURE.md §3, DECISIONS.md ADR-002/010, this WP.
Modify: root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc`,
`.editorconfig`, `packages/contracts/**`, `packages/domain/**`.
Tasks:
1. Workspace: `apps/*`, `packages/*`. Root scripts: `lint`, `typecheck` (`pnpm -r typecheck`), `test` (`pnpm -r test`),
   `build` (`pnpm -r build`), `format`.
2. `packages/contracts`: `src/common.ts` with Zod primitives — `MoneyString` (ADR-010 regex), `QtyString`,
   `DateString`, `Uuid`, error envelope schema, error code enum (INTERFACES §1), `SyncStatus` enum (BR-301 labels).
3. `packages/domain`: `src/money.ts` (decimal.js; parse strict, add/sub/mul/div, round HALF_UP to 2 dp, compare,
   sum, toString fixed 2, format en-IN ₹), `src/ids.ts` (uuidv7 generation + validation).
4. Unit tests: money edge cases (0.1+0.2, negative, rounding .005, large 16 digits, invalid strings rejected), ids.
Acceptance: `pnpm lint`, `pnpm typecheck`, `pnpm test` pass at root; money tests ≥ 15 cases.
Verify: `pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm test`.
Next: WP-02.2.

### WP-02.2 — API foundation
Size M · Haiku: no
Context: ARCHITECTURE.md §5, §8; INTERFACES.md §1; SECURITY.md §4 (headers).
Modify: `apps/api/**` (no modules yet).
Tasks:
1. `apps/api`: Fastify 5 app factory `buildApp(config)` (testable via `app.inject`), `server.ts` entry, `config.ts`
   (Zod env: NODE_ENV, PORT, DATABASE_URL, LOG_LEVEL, PUBLIC_ORIGIN, ATTACHMENTS_DIR, SESSION_SECRET).
2. Plugins: requestId (accept/echo `X-Request-Id`), error handler → envelope with codes, 404 envelope,
   security headers (helmet-equivalent per SECURITY §4), body limit 1 MB (uploads override later), graceful shutdown.
3. `GET /health` → `{status:"ok"}` (DB check added in 03.1).
4. `AppError` class + typed codes from contracts. Pino logger with redaction.
5. Tests: health 200; unknown route envelope 404; thrown AppError mapping; unknown error → 500 with requestId only; headers present.
Acceptance: tests pass; `pnpm --filter api build` emits runnable JS; `pnpm --filter api dev` starts.
Next: WP-02.3.

### WP-02.3 — Web foundation
Size M · Haiku: yes (layout components, placeholder pages)
Context: OFFLINE_DESIGN.md §5 (UX rules), INTERFACES.md §1 (headers), ARCHITECTURE.md §3 (web layout).
Modify: `apps/web/**`.
Tasks:
1. Vite + React 19 + TS + Tailwind CSS 4 + React Router + TanStack Query. Mobile-first shell: top bar, bottom nav
   (≤ 5 items, role-driven later), content area, offline/sync banner placeholder component wired to a store.
2. `src/lib/api.ts`: fetch wrapper — credentials include, JSON, attaches `X-CSRF-Token` (from memory store) and
   `X-Device-Id`, parses envelope, throws typed `ApiError(code, details)`.
3. `src/lib/money.ts` re-exports domain money formatting; `src/lib/i18n.ts` minimal key-based strings (English only, OD-041).
4. Vitest + Testing Library setup; Playwright setup with one smoke test (app shell renders) using `vite preview`.
5. Dev proxy `/api` → API port.
Acceptance: `pnpm --filter web test`, `pnpm --filter web build`, `pnpm --filter web e2e` pass; bundle initial JS ≤ 200 KB gzip.
Next: WP-02.4.

### WP-02.4 — Dev infrastructure and CI
Size M · Haiku: yes (env example, README commands)
Context: DEPLOYMENT.md §1; QUALITY_GATES.md §1; SECURITY.md §6.
Modify: `deploy/compose.dev.yml`, `deploy/db-init/01-roles.sql`, `.env.example`, `apps/api/.env.example`,
`.github/workflows/ci.yml`, README.md (commands section only).
Tasks:
1. `compose.dev.yml`: `db` service postgres:16 (pinned minor), port 5432 on 127.0.0.1 only, volume, healthcheck;
   init script creates DBs `tradex_dev`, `tradex_test` and roles `tradex_owner` (DDL) and `tradex_app` (DML only).
2. `.env.example` files without real secrets.
3. CI (GitHub Actions; becomes active when a remote exists): node 24 + pnpm cache, install frozen, lint, typecheck,
   unit tests, integration tests with postgres service, build, `pnpm audit --prod` (non-blocking until Phase 14),
   gitleaks. Separate Windows job placeholder for agent added in Phase 05.
4. Root scripts `test:integration` passthrough; api `test:integration` (Vitest config `vitest.integration.config.ts`,
   uses `DATABASE_URL_TEST`; can be an empty passing suite until 03.1).
Acceptance: `docker compose -f deploy/compose.dev.yml up -d db` healthy; connection with app role works; CI YAML lints
(`actionlint` if available, else document "not validated").
Next: WP-02.5.

### WP-02.5 — Command verification and Phase 02 gate
Size S · Haiku: no
Context: QUALITY_GATES.md §1.
Modify: QUALITY_GATES.md §1 (Status column), STATUS.md.
Tasks: run every command in QUALITY_GATES §1 that exists after this phase; mark VERIFIED (date) or note why not
(e.g., migrations → Phase 03, agent → Phase 05). Phase gate per QUALITY_GATES §2. Commit.
Acceptance: all phase-02 commands VERIFIED; STATUS next action WP-03.1.

## E. Phase acceptance criteria
Clean install from lockfile; lint/typecheck/unit/e2e smoke/build green; dev DB up; CI file present; command table updated.

## F. Verification commands
`pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm --filter web e2e`

## G. Completion requirements
Per protocol Step 6. TASK_LOG notes chosen library versions (one line).

## H. Failure handling
Tooling version conflicts: pick the newest mutually compatible versions, record in TASK_LOG; do not downgrade
TypeScript strictness. If Docker cannot run, mark 02.4 BLOCKED (owner), continue to 02.5 for non-DB commands.
