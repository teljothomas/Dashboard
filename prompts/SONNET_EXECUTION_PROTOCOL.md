# Sonnet Autonomous Execution Protocol

Trigger phrases from the owner: "proceed with development", "continue development", "execute the next
phase", "resume the project", "continue from current status" (or similar). Do not ask which phase to run.

## Step 1 — Read STATUS.md (first file, always)
Extract: stage, phase, Task ID, task status, blockers, owner approvals, NEXT EXACT ACTION.
If STATUS.md is missing or has no NEXT EXACT ACTION: stop, report "governance setup failure", do nothing else.
If the task status is IN_PROGRESS (previous session interrupted): resume that WP; check
`git status` + `git diff --stat` only (not history) to see partial work.

## Step 2 — Select the prepared prompt
Read `prompts/PROMPT_REGISTRY.md`. Open the mapped phase file and go to the WP heading. Read the phase
header (identity, rules) and that WP only. Do not rewrite or "improve" the prompt.
**Conflicts:** if STATUS names a WP absent from the registry/phase file, or prerequisites contradict
STATUS, stop and report the exact inconsistency with a proposed fix; do not guess.

## Step 3 — Load only the context packet
Read exactly the files under the WP's `Context`. Use grep/line ranges for large docs (sections are named).
Source files: only those the WP names or that grep shows you must touch. No repo scans, no trees, no git log.
Budget: S ≤ 8k, M 8–18k, L 15–25k tokens of loaded context. If you need a file outside the packet, read
only the needed lines and note it as an out-of-packet read in TASK_LOG.

## Step 4 — Execute
- Set STATUS Task status = IN_PROGRESS (one edit) before changing code.
- Follow the WP's ordered tasks. Implement real functionality; no stubs in production paths.
- Respect DECISIONS.md, INTERFACES.md, DATA_MODEL.md. If a contract is wrong or missing, do not invent:
  if the gap is local and obvious (e.g. missing index), add it and note it in TASK_LOG; if it changes a
  contract, accounting semantics, security or another module, escalate (below).
- Run focused tests as you go; fix failures within scope.
- Do not stop to produce another plan.

## Step 5 — Haiku delegation
Delegate only tasks marked `Haiku-eligible` (or equally mechanical work) with a packet from
`prompts/templates/implementation-task-template.md` per HAIKU_ASSISTANCE_PROTOCOL. Use the
`haiku-worker` agent if `.claude/agents/haiku-worker.md` exists and the Agent tool accepts it; otherwise
do the work yourself and write "Haiku unavailable" in TASK_LOG. At most 2 Haiku tasks in parallel,
never on overlapping files. Review every Haiku diff against the packet, run the tests yourself.

## Step 6 — Close the work unit
1. Run the WP's `Verify` commands; capture the summary line (counts, first failure).
2. Commit (see Commits). 3. Append one TASK_LOG line (tokens via `node tools/token-report.mjs --since <WP start>`
once WP-00.3 exists). 4. Update STATUS.md: COMPLETED WORK row, phase tracker %, QUALITY GATE (executed
only), NEXT EXACT ACTION = next WP with its file, model, context files, expected output, tests.
5. If docs changed meaning (contract detail filled in), update that doc section only.

## Step 7 — Continue automatically
Select the next WP per PROMPT_REGISTRY §2 and continue in the same session while context allows.
At a phase end run the gate WP. Continue to the next phase unless a stop condition applies.

## Stop conditions (stop, update STATUS, report in ≤ 10 lines)
- Owner decision/approval required and no other unblocked WP exists.
- Production access, production posting, live data, purchases, DNS, deploy.
- Critical defect not fixable within the WP scope after two focused attempts.
- Architecture conflict → escalation.
- Context/turn limit warning from the harness: finish or checkpoint the current WP (STATUS IN_PROGRESS with
  precise "resume at task N, files touched"), then produce the handoff (`prompts/templates/handoff-template.md`).

## Escalation to Opus (WP-01.X)
Write `docs/escalations/ESC-<n>.md` (≤ 40 lines: problem, evidence, options, recommendation, impact), set
the WP BLOCKED with reason "awaiting Opus ESC-<n>", continue with other unblocked WPs.

## Commits (repository workflow, ADR-063)
Local git, branch `main` until a remote exists. One commit per verified WP:
`<type>(<module>): <WP-ID> <summary>` + attribution trailer required by the environment. Never commit
secrets, `.env`, databases, journal files. Never push, force-push, or rewrite history without owner approval.
Never commit failing tests or skipped tests introduced to pass.

## Failure handling
Diagnose only the failing area (read the failing test + code under test). No unrelated investigation.
Record each failed attempt and its outcome in the TASK_LOG line. Never claim success without executed tests.

## STATUS.md edit rules
Keep it short: current position, tracker, last ~10 completed rows (older rows move to TASK_LOG), active
task, blockers, approvals, gate results, next action. Exactly one NEXT EXACT ACTION.
