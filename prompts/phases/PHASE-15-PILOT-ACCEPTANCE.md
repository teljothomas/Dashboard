# PHASE-15 — Pilot Acceptance and Release Readiness

## A. Identity
- Objective: UAT with each role, cut-over data, manuals and runbooks, verification against real Tally data, pilot readiness
  report, and (only with explicit owner approval) production go-live.
- Assigned model: Sonnet. **Opus final review REV-15** (WP-15.5).
- Prerequisites: Phase 14 release gate passed. Owner/CA inputs: OD-004, OD-005, OD-016, OD-018, OD-045 answered; CA sign-off on mappings.
- Protected operations (each needs an `owner_approval` record and a STATUS entry): production deploy (G5), live data import,
  agent registration to the production company, posting mode PRODUCTION (G6), ledger mapping publish.

## B. Context rules
STATUS.md → registry → this WP → Context only. No new features; defects become `WP-15.4.Dn`.

## C/D. Phase-wide requirements
Production company starts with posting DISABLED (read-only import) until G6. Every live action is logged in
`docs/evidence/`. Never import personal data beyond what the data model holds.

---

### WP-15.1 — Pilot plan and UAT scripts
Size M · Haiku: yes (script formatting)
Tasks: `docs/pilot/PILOT_PLAN.md` (duration, roles, success criteria, rollback = continue Tally-only), UAT scripts per role
(owner, accountant, factory manager, supervisor, driver) with step/expected/result columns covering BR-1xx modules, defect log template.
Next: WP-15.2.

### WP-15.2 — Cut-over tooling and dry run
Size L · Haiku: yes (CSV templates)
Context: OD-018, OD-045; DATA_MODEL relevant sections.
Tasks: CSV templates + validated import CLIs (workers, drivers, vehicles, documents, loan schedules + outstanding, open advances,
stock lots/opening stock, expense categories); dry-run on staging with CA-reviewed data; reconciliation report (counts, totals).
Live import is a protected operation (DATA_IMPORT).
Next: WP-15.3.

### WP-15.3 — Manuals, guides, runbooks
Size M · Haiku: yes (screenshot placement, glossary)
Tasks: `docs/manuals/` short role guides (mobile-first, task-based), backup/recovery guide for owner, support instructions (how to
report a problem, what to collect), runbooks from DEPLOYMENT §8.
Next: WP-15.4.

### WP-15.4 — UAT execution support and defect fixing
Size L (repeatable)
Tasks: support UAT sessions; log defects; fix in priority order with tests; each fix closes as `WP-15.4.Dn` in TASK_LOG.
Exit: all CRITICAL/HIGH fixed; MEDIUM accepted or fixed by owner decision.
Next: WP-15.5.

### WP-15.5 — Tally data verification, readiness report, Opus final review
Size M · Opus REV-15
Tasks: with owner approval register the agent to the production company (posting DISABLED); full read-only import; compare
ERP mirror against Tally (trial balance totals, party outstanding, cash/bank balances, voucher counts per type for the FY) —
evidence `docs/evidence/WP-15.5.md`; write `docs/pilot/PILOT_READINESS.md` (scope delivered, test evidence, open risks, open
decisions, go/no-go recommendation); Opus REV-15.
Next: WP-15.6.

### WP-15.6 — Production go-live (STOP for owner approval)
Size M
Tasks: present the readiness report and the exact go-live checklist to the owner; wait. After explicit approvals: production deploy,
live cut-over import, mapping publish (CA-approved), posting mode PRODUCTION, first-week hypercare checklist (daily sync health,
UNCERTAIN = 0, BLOCKED_MAPPING reviewed, backup verified). STATUS: Project state RELEASED_PILOT.

## E. Phase acceptance criteria
UAT passed per role; Tally verification evidence matches; readiness report approved; go-live only with recorded approvals.

## F. Verification commands
Release gate commands (QUALITY_GATES §1) on the release commit; `db:verify` on production after cut-over.

## G. Completion requirements
Protocol Step 6; STATUS shows release state and the next maintenance action.

## H. Failure handling
Any mismatch between ERP mirror and Tally → stop go-live, investigate import (never "adjust" ERP numbers to match).
