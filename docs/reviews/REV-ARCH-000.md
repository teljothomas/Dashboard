# REV-ARCH-000 — Architecture Reviews A–E (Opus 5.5, 2026-11-11)

Scope: the complete v1.0 package (docs/*, prompts/*, .claude/agents/*). Verdict per review and the
issues found during review (all fixed in the package unless listed under "Residual").

## Review A — Business consistency: PASS
- One legal entity, two divisions (BR-001/002, `division` seed MEAT/LOGISTICS); no inter-company design.
- Frozen/fresh = product categories (BR-003, DATA_MODEL §7).
- Consolidated books from Tally; division views are management-only (BR-004, ARCHITECTURE §7, Phase 13 rules).
- Internal trips: CHECK constraints forbid charges/invoice; allocations never become events (ADR-023, TS-A04).
- External trips: invoice-ready queue, Tally invoice link, "NOT A TAX INVOICE" printouts (ADR-024, WP-09.3).
- Expense origin ERP→Tally; invoices/receipts/payments Tally→ERP only (BR-021/022).
- Advances as assets with settlement maths matching BR-026 example (DATA_MODEL §8, TS-A01).
- Loans split principal/interest; lease treatment configurable pending CA (BR-027, OD-014/015, TS-A03).
- Fixed during review: stock write-off reflection in Tally was unaddressed → OD-047; UPI source account ambiguity → OD-048.

## Review B — Tally integration: PASS (with residual R-B1)
- One PC/one company/one agent: lease with fencing epoch (ADR-031, SYNC_DESIGN §4, TS-T11).
- No public port: loopback enforcement + firewall block rule (TALLY_INTEGRATION §3, SECURITY §1).
- PC off: durable posting_outbox, freshness/stale labels (SYNC_DESIGN §3, §6, TS-T01).
- Identity: company fingerprint verified before any read or post (TS-T07).
- Idempotency: unique event per source, unique outbox per event, narration marker + reference, pre-send marker check.
- Lost acknowledgement: expired claim → UNCERTAIN, verification required before resubmission (SYNC_DESIGN §3 hard rules).
- No duplicate official invoice: ERP never issues invoices.
- Fixed during review: Tally company password case undefined → OD-007.
- Residual R-B1: exact TallyPrime 7.0 JSON shapes and the ability to query by narration marker / supply REMOTEID are
  unverified by design; WP-05.1 spike must verify, and WP-11.4 is BLOCKED (ESC) if marker lookup is impossible.

## Review C — Offline-first: PASS
- Dexie stores + outbox + attachment queue (OFFLINE_DESIGN §3); idempotent push by mutationId (SYNC_DESIGN §2.1).
- Pull by monotonic `sync_seq`. Fixed during review: `sync_seq` column was missing from DATA_MODEL conventions → added.
- Conflicts explicit, no LWW on financial fields (SYNC_DESIGN §2.3); seven BR-301 statuses with one precedence table.
- Attachment failure, logout/login, multi-tab, storage eviction covered (TS-O01..08, WP-12.x).
- Offline core built early (ADR-061) so modules are offline-capable from their first WP.

## Review D — Token efficiency: PASS
- STATUS.md-first protocol in CLAUDE.md, SONNET_EXECUTION_PROTOCOL, agent files.
- Every WP declares Context (packet), Modify scope, size class with budget, tests and next WP.
- ID referencing (BR/ADR/TS/OD) instead of restating requirements; module boundaries limit loaded code.
- Haiku boundaries explicit; Opus only for named reviews/escalations.
- Measurement: `tools/token-report.mjs` (WP-00.3) + TASK_LOG columns + waste indicators (DEVELOPMENT_PLAN §5).
- CLAUDE.md kept short because it loads every session.
- Fixed during review: commit workflow was implied but undefined → ADR-063.

## Review E — Production reliability: PASS (with residual R-E1)
- AuthN/AuthZ: Argon2id, hashed sessions, CSRF, route-inventory test forcing permission declarations (WP-04.3).
- Integrity: FKs, balanced-event trigger, immutability triggers, append-only audit, unique source keys.
- Backups: nightly encrypted off-site + monthly restore drill with `db:verify` (DEPLOYMENT §5, WP-14.5).
- Testing layers: unit, integration, contract (shared Zod), E2E, security matrix, failure simulation (QUALITY_GATES).
- Monitoring/alerts for agent, posting, backups, disk (DEPLOYMENT §6).
- Deployment safety: owner approvals for deploy/DNS/purchases/production posting (CLAUDE.md, Phase 14/15).
- Fixed during review: `party` table ownership conflict between Phase 05 import and Phase 06 → created in WP-05.2, Phase 06 extends.
- Residual R-E1: staging shares the production VPS for cost (DEPLOYMENT §1) — accepted trade-off pending OD-030.

## Consistency checks performed
Posting states identical across SYNC_DESIGN §3, DATA_MODEL §4, INTERFACES §5; BR-301 status labels identical across
BUSINESS_REQUIREMENTS, SYNC_DESIGN §2.4, OFFLINE_DESIGN; every TS-* ID in QUALITY_GATES §4 is assigned to a phase WP;
PROMPT_REGISTRY WP ranges match WP headings (checked mechanically, see STATUS.md).

## Verdict
Architecture v1.0 APPROVED for implementation. No critical issue undocumented. Residuals R-B1, R-E1 tracked.
