# CLAUDE.md — Project Rules (all agents, every session)

Meat Trading, Processing & Logistics ERP. One legal entity, two divisions (A: Meat, B: Logistics).
TallyPrime 7.0 on ONE designated Windows PC is the official books. The ERP is the operational
and management-reporting system. The repository is the only source of truth; chat history is not.

## Session start (mandatory, in this order)

1. Read `STATUS.md`. If it is missing: STOP and report "governance setup failure". Do not guess.
2. Read `prompts/PROMPT_REGISTRY.md`.
3. Open ONLY the phase prompt named in STATUS.md → NEXT EXACT ACTION.
4. Read ONLY the files that prompt's work package lists under "Context".
5. Execute the work package. Do not plan again; the plan is already written.

Sonnet: follow `prompts/SONNET_EXECUTION_PROTOCOL.md`. Haiku: follow `prompts/HAIKU_ASSISTANCE_PROTOCOL.md`.

## Forbidden at session start

- Scanning the whole repository, printing trees, reading git history, reading README, reading all of `docs/`.
- Re-researching anything already recorded in `docs/DECISIONS.md` or `docs/TASK_LOG.md`.
- Redesigning accepted architecture. Architecture conflicts go to Opus (see protocol §Escalation).

## Non-negotiable engineering rules

- Money: PostgreSQL `NUMERIC(18,2)`, JSON decimal strings, `decimal.js` in TypeScript, `decimal` in C#. Never float.
- Quantities: `NUMERIC(14,3)`. Rates: `NUMERIC(18,4)`.
- Every financial event has a client- or server-generated UUID (v7) and is idempotent.
- Posted financial records are never edited or deleted; correct by reversal/replacement.
- Never create Tally ledgers/masters automatically. Never post a voucher not verified by re-query.
- Never mark a voucher posted without verification. On lost acknowledgement: query, never resubmit blindly.
- Never expose Tally's port (9000) beyond 127.0.0.1. Never store secrets in plaintext or in git.
- Server-side validation (Zod) and server-side authorization on every endpoint.
- No mock data or fake implementations in production code paths. No weakening tests to pass CI.
- Never claim a test passed unless it was executed in this session; paste the summary line.
- ERP never issues an official invoice. Internal trips never create revenue.

## Protected operations (owner approval recorded in STATUS.md required)

Production deploy, DNS changes, posting to any non-test Tally company, importing live data,
changing ledger mappings in production, deleting data, purchasing services.

## Output discipline

Targeted reads (line ranges, grep). Diffs, not whole files. Summarise test output (counts + first failure).
No full-file reprints of docs. Close every work unit by updating STATUS.md and `docs/TASK_LOG.md`.
