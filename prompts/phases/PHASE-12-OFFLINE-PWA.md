# PHASE-12 — Offline-First PWA Hardening

## A. Identity
- Objective: installable PWA, robust attachment queue, conflict resolution UI, complete status UX, multi-tab safety, storage
  persistence, full offline scenario suite and mobile performance budget.
- Assigned model: Sonnet. Haiku-eligible tasks marked.
- Prerequisites: Phase 11 gate (11.6 test-company part may be BLOCKED). Offline core exists since WP-03.5 (ADR-061).
- Requirements: BR-300..302, BR-403. Docs: OFFLINE_DESIGN (all), SYNC_DESIGN §2.

## B. Context rules
STATUS.md → registry → this WP → Context only. Server sync semantics are fixed; client changes only unless a test proves a
server defect (then fix within `modules/sync` with tests).

## C/D. Phase-wide requirements
Never display SYNCED for local-only data. Never delete unsynced data silently. Precedence table SYNC_DESIGN §2.4 is the only
status logic (single function). Accessibility: chips have text, not colour only. Works at 360 px, touch targets ≥ 44 px.

---

### WP-12.1 — PWA shell, install and update flow
Size M · Haiku: yes (icons/manifest wiring)
Context: OFFLINE_DESIGN §2.
Tasks: vite-plugin-pwa injectManifest; caching rules (no auth/mutation caching); manifest + maskable icons; install prompt UX
(Android); update banner; SW activation deferred while sync engine is pushing.
Tests: Playwright: app loads offline after first visit; update flow does not drop outbox.
Next: WP-12.2.

### WP-12.2 — Attachment queue
Size L · Haiku: no
Context: OFFLINE_DESIGN §3 attachmentsQueue, §6 TS-O06; SECURITY §5.
Tasks: client compression (≤ 1600 px, JPEG/WebP ~300 KB target, PDFs untouched ≤ 10 MB), Blob storage in Dexie, upload with
backoff, dependency resolution (mutation waits for attachment id), FAILED after 10 attempts with retry, cleanup of uploaded blobs
after server ack of the dependent mutation.
Tests: TS-O06 (fail ×N then succeed; permanent fail state; dependent mutation never sent before upload).
Next: WP-12.3.

### WP-12.3 — Conflict resolution UI
Size M · Haiku: yes (field diff component after Sonnet builds first screen)
Context: SYNC_DESIGN §2.3; OFFLINE_DESIGN §5; INTERFACES `/sync/conflicts`.
Tasks: conflicts inbox; side-by-side diff using serverShadow; KEEP_SERVER / APPLY_CLIENT / MERGED (explicit field picks);
RECORD_LOCKED guidance ("ask accountant to reverse"); resolution updates local store and outbox.
Tests: TS-O04, TS-O08 end-to-end with two browser contexts.
Next: WP-12.4.

### WP-12.4 — Status UX, logout, storage, multi-tab
Size M · Haiku: yes (chip placement across module lists)
Tasks: status chip on every offline-capable list/detail; global banner counts; Sync settings page (last push/pull, pending count,
export pending JSON); logout with pending items flow (TS-O07); `navigator.storage.persist()` + quota warning; Web Locks single-flight
across tabs.
Tests: TS-O07; two tabs do not double-send.
Next: WP-12.5.

### WP-12.5 — Offline scenario suite, performance budget, Phase 12 gate
Size M
Tasks: Playwright suite TS-O01..O08 using `context.setOffline` and request interception; mobile emulation (Pixel-class, 4× CPU
throttle, Slow 4G): LCP < 3 s on cached load, initial JS ≤ 250 KB gzip; fix regressions. Full gate; STATUS next WP-13.1.

## E. Phase acceptance criteria
All TS-O tests pass; PWA installable; no data loss across restart/logout/update; budget met.

## F. Verification commands
`pnpm --filter web test && pnpm --filter web e2e && pnpm --filter web build && pnpm lint && pnpm typecheck`

## G. Completion requirements
Protocol Step 6; record bundle size and LCP numbers in TASK_LOG.

## H. Failure handling
Flaky offline tests → fix synchronisation (await sync engine events), never add sleeps or retries to mask.
