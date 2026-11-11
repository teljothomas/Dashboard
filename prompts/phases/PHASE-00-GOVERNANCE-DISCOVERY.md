# PHASE-00 — Governance, Discovery and Project Readiness

## A. Identity
- Objective: put the Opus-prepared governance package under version control, verify its integrity, issue
  discovery questionnaires, build token measurement, confirm the toolchain.
- Assigned model: Sonnet (execution). Opus part completed as ARCH-000.
- Secondary: Haiku-eligible only where marked.
- Prerequisites: ARCH-000 COMPLETE (STATUS.md). Gate to next phase: all WPs below COMPLETE (WP-00.2 answers
  NOT required to proceed).
- Requirements: BR-030..034 (discovery), DEVELOPMENT_PLAN §5 (tokens).

## B. Context rules
Read STATUS.md → PROMPT_REGISTRY.md → this file's WP only. Read only the WP's Context. No repo scans.
No application code in this phase (the token tool is project tooling, not application code).

## C/D. Phase-wide requirements
No changes to architecture docs except the specific lines named. No contact with Tally. Questionnaires
must be plain-language and non-destructive. Any script is read-only over user data and prints no message content.

---

### WP-00.1 — Governance integrity check and git initialisation
Size S · Model Sonnet · Haiku: no
Context: STATUS.md, prompts/PROMPT_REGISTRY.md.
Modify: `.gitignore`, `.gitattributes`, STATUS.md, docs/TASK_LOG.md, docs/DECISIONS.md (ADR-063 status line only).
Tasks:
1. Verify these exist (one listing command): STATUS.md, CLAUDE.md, README.md, docs/{ARCHITECTURE, BUSINESS_REQUIREMENTS,
   DECISIONS, DEVELOPMENT_PLAN, DATA_MODEL, INTERFACES, SECURITY, SYNC_DESIGN, TALLY_INTEGRATION, OFFLINE_DESIGN,
   QUALITY_GATES, DEPLOYMENT, OPEN_DECISIONS, TASK_LOG}.md, prompts/{PROMPT_REGISTRY, SONNET_EXECUTION_PROTOCOL,
   HAIKU_ASSISTANCE_PROTOCOL}.md, prompts/templates/*.md (3), prompts/phases/PHASE-00..15 (16), .claude/agents/*.md (3).
2. Cross-check: for every phase row in PROMPT_REGISTRY §1, `grep -c "^### WP-"` in its file is ≥ the WP count
   listed. Report mismatches; if any, stop and escalate (ESC) — do not edit prompts.
3. `git init -b main`. `.gitignore`: node_modules, dist, build, coverage, .env, .env.*, !.env.example,
   *.db, *.sqlite, *.sqlite-*, agent/**/bin, agent/**/obj, playwright-report, test-results, .DS_Store, *.log.
   `.gitattributes`: `* text=auto eol=lf`, `*.ps1 text eol=crlf`, `*.sln text eol=crlf`, `*.png binary`, `*.jpg binary`, `*.pdf binary`.
4. First commit: `chore(governance): ARCH-000 architecture and prompt library v1.0`.
Acceptance: all files present; zero registry/WP mismatches; `git log --oneline` shows exactly 1 commit; `git status` clean.
Verify: `git log --oneline`, `git status --short`.
Next: WP-00.2.

### WP-00.2 — Discovery questionnaires (owner, CA, Tally PC)
Size S · Model Sonnet · Haiku: yes (formatting/plain-language pass after Sonnet drafts)
Context: docs/TALLY_INTEGRATION.md §2–3, docs/OPEN_DECISIONS.md.
Modify: new `docs/discovery/TALLY_DISCOVERY.md`, `docs/discovery/CA_QUESTIONS.md`, `docs/discovery/OWNER_QUESTIONS.md`, STATUS.md.
Tasks:
1. TALLY_DISCOVERY.md: DC-01..DC-15 as numbered plain-language questions; for each: why it matters (1 line),
   how to find it without changing anything (menu path or "ask"), answer box, screenshot checkbox. Bold warning:
   "Do not change any Tally setting or data while answering."
   Also include every OD with category TALLY (OD-001..OD-007).
