# Task Log

One line per closed work unit. History lives here, not in STATUS.md. Tokens from `tools/token-report.mjs`
(after WP-00.3); before that, write `n/a`. Never write test results that were not executed.

| Date | Task ID | Model | Size | Summary | Files changed | Tests (executed) | In tok | Out tok | Files read | Repeat reads | Out-of-packet reads | Rework | Commit |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-11-11 | ARCH-000 | Opus 5.5 | L | Governance, architecture docs, prompt library v1.0; repo was empty | ~40 docs | n/a (no code) | n/a | n/a | 0 source | 0 | 0 | no | none (no git yet) |
| 2026-11-11 | WP-00.1 | Sonnet 5.5 | S | Integrity check (all files present; registry WP counts match all 16 phase files), git init -b main, .gitignore/.gitattributes, origin remote recorded (no push), ADR-063 status line | .gitignore, .gitattributes, STATUS.md, docs/TASK_LOG.md, docs/DECISIONS.md + 43 governance files | `git log --oneline` / `git status --short` (see below) | n/a | n/a | 3 | 0 | 0 | no | first commit on main |
| 2026-11-11 | WP-00.2 | Sonnet 5.5 | S | Three discovery questionnaires; OD-033 (category OPS, decider CA, listed under CA in STATUS) placed in CA_QUESTIONS; OD ids appear once each so uniq -d check passes | docs/discovery/*.md (3), STATUS.md, docs/TASK_LOG.md | grep dup check empty; 32 unique ODs = 32 OPEN | n/a | n/a | 2 | 0 | 0 | no | WP-00.2 commit |
| 2026-11-11 | WP-00.3 | Sonnet 5.5 | M | tools/token-report.mjs (de-dupe by message.id, Read counts, filters); field paths confirmed from real transcript keys. Note: `node --test tools/` fails on Node 24 (dir treated as module), use `node --test`; DEVELOPMENT_PLAN §5 records it. First attempt writing files via bash heredoc failed (shell quoting), redone with Write | tools/token-report.mjs, tools/token-report.test.mjs, tools/fixtures/sample-session.jsonl, docs/DEVELOPMENT_PLAN.md, STATUS.md | node --test: 6 pass 0 fail | n/a (tool not yet usable at WP start) | n/a | 5 | 0 | 0 | no | WP-00.3 commit |
