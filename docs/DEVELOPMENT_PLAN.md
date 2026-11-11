# Development Plan (v1.0)

## 1. Execution order (PROMPT_REGISTRY is authoritative)

```
00 Governance (Sonnet part) -> 02 Foundation -> 03 DB/Core -> 04 Auth -> 05 Tally read
 -> 06 Meat inventory -> 10 Expenses/approvals/advances -> 07 Factory/labour -> 08 Drivers/fleet/loans
 -> 09 Trips -> 11 Tally posting -> 12 Offline hardening -> 13 Reports/recon -> 14 Hardening -> 15 Pilot
01 Architecture: baseline done by Opus (ARCH-000); WP-01.R re-runs whenever open decisions are answered.
```
Reasons for deviations from numeric order: ADR-060 (10 before 07/08/09), ADR-061 (offline core in 03).
Phase 03 routes use a request-context seam until Phase 04 replaces it (WP-04.3 enforces 401 on all routes).

## 2. Phase summary

| Phase | Model (secondary) | WPs | Depends on | Owner gate inside phase |
|---|---|---|---|---|
| 00 | Sonnet (Haiku) | 4 | ARCH-000 | Discovery answers requested (non-blocking) |
| 01 | Opus | baseline + R + X | — | Answers to OPEN_DECISIONS |
| 02 | Sonnet (Haiku) | 5 | 00 | — |
| 03 | Sonnet (Haiku) | 6 | 02 | — |
| 04 | Sonnet (Opus review) | 6 | 03 | Owner creates own password at bootstrap |
| 05 | Sonnet (Opus review, Haiku) | 9 | 04 | G1: .NET SDK install; G2: Tally PC test company access (WP-05.7) |
| 06 | Sonnet (Haiku) | 6 | 05 (05.7 not required) | Product list OD-040 (provisional allowed) |
| 10 | Sonnet (Haiku) | 6 | 06 | — |
| 07 | Sonnet (Haiku) | 5 | 10 | — |
| 08 | Sonnet (Haiku) | 6 | 10 | — |
| 09 | Sonnet (Haiku) | 5 | 08 | — |
| 11 | Sonnet (Opus critical review) | 6 | 09, 05 | G3: CA test mapping; test-company posting needs 05.7 |
| 12 | Sonnet (Haiku) | 5 | 11 | — |
| 13 | Sonnet (Opus review) | 6 | 12 | Bank statement format sample |
| 14 | Sonnet (Opus review, Haiku) | 6 | 13 | G4: VPS purchase/domain (OD-030); staging deploy approval |
| 15 | Sonnet (Opus final) | 6 | 14 | G5: production deploy; G6: production posting enable; opening balances (OD-018) |

Blocked owner gates never stop unrelated work: Sonnet marks the WP BLOCKED in STATUS.md, records the
request under OWNER APPROVAL REQUIRED and continues with the next unblocked WP in registry order.
Production posting, production deploy and live data import are the only hard stops.

## 3. Model allocation

- Opus: ARCH-000 (done), WP-01.R/01.X, review WPs named in phase files (05.8, 04.6 review, 11.6 review,
  13.6, 14.3, 15.5). Never routine coding.
- Sonnet: all implementation WPs, orchestration, test execution, STATUS updates, Haiku packets and review.
- Haiku: only tasks marked `Haiku-eligible` inside WPs, issued as packets per HAIKU_ASSISTANCE_PROTOCOL.

## 4. Token discipline

Rules are in CLAUDE.md and SONNET_EXECUTION_PROTOCOL.md. Structural controls:
1. STATUS.md first; registry selects the prompt; WP lists its exact context files (context packet).
2. Requirement IDs (BR-*), decision IDs (ADR-*), test IDs (TS-*) are referenced, not restated.
3. Module boundaries (ARCHITECTURE §4) mean a WP loads one module + contracts.
4. Each WP has a size class and context budget: S ≤ 8k (Haiku-able), M 8–18k, L 15–25k tokens of loaded context.
5. Focused tests during a WP; full suite only at phase gates.
6. Closed WPs are summarised in one TASK_LOG line; nobody re-reads old diffs.

## 5. Token measurement plan

- Data source: Claude Code transcripts (`~/.claude/projects/<project-dir-slug>/*.jsonl`), per assistant
  message `usage` (input, cache creation, cache read, output). WP-00.3 builds `tools/token-report.mjs`
  (read-only parser) that sums usage for a session or time window and counts Read tool calls per file.
- Per WP, Sonnet records in TASK_LOG: input tokens (incl. cache), output tokens, files read, files
  modified, repeated reads (same file read > 1×), out-of-packet reads, rework flag (WP reopened), tests
  passed/failed, wall time.
- Waste indicators (targets): out-of-packet reads ≤ 10 % of reads; repeated reads ≤ 15 %; rework ≤ 10 % of
  WPs; median tokens per WP tracked by size class (S/M/L) only — never compare across classes.
- The "40–50 % less unnecessary tokens" goal is a target, not a promise. Comparison method: per size class,
  trend of median tokens/WP and waste indicators across phases; optional controlled A/B (one M-class WP run
  once without the context packet on a throwaway branch) only if the owner approves the extra cost.
- Review at end of each phase: one line in TASK_LOG "Phase NN token summary".

## 6. Risk register

| ID | Risk | Mitigation | Owner attention |
|---|---|---|---|
| R1 | TallyPrime 7.0 JSON behaviour differs from assumptions | Spike WP-05.1 first; simulator built from verified fixtures; XML fallback | Provide test company early |
| R2 | No test company available | Simulator-only development; production posting blocked until real test passes | OD-006 |
| R3 | Multiple Tally copies exist | Never merge; accountant reconciles; agent fingerprint lock | OD-004 |
| R4 | Accounting treatments undecided | Provisional assumptions in test only; mapping approval gate | CA engagement needed before Phase 11 production |
| R5 | Tally PC rarely switched on | Dashboard staleness, alerts after 24 h, owner habit | Turn on PC daily |
| R6 | Low-end phones / storage eviction | persistent storage request, small bundles, image compression | — |
| R7 | Single VPS failure | Nightly off-site backups, tested restore, rebuild runbook | OD-030 |
| R8 | Staff adoption | Mobile-first minimal forms, role-specific screens, pilot | Phase 15 |
| R9 | .NET SDK absent on dev PC | WP-05.0 installs with owner approval | G1 |
