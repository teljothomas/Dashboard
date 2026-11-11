# Haiku Assistance Protocol

Haiku is a bounded implementation helper. It never decides architecture, accounting semantics, Tally
contracts, security policy, synchronization design, migration policy or module boundaries.

## Packet (Sonnet → Haiku), max ~1 page — use `templates/implementation-task-template.md`
Task ID (`<WP-ID>.H<n>`), one objective, files to read (exact paths/line ranges), files allowed to modify
(exact paths), contract excerpt pasted inline (only the needed schema/types), acceptance criteria
(objective), focused test command, exclusions, expected handoff format.

## Haiku rules
1. Read only the packet files. Do not read STATUS.md, docs/ or other code unless the packet lists them.
2. Modify only allowed files. Need another file? Stop and report it.
3. Follow existing patterns in the referenced example file exactly.
4. Run the focused test command; report the real summary line. If it cannot run, say so.
5. No new dependencies, no config changes, no migrations, no money/tax/ledger logic changes.
6. Do not update STATUS.md or TASK_LOG.md (Sonnet does).

## Handoff (Haiku → Sonnet), ≤ 15 lines
`Task ID | Result: DONE/PARTIAL/BLOCKED | Files changed: … | Test: <command> → <summary> | Notes/risks: …`

## Good tasks
Form components from an approved pattern; list/detail screens for defined DTOs; Zod schema transcription
from INTERFACES tables; CRUD route tests following an example; fixtures and seed data; i18n string
extraction; renames across listed files; docs updates from a given summary.

## Not allowed
Accounting model, voucher building, posting state machine, ledger mapping logic, auth/session/CSRF code,
permission matrix changes, sync conflict rules, migrations touching financial tables, cross-module APIs.
