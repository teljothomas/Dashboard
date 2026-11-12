# Review Task Packet

Review ID: REV-04
Reviewer model: Opus (opus-architect)
Scope: Phase 04 (WP-04.1 .. WP-04.6), commits 3761dbf..HEAD on main (authorization plugin, identity, auth, admin, web auth)
Output file: `docs/reviews/REV-04.md` (findings + verdict; do not edit source code)

Context (read only these):
- docs/SECURITY.md §2 (authentication, sessions, CSRF, lockout), §3 (authorization, scope), §4 as needed
- docs/INTERFACES.md §2 identity rows, §3 (permission catalogue, role matrix, limiter semantics)
- docs/DATA_MODEL.md §2 identity tables; ADR-050..052, ADR-063 in docs/DECISIONS.md
- apps/api/src/plugins: session.ts, csrf.ts, rateLimit.ts, authorize.ts, requestContext.ts, errorHandler.ts
- apps/api/src/lib/scope.ts
- apps/api/src/modules/identity: auth.ts, sessions.ts, password.ts, users.ts, adminUsers.ts, adminSessions.ts, roles.ts, adminRoutes.ts, routes.ts, seed.ts, catalogue.ts, auditView.ts
- apps/api/migrations/0004_identity.sql
- Tests as evidence: modules/identity/security.integration.test.ts (TS-S01/S02/S04), roleMatrix.test.ts + its snapshot, auth.integration.test.ts, admin.integration.test.ts, plugins/authorize.test.ts
- Web: apps/web/src/features/auth (authStore.ts, RequireAuth.tsx, SignOutButton.tsx), apps/web/src/features/admin, apps/web/src/app/App.tsx (SessionEffects)

Review against: ADR-050..052, INTERFACES §3, SECURITY §2-3, BR-100, TS-S01, TS-S02, TS-S04.

Specific questions (owner decisions open; give a recommendation for each):
1. One device per user is not enforced: a device row keeps its first owner. Is that acceptable, or must a login on another user's device id be refused or re-bound?
2. ADMIN may assign any system role (incl. ADMIN, ACCOUNTANT) and compose a custom role from any permission; only OWNER is protected (OWNER_ONLY, SELF_MODIFICATION, LAST_OWNER guards). Is that privilege-escalation surface acceptable (ADMIN can mint a role holding `report.financial.view` or `tally.posting.manage`), or must ADMIN be limited to roles/permissions it holds itself?
3. Web keeps a local identity copy (`tradex.identity` in localStorage, no CSRF token) for offline start; offline logout is refused. Review what a stolen or tampered copy gives an attacker (UI only? any server authority?) and the shared-device case.
4. `request.ip` ignores proxies (trustProxy to be set in Phase 14); IP lockout and limiter behave how behind a proxy meanwhile?
5. Session fixation, token entropy and storage (hashed), cookie flags, logout, password change revoking other sessions, reset-code flow (admin-issued, single use, 30 min), timing and enumeration leaks.
6. Does every route carry a correct `config.auth` declaration and a scope where the record has an owner/division? Any route where 403 vs 404 leaks existence?

Known and accepted limits (do not re-report unless you disagree):
- `COMMON_PASSWORDS` is a short list (to be replaced before go-live).
- Playwright e2e uses a fake API; no browser run against the real API yet.
- No `GET /divisions` endpoint; the admin UI keeps existing division limiters but cannot choose one for a new assignment.
- gitleaks/actionlint not installed locally; CI never run on GitHub.

Checklist:
- Contract conformance (schemas, error codes, states)
- Security (authz + scope on every route, input validation, secrets, logging)
- Data integrity (constraints, transactions, idempotency, race conditions on lockout, last owner, single-use codes)
- Tests cover acceptance criteria and failure scenarios
- No scope creep, no fake implementations

Output (≤ 30 lines): findings as `path:line — severity (CRITICAL/HIGH/MEDIUM/LOW) — problem — required fix`;
then one line per open question above with a recommendation; verdict APPROVED / APPROVED_WITH_FIXES / REJECTED.
Sonnet fixes CRITICAL/HIGH before closing the phase gate.
