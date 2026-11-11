# PHASE-01 — Architecture and Interface Contracts

## A. Identity
- Objective: own and evolve the architecture baseline; no ambiguous contract left for module agents.
- Assigned model: Opus. Sonnet never executes WPs in this file (it only raises escalations).
- Prerequisites: none. Gate: WP-01.1 COMPLETE (done).
- Outputs live in docs/*.md and prompts/*; this phase writes no application code.

## B. Context rules
Opus reads STATUS.md, then only the docs sections touched by the WP. Do not reload the whole doc set.

---

### WP-01.1 — Architecture baseline v1.0 — COMPLETE (ARCH-000, 2026-11-11)
Delivered: BUSINESS_REQUIREMENTS, ARCHITECTURE, DECISIONS (ADR-001..063), DATA_MODEL, INTERFACES, SYNC_DESIGN,
TALLY_INTEGRATION, OFFLINE_DESIGN, SECURITY, QUALITY_GATES, DEPLOYMENT, DEVELOPMENT_PLAN, OPEN_DECISIONS,
prompt library (registry, protocols, templates, 16 phase prompts), agent definitions, architecture reviews
A–E in `docs/reviews/REV-ARCH-000.md`.

### WP-01.R — Fold answered open decisions into the architecture (repeatable)
Size M · Model Opus · Trigger: any row in OPEN_DECISIONS.md marked ANSWERED (owner/CA filled discovery files).
Context: OPEN_DECISIONS.md (answered rows), DECISIONS.md, the doc sections and phase WPs listed in each row's "Blocks".
Tasks:
1. For each answered OD: write an ADR (decision, source, date) in DECISIONS.md; change OD status to INCORPORATED (ADR-xxx).
2. Update only affected sections (e.g., TALLY_INTEGRATION §5 voucher types, DATA_MODEL enums, phase WP provisional notes).
3. If an answer invalidates completed work, create a corrective WP in the affected phase file (`WP-NN.Cn`) with
   context/acceptance, and insert it into STATUS.md NEXT EXACT ACTION if it must precede current work.
4. Bump PROMPT_REGISTRY §4 version.
Acceptance: no provisional assumption remains for answered ODs; STATUS consistent with registry.
Exclusions: no code; never answer accounting questions on the CA's behalf.

### WP-01.X — Escalation review (repeatable)
Size S–M · Model Opus · Trigger: `docs/escalations/ESC-<n>.md` with status OPEN.
Context: the ESC file + the doc sections it cites.
Tasks: decide; update DECISIONS/contracts/phase WP as needed; write resolution into the ESC file; set the blocked
WP back to READY in STATUS.md.
Acceptance: ESC status RESOLVED with ADR reference; Sonnet can resume without further questions.

## E. Phase acceptance criteria
Every module boundary, API, sync state, Tally contract and security boundary is specified in docs; open items
are only in OPEN_DECISIONS.md with provisional assumptions.

## F. Verification
Consistency spot-checks: posting states identical in SYNC_DESIGN §3 / DATA_MODEL §4 / INTERFACES §5;
status labels identical in BR-301 / SYNC_DESIGN §2.4 / OFFLINE_DESIGN.

## G. Completion requirements
Record each WP-01.R/X run in TASK_LOG; keep STATUS NEXT EXACT ACTION unchanged unless a corrective WP must run first.

## H. Failure handling
If an answer conflicts with a fixed requirement (BR-0xx), do not override it: record the conflict for the owner
in STATUS OWNER APPROVAL REQUIRED.
