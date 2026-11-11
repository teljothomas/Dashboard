# Deployment and Operations Design (v1.0)

Nothing here is executed before Phase 14. Purchases, DNS and production deploys need owner approval.

## 1. Environments

| Env | Where | Data | Tally |
|---|---|---|---|
| dev | developer PC: `deploy/compose.dev.yml` (Postgres only) + `pnpm dev` | synthetic seed | TallySimulator |
| staging | VPS, compose project `tradex-staging`, DB `tradex_staging`, `staging.<domain>` | synthetic/anonymised | test company, posting TEST_ONLY |
| production | same VPS, compose project `tradex-prod`, DB `tradex_prod`, `erp.<domain>` | live | authoritative company; PRODUCTION after owner approval |

Staging and production on one VPS is a cost trade-off (OD-030): separate DBs, separate env files, separate
DB roles, staging memory-limited. Upgrade path: separate staging VPS if budget allows.

## 2. VPS sizing and cost

Target: 2 vCPU, 4 GB RAM, 80 GB SSD, Indian region (Mumbai/Bangalore/Chennai), plus off-site object storage
(~20–50 GB). Budget ₹1,200–2,000/month (BR-400) — real quotes must be gathered in WP-14.1 and recorded in
OD-030 including GST, backups, bandwidth. No pricing is assumed in this document.

## 3. Compose services (production)

`caddy` (TLS, serves `apps/web/dist`, proxies `/api` and `/connector` to api), `api` (Node, non-root,
read-only FS except `/data/attachments`), `postgres:16` (volume, not published to host network),
`backup` (cron: nightly `pg_dump -Fc` + attachments → restic repo on object storage; retention 7 daily,
4 weekly, 12 monthly). Health checks on all. Log rotation 10 MB × 5.

## 4. Release procedure

1. CI green on `main` (lint, typecheck, unit, integration, e2e, audit, gitleaks, build).
2. Build image tagged with git SHA; push to registry (GHCR) or build on VPS.
3. Pre-deploy backup (`backup now`), verify dump file size > 0.
4. `migrate` one-shot container (migration role) → `up -d api` → smoke test `/health` + login + dashboard.
5. Record release in STATUS.md and `docs/TASK_LOG.md`.
Rollback: redeploy previous image tag. Migrations are forward-only and must be backward-compatible with the
previous release (expand → migrate → contract over two releases); if a migration must be undone, restore
from the pre-deploy backup (documented drill).

## 5. Backup and restore

- Nightly DB + attachments to off-site restic repo (encrypted). Agent journal is local and disposable
  (cloud is source of queue truth; journal only protects in-flight items).
- Monthly restore drill to a scratch DB: restore, run `pnpm --filter api db:verify` (row counts, balanced
  events check, FK check). Result recorded in STATUS QUALITY GATE.
- Tally company data backup remains the owner's Tally routine (OD-005); the ERP never replaces it.

## 6. Monitoring

- Uptime: external HTTP check on `/health` (free tier service, OD-031) + Healthchecks-style ping from the
  backup job.
- Errors: structured logs; optional Sentry (OD-031).
- Business alerts (in-app + dashboard): agent not seen > 24 h, DEAD/REJECTED postings, UNCERTAIN > 1 h,
  BLOCKED_MAPPING items, backup failure, disk > 80 %.

## 7. Agent deployment (Tally PC)

Self-contained single-file publish; install script registers Windows Service (delayed auto-start,
restart on failure), creates firewall block rule for the Tally port, creates `%ProgramData%\TradeXAgent`
with restricted ACL, prompts for registration code. Upgrade: stop service (graceful, releases lease) →
replace binary → start → verify `status`. Uninstall keeps journal unless `-Purge`.

## 8. Runbooks (written in Phase 15 under `docs/runbooks/`)

Tally PC replaced; agent revoked/re-registered; posting stuck UNCERTAIN; restore from backup; VPS rebuild;
password reset for owner; rotate secrets.