2. CA_QUESTIONS.md: every OD with category ACCT in OPEN_DECISIONS.md, with a worked example using BR-026
   numbers where useful, the provisional assumption, and an answer box.
3. OWNER_QUESTIONS.md: every OD with category BIZ or OPS, with answer boxes.
4. Each OPEN OD appears in exactly one questionnaire (check with grep on "OD-0").
5. STATUS.md → OWNER APPROVAL REQUIRED: "Answer docs/discovery/*.md (non-blocking until Phase 05.7/11/15)".
Acceptance: three files; OD coverage check passes; no instructions that modify Tally.
Verify: `grep -o "OD-0[0-9][0-9]" docs/discovery/*.md | sort | uniq -d` returns nothing; count equals OPEN ODs.
Next: WP-00.3.

### WP-00.3 — Token measurement tool
Size M · Model Sonnet · Haiku: yes (test fixtures)
Context: docs/DEVELOPMENT_PLAN.md §5.
Modify: new `tools/token-report.mjs`, `tools/token-report.test.mjs`, `tools/fixtures/sample-session.jsonl`, DEVELOPMENT_PLAN.md §5 (usage line).
Tasks:
1. Inspect the structure (keys only, never print message text) of 3 lines from one real transcript in
   `%USERPROFILE%\.claude\projects\C--Users-teljo-Projects-TradeX-Dashboard\` to confirm where `usage` and
   tool_use inputs live. Record the confirmed field paths as a comment in the script.
2. Script (Node ≥ 24, no dependencies): options `--dir <path>` (default: the folder above), `--since <ISO>`,
   `--until <ISO>`, `--session <id>`, `--json`. Stream-parse JSONL; skip malformed lines with a counter;
   de-duplicate assistant messages by message id; sum input_tokens, cache_creation_input_tokens,
   cache_read_input_tokens, output_tokens; count Read tool calls per file path and report repeated reads.
   Output a compact table or JSON. Never output message content.
3. Tests with `node:test` against a synthetic fixture (include duplicate message ids and a malformed line).
Acceptance: tests pass; real run prints non-zero totals for the current session; no content leaked in output.
Verify: `node --test tools/`; `node tools/token-report.mjs --since <today>T00:00:00Z`.
Next: WP-00.4.

### WP-00.4 — Toolchain readiness and Phase 00 gate
Size S · Model Sonnet · Haiku: no
Context: docs/QUALITY_GATES.md §1.
Modify: QUALITY_GATES.md §1 environment line, STATUS.md.
Tasks:
1. Record versions: `node --version`, `pnpm --version`, `git --version`, `docker info --format "{{.ServerVersion}}"`
   (daemon running?), `dotnet --list-sdks`.
2. If Docker daemon is not running or .NET 10 SDK is absent: add to STATUS OWNER APPROVAL REQUIRED
   ("Start/install Docker Desktop" — needed by WP-02.4; "Install .NET 10 SDK" — needed by WP-05.0). Do not install
   software yourself without owner approval.
3. Phase gate: STATUS tracker Phase 00 = COMPLETE; COMPLETED WORK rows; NEXT EXACT ACTION = WP-02.1.
4. Commit `chore(governance): WP-00.2..00.4 discovery, token tooling, toolchain record`.
Acceptance: STATUS shows Phase 00 COMPLETE and WP-02.1 as next action; environment line updated with date.
Next: WP-02.1 (prompts/phases/PHASE-02-APPLICATION-FOUNDATION.md).

## E. Phase acceptance criteria
Governance under git; integrity checks clean; questionnaires issued; token tool tested; toolchain recorded.

## F. Verification commands
`git log --oneline`, `node --test tools/`, version commands above.

## G. Completion requirements
Per SONNET_EXECUTION_PROTOCOL Step 6 for each WP: TASK_LOG line, STATUS update, commit.

## H. Failure handling
Missing/mismatched governance files → ESC to Opus (do not invent prompts). Transcript format not as expected →
adapt parser to the observed structure and document it; if no transcripts are accessible, record "token data
unavailable" in DEVELOPMENT_PLAN §5 and continue.
