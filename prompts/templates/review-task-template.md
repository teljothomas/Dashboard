# Review Task Packet

Review ID: REV-<WP-ID>
Reviewer model: <Opus | Sonnet | Haiku (mechanical checks only)>
Scope: <diff range / files / module>
Context (read only these): <docs sections + files>
Review against: <ADR IDs, INTERFACES §, DATA_MODEL §, SECURITY §, TS-* scenarios>

Checklist:
- Contract conformance (schemas, error codes, states)
- Accounting correctness (balanced events, immutability, no duplicate postings) — if applicable
- Security (authz + scope on every route, input validation, secrets, logging)
- Data integrity (constraints, transactions, idempotency)
- Tests cover acceptance criteria and failure scenarios
- No scope creep, no fake implementations

Output (≤ 30 lines): findings as `path:line — severity (CRITICAL/HIGH/MEDIUM/LOW) — problem — required fix`;
verdict APPROVED / APPROVED_WITH_FIXES / REJECTED. Write to `docs/reviews/REV-<WP-ID>.md`.
Sonnet fixes CRITICAL/HIGH before closing the phase gate.
