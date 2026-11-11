# PHASE-04 — Authentication and Permissions

## A. Identity
- Objective: users, roles, permissions with scopes, sessions, CSRF, rate limiting, password reset, admin UI,
  replacement of the Phase 03 request-context seam by real sessions.
- Assigned model: Sonnet. Opus review: REV-04 (WP-04.6). Haiku-eligible tasks marked.
- Prerequisites: Phase 03 COMPLETE.
- Requirements: BR-100. Decisions: ADR-050..052. Docs: SECURITY §2–4; INTERFACES §2 identity rows, §3; DATA_MODEL §2.

## B. Context rules
STATUS.md → registry → this WP → its Context only. Never paste secrets or test passwords into docs/logs.

## C/D. Phase-wide requirements
Argon2id params per ADR-051; constant-time comparisons; generic login errors; session token only in httpOnly cookie
(`__Host-tradex_sid`, Secure in prod, SameSite=Lax, Path=/); CSRF on every non-GET; all auth events audited
(login success/failure, logout, password change, reset issue/complete, role change). NOT_FOUND for out-of-scope reads.

---

### WP-04.1 — Identity schema, seeds, owner bootstrap
Size M · Haiku: yes (permission seed transcription from INTERFACES §3)
Context: DATA_MODEL §2; INTERFACES §3.
Modify: migration `0004_identity.sql`, `apps/api/src/modules/identity/**`, `apps/api/src/cli/create-owner.ts`, api package script `user:create-owner`.
Tasks:
1. Tables app_user, role, permission, role_permission, user_role, session, password_reset, device, login_attempt; add FK
   client_mutation.device_id → device (devices auto-registered on first authenticated request).
2. Seed permission catalogue and six system roles with the default matrix (scopes) from INTERFACES §3 — idempotent seed.
3. CLI `user:create-owner`: interactive (hidden input) username + password (policy SECURITY §2), assigns OWNER, sets
   must_change_password=false; refuses if an OWNER exists unless `--additional`.
Acceptance: migration + seed idempotent; CLI creates owner in test DB (scripted test passes password via stdin in test mode only).
Next: WP-04.2.

### WP-04.2 — Login, sessions, CSRF, rate limiting
Size L · Haiku: no
Context: SECURITY §2, §4; INTERFACES §2 identity rows; DECISIONS ADR-050/051.
Modify: `apps/api/src/plugins/session.ts`, `csrf.ts`, `rateLimit.ts`, `modules/identity/**`, `packages/contracts/src/identity.ts`.
Tasks:
1. `POST /auth/login`, `/auth/logout`, `GET /auth/me`, `POST /auth/change-password`; session create (token hash), sliding/absolute
   expiry, revoke on password change; rehash-on-login if params changed.
2. Session plugin populates `request.ctx` (user, roles, permissions+scopes, deviceId) — the same interface used by Phase 03 routes.
3. CSRF double-submit (`csrfToken` in `/auth/me` and login response; header check on non-GET; exempt `/connector/*` which uses signatures).
4. Rate limiting/lockout per SECURITY §2 (in-memory store + login_attempt persistence).
5. Tests: login success/failure, lockout after 5, IP limit, logout revokes, absolute expiry, CSRF missing → 403, password change
   revokes other sessions, timing-safe paths.
Acceptance: tests pass; no token or password in logs (log capture assertion).
Next: WP-04.3.

### WP-04.3 — Authorization and scopes
Size M · Haiku: no
Context: INTERFACES §3; SECURITY §3.
Modify: `apps/api/src/plugins/authorize.ts`, `apps/api/src/lib/scope.ts`, `apps/api/test/routes.inventory.test.ts`.
Tasks:
1. `authorize(permission, {scope})` route option; `scopeWhere(ctx, table, {ownerColumn, divisionColumn})` Kysely helper for lists/reads.
2. Self-approval guard helper `assertNotSelf(ctx, createdBy)` (OWNER exempt).
3. Route inventory test: enumerate all registered routes; every route not in the explicit public allowlist
   (`/health`, `/auth/login`, `/auth/reset/complete`, `/connector/*`) returns 401 without session and declares a permission.
4. Retrofit Phase 03 routes (attachments, sync) with permissions and scopes.
Acceptance: route inventory test passes and will fail for any future route lacking a permission declaration.
Next: WP-04.4.

### WP-04.4 — User and role management, password reset
Size M · Haiku: yes (CRUD route tests following an example)
Context: INTERFACES §2 identity rows; SECURITY §2; OPEN_DECISIONS OD-032 (provisional: admin-issued code).
Modify: `modules/identity/**`, contracts.
Tasks: users CRUD (disable, roles with optional division), custom roles (system roles immutable), reset-code issue (shown once)
and complete, force logout, list sessions/devices, revoke device, `GET /audit` filtered.
Acceptance: tests for each endpoint incl. permission denial and audit entries.
Next: WP-04.5.

### WP-04.5 — Web: login, guard, admin screens
Size M · Haiku: yes (user/role forms and lists from the first Sonnet-built screen)
Context: OFFLINE_DESIGN §5; INTERFACES §2 identity rows.
Modify: `apps/web/src/features/auth/**`, `features/admin/**`, `app/` guard + nav.
Tasks: login page (mobile), session bootstrap via `/auth/me`, CSRF token store, permission-aware navigation, change password
(forced when must_change_password), admin users/roles/sessions screens, logout warning when outbox has items (OFFLINE_DESIGN §5).
Tests: component tests + Playwright login → dashboard placeholder → logout.
Acceptance: e2e passes; screens usable at 360 px.
Next: WP-04.6.

### WP-04.6 — Security tests, Opus review, Phase 04 gate
Size M · Model Sonnet + Opus review (REV-04)
Context: QUALITY_GATES §4 (TS-S01, S02, S04); review template.
Tasks:
1. Tests: TS-S02 (other user's record via test entity → 404), TS-S04 (expired/revoked session → 401), TS-S01 baseline (DRIVER role
   lacks `report.financial.view`; matrix snapshot test of default role grants).
2. Create review packet for Opus (auth plugin, session, CSRF, rate limit, scope helper). Run via `opus-architect` agent if
   available; otherwise record "REV-04 pending" in STATUS OWNER APPROVAL REQUIRED (owner runs an Opus session) and continue —
   fix any CRITICAL/HIGH findings when the review arrives before Phase 05 gate.
3. Phase gate; STATUS next WP-05.0.
Acceptance: tests pass; REV-04 APPROVED or pending recorded.

## E. Phase acceptance criteria
All routes authenticated and permission-declared; scopes enforced on lists/reads; lockout and CSRF proven; owner bootstrap works.

## F. Verification commands
`pnpm --filter api test:integration && pnpm test && pnpm --filter web e2e && pnpm lint && pnpm typecheck`

## G. Completion requirements
Protocol Step 6. Never commit any real password; test credentials are generated per test run.

## H. Failure handling
If a Phase 03 route cannot be scoped cleanly, fix the route (not the test). Library vulnerability in argon2 binding → choose
the maintained alternative and record in TASK_LOG.
