# Offline-First PWA Design (v1.0)

Protocol, conflict rules and status precedence: SYNC_DESIGN.md §2. This file is the client side.

## 1. Scope

Offline-capable: expenses, advances (request), advance settlements (draft), attendance, trips (create,
start, deliver, km, proof), fuel entries, service records, factory logs, stock movements (draft),
processing batches. Online-only: approvals, user admin, mappings, posting management, reconciliation,
reports (cached last view shown read-only with its timestamp).

## 2. PWA shell

vite-plugin-pwa (Workbox, `injectManifest` strategy): precache app shell; runtime cache GET reference data
with NetworkFirst (3 s timeout) → cache; never cache `/auth/*` or mutation responses. Manifest: name, icons
192/512 maskable, `display: standalone`, theme colours. Update flow: new SW waits; banner "Update ready" —
activation blocked while outbox has items mid-push.

## 3. Dexie schema (`apps/web/src/offline/db.ts`)

| Store | Key | Indexes | Purpose |
|---|---|---|---|
| `records` | [entityType+id] | entityType, status, updatedAt | local copy of syncable records (server data + local edits) |
| `serverShadow` | [entityType+id] | — | last server version for conflict display |
| `reference` | [entityType+id] | entityType | masters for pickers |
| `outbox` | mutationId | [entityType+entityId], state, createdAt, userId | pending mutations, FIFO |
| `attachmentsQueue` | localId | state, createdAt | Blob + metadata until uploaded → attachment id |
| `meta` | key | — | cursors per scope, deviceId, lastPushAt, lastPullAt, schemaVersion |

Outbox entry: `{mutationId, userId, deviceId, entityType, entityId, op, baseVersion, payload,
dependsOn: [localAttachmentIds], state: PENDING|SENDING|CONFLICT|REJECTED, attempts, lastError}`.
Device id: UUID generated once, stored in `meta` (+ localStorage mirror), sent as `X-Device-Id`.

## 4. Sync engine (`syncEngine.ts`)

Triggers: app start, `online` event, every 60 s while online and visible, after each local save, manual
"Sync now". Single-flight lock (Web Locks API, fallback flag) prevents parallel runs across tabs.
Order: upload attachments → push outbox (batches of 50, FIFO) → pull `mine` → pull `reference`.
Backoff on network errors: 5 s, 30 s, 2 m, 10 m (cap). 401 ⇒ pause, prompt login; resume only for the same
user. Storage: request `navigator.storage.persist()`; warn when quota < 50 MB free.
Background Sync API used opportunistically (Android Chrome) — never relied on.

## 5. UX rules

- Every offline-capable record shows a status chip with the BR-301 label and colour; tap → explanation
  ("Saved on this phone only — will upload when online").
- Global banner: offline / syncing n items / n items need attention. Settings page: last sync times,
  pending count, export pending items as JSON (support aid).
- Logout with pending items: warn, show count, allow logout (data kept, locked to that user) — never silent delete.
- Conflict screen: side-by-side local vs server fields, actions per SYNC_DESIGN §2.3.
- Forms: large touch targets (≥ 44 px), numeric keypad for money/km, camera capture for bills, works at 360 px width.

## 6. Offline scenario behaviour (tests TS-O01..08)

| ID | Scenario | Expected |
|---|---|---|
| TS-O01 | Expense created offline | LOCAL_ONLY, number pending; after reconnect SYNCED/AWAITING_APPROVAL with server number |
| TS-O02 | Multiple trips offline | All pushed FIFO; each gets its own trip_no; none lost on app restart |
| TS-O03 | Same transaction submitted twice (double tap, retry after timeout) | Same id + mutationId ⇒ one server record |
| TS-O04 | Two devices modify related records | Business-unique clash ⇒ sync_conflict; both values preserved; resolution audited |
| TS-O05 | Internet returns after hours | Queue drains; cursors resume; no duplicate pulls applied |
| TS-O06 | Attachment upload fails | Retries with backoff; dependent mutation waits; after 10 failures FAILED with retry button |
| TS-O07 | Logout/login | Pending items preserved; same user resumes push; other user cannot push them |
| TS-O08 | Local vs cloud conflict | No LWW on financial fields; conflict UI; local copy kept until resolved |
