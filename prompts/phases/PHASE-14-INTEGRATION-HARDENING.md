# PHASE-14 — System Integration and Production Hardening

## A. Identity
- Objective: deploy artefacts, end-to-end suite, security testing, performance, backup/restore, monitoring, agent upgrade,
  staging deployment, documentation review — the release gate.
- Assigned model: Sonnet. **Opus security/architecture review REV-14** (WP-14.3). Haiku for mechanical tasks.
- Prerequisites: Phase 13 gate. Owner gates: G4 VPS purchase + domain (OD-030) and approval to deploy staging (WP-14.6).
- Docs: DEPLOYMENT (all), SECURITY (all), QUALITY_GATES §2 release gate, §4 TS-S/TS-T14.

## B. Context rules
STATUS.md → registry → this WP → Context only. No feature work; defects found become `WP-14.Dn` entries in this file's log
section (append) and are fixed within scope.

## C/D. Phase-wide requirements
No secrets in images or git; containers non-root; Postgres not publicly reachable; Tally port never published; production data
never used in tests.

---

### WP-14.1 — Deployment artefacts and VPS options
Size M · Haiku: yes (env templates, checklist formatting)
Context: DEPLOYMENT §1–4; SECURITY §1, §6.
Modify: `apps/api/Dockerfile`, `deploy/compose.prod.yml`, `deploy/compose.staging.yml`, `deploy/Caddyfile`, `deploy/backup/*`,
`deploy/env.example`, `apps/api/src/cli/db-verify.ts` (`db:verify`: FK check, balanced events, counts), `docs/runbooks/VPS_SETUP.md`.
Tasks: multi-stage images pinned by digest; compose with healthchecks, resource limits, log rotation; Caddy security headers +
CSP; backup container (pg_dump + attachments + restic); VPS hardening runbook; research 2–3 Indian-region VPS + object storage
options with current published prices and links for the owner (record in OD-030; no purchase).
Acceptance: `docker compose -f deploy/compose.prod.yml config` valid; local full-stack run with prod compose against throwaway volume passes smoke test.
Next: WP-14.2.

### WP-14.2 — End-to-end critical flows
Size L · Haiku: yes (page objects)
Tasks: Playwright suite on full stack (API + web + simulator agent harness): login per role; offline expense → approve → posted
(simulator); driver advance → settlement → posted; external trip → invoice link; wage cycle; inventory Tally line assignment;
reversal. Run in CI.
Next: WP-14.3.

### WP-14.3 — Security testing and Opus review
Size L · Opus REV-14
Tasks: generated authorization matrix test (every route × every system role → expected 2xx/403/404) = TS-S07; TS-S01, TS-S02, TS-S03, TS-S04, TS-S05, TS-S06 complete;
gitleaks over history; log scan for secrets/tokens; dependency audits (pnpm, dotnet) with documented exceptions; ASVS L1 checklist
`docs/reviews/ASVS-L1.md`; agent: key file ACL check script, loopback enforcement test. Opus reviews and signs REV-14.
Next: WP-14.4.

### WP-14.4 — Performance
Size M · Haiku: yes (seed generator variations)
Tasks: deterministic seed generator for 10× yearly volume; p95 < 500 ms for list/detail endpoints, < 1 s reports; add indexes from
EXPLAIN ANALYZE; sync push of 50 mutations < 2 s; record results.
Next: WP-14.5.

### WP-14.5 — Backup/restore, monitoring, agent upgrade
Size M
Tasks: backup → restore on fresh volume → `db:verify` drill (record timings); alert jobs (agent unseen > 24 h, UNCERTAIN > 1 h, DEAD,
BLOCKED_MAPPING, backup failure, disk > 80 %); `/health` uptime check instructions; agent upgrade procedure tested on simulator
(TS-T14: lease released, journal intact, re-verify).
Next: WP-14.6.

### WP-14.6 — Staging deployment, documentation review, release gate
Size M · Requires owner approval G4 (STATUS) before any VPS action.
Tasks: if approved: provision per runbook, deploy staging, smoke test, connect agent to test company with TEST_ONLY; if not approved:
mark this part BLOCKED and complete documentation review. Docs review: all docs consistent with implementation (update contracts
where implementation legitimately refined them, via notes). Release gate per QUALITY_GATES §2; STATUS next WP-15.1.

## E. Phase acceptance criteria
Release gate fully executed and recorded; REV-14 approved; restore drill passed; staging live (or explicitly blocked by owner gate).

## F. Verification commands
All QUALITY_GATES §1 commands; `docker compose -f deploy/compose.prod.yml config`; restore drill script.

## G. Completion requirements
Protocol Step 6; STATUS QUALITY GATE section fully populated with executed results and dates.

## H. Failure handling
Security CRITICAL/HIGH blocks the gate until fixed. Performance misses → index/query fixes first; no caching layer without ESC.
