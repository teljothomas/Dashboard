# Prompt Registry (v1.0)

Controls which prepared prompt runs next. STATUS.md → NEXT EXACT ACTION names a WP ID; this registry maps
it to a file. If STATUS.md and this registry disagree, STOP (SONNET_EXECUTION_PROTOCOL §Conflicts).

## 1. Execution order

| Order | Phase | File | Model | WPs (in order) | Entry condition |
|---|---|---|---|---|---|
| 0 | 01 | phases/PHASE-01-ARCHITECTURE-FOUNDATION.md | Opus | 01.1 (DONE by ARCH-000) | — |
| 1 | 00 | phases/PHASE-00-GOVERNANCE-DISCOVERY.md | Sonnet | 00.1 → 00.4 | ARCH-000 complete |
| 2 | 02 | phases/PHASE-02-APPLICATION-FOUNDATION.md | Sonnet | 02.1 → 02.5 | Phase 00 gate |
| 3 | 03 | phases/PHASE-03-DATABASE-CORE-SERVICES.md | Sonnet | 03.1 → 03.6 | Phase 02 gate |
| 4 | 04 | phases/PHASE-04-AUTHENTICATION-PERMISSIONS.md | Sonnet | 04.1 → 04.6 | Phase 03 gate |
| 5 | 05 | phases/PHASE-05-TALLY-CONNECTOR-READ.md | Sonnet | 05.0 → 05.8 | Phase 04 gate |
| 6 | 06 | phases/PHASE-06-MEAT-INVENTORY.md | Sonnet | 06.1 → 06.6 | Phase 05 gate (05.7 may be BLOCKED) |
| 7 | 10 | phases/PHASE-10-EXPENSES-APPROVALS.md | Sonnet | 10.1 → 10.6 | Phase 06 gate |
| 8 | 07 | phases/PHASE-07-FACTORY-LABOUR.md | Sonnet | 07.1 → 07.5 | Phase 10 gate |
| 9 | 08 | phases/PHASE-08-DRIVERS-FLEET-LOANS.md | Sonnet | 08.1 → 08.6 | Phase 07 gate |
| 10 | 09 | phases/PHASE-09-TRIPS-LOGISTICS.md | Sonnet | 09.1 → 09.5 | Phase 08 gate |
| 11 | 11 | phases/PHASE-11-TALLY-POSTING.md | Sonnet | 11.1 → 11.6 | Phase 09 gate |
| 12 | 12 | phases/PHASE-12-OFFLINE-PWA.md | Sonnet | 12.1 → 12.5 | Phase 11 gate (11.6 test-company part may be BLOCKED) |
| 13 | 13 | phases/PHASE-13-REPORTS-RECONCILIATION.md | Sonnet | 13.1 → 13.6 | Phase 12 gate |
| 14 | 14 | phases/PHASE-14-INTEGRATION-HARDENING.md | Sonnet | 14.1 → 14.6 | Phase 13 gate |
| 15 | 15 | phases/PHASE-15-PILOT-ACCEPTANCE.md | Sonnet | 15.1 → 15.6 | Phase 14 gate + owner approvals |

Out-of-band (any time, Opus): WP-01.R (fold answered OPEN_DECISIONS into docs), WP-01.X (escalation review),
review WPs listed in phase files (run via `.claude/agents/opus-architect.md` or an Opus session).

## 2. Selection rules

1. Take `Task ID` from STATUS.md NEXT EXACT ACTION. Open the file mapped above; jump to that WP heading.
2. When a WP closes, the next task is the next WP in the same file. After the last WP, run that phase's
   gate WP; if it passes, the next task is the first WP of the next row in §1.
3. If the next WP is BLOCKED by an owner gate: record it, then take the next WP whose `Prerequisites`
   are satisfied (same phase first, then next phase only if the phase file marks the blocked WP as
   "non-blocking for next phase"). Never skip a phase gate.
4. Hard stops (do not continue): production deploy, production posting enable, live data import,
   purchases, unresolved architecture conflict, critical defect outside scope.

## 3. Shared files every WP may use without listing

`STATUS.md`, this registry, its own phase file section, `docs/TASK_LOG.md` (append only, do not read history),
`prompts/templates/*` when producing packets/handoffs.

## 4. Version

Prompt library v1.0 — 2026-11-11 — authored by Opus 5.5 (ARCH-000). Changes only via WP-01.R / 01.X.
