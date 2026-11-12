# Quality Gates (v1.0)

## 1. Canonical commands

Status PLANNED = defined here, created by Phase 02, not yet verified. Phase 02 must create exactly these
script names and change status to VERIFIED with the date. Later prompts must check a command is VERIFIED
before relying on it; if not, stop and fix Phase 02 output rather than inventing a command.

Environment (dev PC, recorded 2026-11-11, WP-00.4; updated 2026-11-12): Node v24.11.0 · pnpm 12.8.1 · git 2.51.0.windows.1 ·
Docker 28.4.0 (daemon running as of 2026-11-11, WP-02.4) · .NET SDK 10.0.404 installed (2026-11-12).
CI workflow `.github/workflows/ci.yml`: YAML parses, `docker compose config` ok for compose.dev.yml; NOT validated with
`actionlint` (not installed) and has never run on GitHub.

| Purpose | Command | Status |
|---|---|---|
| Install | `pnpm install --frozen-lockfile` | VERIFIED 2026-11-11 |
| Lint | `pnpm lint` | VERIFIED 2026-11-11 (confirmed it fails on an injected `any`) |
| Typecheck | `pnpm typecheck` | VERIFIED 2026-11-11 |
| Unit tests (all) | `pnpm test` | VERIFIED 2026-11-11 (Phase 03 gate: domain 57, contracts 40, api 69, web 105; 0 fail) |
| Unit tests (one package) | `pnpm --filter <api|web|contracts|domain> test <pattern>` | VERIFIED 2026-11-11. Corrected: with pnpm 12.8.1 the `--` before the pattern is forwarded to vitest and the pattern is ignored (all files ran); omit it |
| API integration tests (needs test DB) | `pnpm --filter api test:integration` | VERIFIED 2026-11-11 (Phase 03 gate: 150 pass, run twice; root `pnpm test:integration` passes through; reads `DATABASE_URL_TEST`) |
| Start test DB | `docker compose -f deploy/compose.dev.yml up -d db` | VERIFIED 2026-11-11 (postgres:16.10, healthy, bound 127.0.0.1:5432 only; DBs tradex_dev + tradex_test; `tradex_app` connects, DML works, DDL and DROP denied; `tradex_owner` DDL works) |
| Migrations | `pnpm --filter api db:migrate` | VERIFIED 2026-11-11 (empty database: applies 0001, 0002, 0003; second run reports no pending; runs as `tradex_owner` via `DATABASE_URL_MIGRATE`) |
| E2E | `pnpm --filter web e2e` | VERIFIED 2026-11-11 (builds, then Playwright on `vite preview`; local run uses installed Chrome, CI uses Chromium) |
| Build | `pnpm build` | VERIFIED 2026-11-11 (Phase 03 gate: web initial JS 147.48 KB gzip) |
| Dependency audit | `pnpm audit --prod` | VERIFIED 2026-11-11 (no known vulnerabilities) |
| Secret scan | `gitleaks detect --no-banner` | NOT VERIFIED locally: gitleaks not installed on dev PC. CI job `secret-scan` (gitleaks-action) is defined in `.github/workflows/ci.yml` but has not run (no remote run yet) |
| Agent build/test | `dotnet build agent/TradeX.TallyAgent.sln` / `dotnet test agent/TradeX.TallyAgent.sln` | PLANNED (.NET 10.0.404 SDK installed 2026-11-12; solution to be created in WP-05.3) |

Environment facts observed 2026-11-11 on dev PC: Node v24.11.0, pnpm 12.8.1, npm 11.6.1, git 2.51.0,
Docker CLI present (daemon state not verified), dotnet NOT installed, psql NOT installed.

## 2. Gate levels

**Work-unit gate (every WP):** lint + typecheck clean for touched packages; focused tests for the WP pass;
new behaviour has tests; no skipped/`only` tests; STATUS.md + TASK_LOG.md updated.

**Phase gate (end of each phase):** full `pnpm lint`, `pnpm typecheck`, `pnpm test`, integration tests,
phase-specific scenario tests (§4) all executed and passing; migrations apply on empty DB; build succeeds;
any Opus review named by the phase completed and findings closed or recorded.

**Release gate (Phase 14/15):** all above + E2E critical flows, security tests, backup→restore drill on a
fresh host, agent recovery scenarios on test company, dependency audit clean or exceptions signed off,
documentation review.

## 3. Mandatory engineering checks (reviewer checklist)

Strict TS (no `any` without comment); Zod validation at every boundary; authz + scope on every route;
parameterised SQL; decimal money; FK/unique/check constraints; migrations forward-only and reversible plan
noted; audit entries; structured logs without secrets; idempotent financial ops; no mock data in prod paths;
error envelope; accessibility basics (labels, contrast, focus); tests for business rules.

## 4. Scenario test catalogue (owner phase in brackets)

Tally connector (simulator for automated; test company for acceptance):
TS-T01 PC off 24 h [05/11] · TS-T02 Tally closed mid-run [05/11] · TS-T03 Windows restart mid-sync [11] ·
TS-T04 internet drop during import [05] · TS-T05 ack lost [11] · TS-T06 double submit [11] ·
TS-T07 wrong company [05] · TS-T08 unmapped ledger [11] · TS-T09 rejected voucher [11] ·
TS-T10 reconnect after outage [05/11] · TS-T11 two agents [05] · TS-T12 voucher modified in Tally [05/11] ·
TS-T13 journal interrupted [11] · TS-T14 upgrade/restart [14].
Expected behaviour: SYNC_DESIGN §7.

Offline: TS-O01..TS-O08 [03 basic, 12 full]. Expected behaviour: OFFLINE_DESIGN §6.

Accounting (unit tests on `packages/domain` + integration on events):
TS-A01 driver advance + settlement (BR-026 numbers) [10] · TS-A02 labour advance recovery via wages [07] ·
TS-A03 EMI principal vs interest [08] · TS-A04 internal trip allocation, no revenue/no event [09] ·
TS-A05 external trip linked to imported Tally invoice, link unique [09] · TS-A06 expense reversal [10/11] ·
TS-A07 duplicate voucher prevention [11] · TS-A08 receipt imported once [05] · TS-A09 supplier payment
imported once [05] · TS-A10 sales/purchase import without duplicate stock movements [06].

Security: TS-S01 driver → owner reports = 403 [04/13] · TS-S02 other user's record = 404 [04+each module] ·
TS-S03 invalid uploads (type spoof, size, polyglot) [03] · TS-S04 expired/revoked session [04] ·
TS-S05 connector registration abuse (reused/expired code, brute force, bad signature, replayed nonce) [05] ·
TS-S06 secret leakage (gitleaks, logs grep, error bodies) [14] · TS-S07 unauthorized API ops matrix [14].

## 5. Recording results

STATUS.md QUALITY GATE section records only executed results (date, command, pass/fail counts).
TASK_LOG.md records per-WP test evidence (one line). Never record a result that was not executed.
