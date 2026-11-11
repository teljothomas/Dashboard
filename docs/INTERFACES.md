# Interface Contracts (v1.0)

Source of truth for every API, sync and connector shape. Implementation lives in
`packages/contracts/src/<module>.ts` as Zod schemas; this document and those schemas must agree.
A module task loads only §1, §2 (its rows), §3 (its permissions) and the section it implements.

## 1. Conventions (all `/api/v1` routes)

- JSON only (except attachment upload: multipart). UTF-8. `Content-Type: application/json`.
- Success: `{ "data": <payload>, "meta"?: { "nextCursor"?: string } }`.
- Error: `{ "error": { "code": string, "message": string, "details"?: object, "requestId": string } }`.
- Money: decimal string `"1234.50"`. Quantity: `"12.345"`. Date: `"YYYY-MM-DD"` (Asia/Kolkata business date).
  Timestamp: ISO-8601 UTC. IDs: UUID v7 strings.
- Headers: `X-CSRF-Token` (all mutations), `X-Device-Id` (all requests from PWA), `X-Request-Id` (echoed).
- Creating records: client supplies `id` (UUID). Same `id` + same payload hash ⇒ idempotent 200 with
  existing record; same `id` + different payload ⇒ 409 `IDEMPOTENCY_MISMATCH`.
- Updates carry `version`; mismatch ⇒ 409 `CONFLICT_VERSION` with `details.server` snapshot.
- Lists: `?limit=` (default 50, max 200) `&cursor=` + filters; ordered by stable key.
- Every record DTO includes `syncStatus` (server part, SYNC_DESIGN §2.4) where applicable.

| Code | HTTP | Meaning |
|---|---|---|
| VALIDATION_FAILED | 400 | Zod/business validation; `details.fields` |
| UNAUTHENTICATED | 401 | no/expired session |
| FORBIDDEN | 403 | permission or scope denied |
| NOT_FOUND | 404 | also returned for out-of-scope records (no existence leak) |
| CONFLICT_VERSION | 409 | optimistic concurrency |
| IDEMPOTENCY_MISMATCH | 409 | reused id with different payload |
| DUPLICATE_SUSPECTED | 409 | soft duplicate; resend with `confirmDuplicate: true` + reason |
| INVALID_TRANSITION | 409 | state machine violation |
| RECORD_LOCKED | 409 | approved/posted/period-locked record |
| LEASE_HELD / LEASE_STALE | 409 | connector lease errors |
| MAPPING_MISSING | 422 | posting key without approved ledger mapping |
| PAYLOAD_TOO_LARGE | 413 | upload > 10 MB / batch too big |
| UNSUPPORTED_MEDIA | 415 | file type not allowed |
| RATE_LIMITED | 429 | with `Retry-After` |
| INTERNAL | 500 | request id only |

## 2. Endpoint catalogue

Permission column uses §3 codes. "scope" is applied server-side to every list and read.

### identity (Phase 04)
| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | /auth/login | public, rate-limited | {username,password,deviceId} → sets cookie; returns `{data:{user,roles,permissions:[{permission,scope,divisionId}],csrfToken}}`; generic 401 on any failure, 429 + `Retry-After` over the lockout limits |
| POST | /auth/logout | session | revokes session |
| GET | /auth/me | session | user, roles, permissions+scopes, csrfToken |
| POST | /auth/change-password | session | {currentPassword,newPassword}; revokes the user's other sessions |
| POST | /auth/reset/complete | public, rate-limited | {username,code,newPassword} |
| GET/POST/PATCH | /users, /users/:id | users.manage | create, disable, assign roles |
| POST | /users/:id/reset-code | users.manage | returns one-time code once (OD-032) |
| GET/POST/PATCH | /roles, /roles/:id | roles.manage | custom roles; system roles immutable |
| GET | /users/:id/sessions, DELETE /sessions/:id | users.manage | force logout |
| GET | /audit?entityType=&entityId= | audit.view | |

### core (Phase 03)
| POST | /attachments | any authenticated | multipart, 1 file; returns {id, sha256}; dedup by hash |
| GET | /attachments/:id | scope of linked entity | streamed, `Content-Disposition: attachment` for non-images |
| GET | /notifications, POST /notifications/:id/read | session | |
| GET | /health (no prefix) | public | {status, db} — no versions/secrets |

### sync (Phase 03/12) — see §4
| POST | /sync/push | session | ≤ 50 mutations |
| GET | /sync/pull?scope=&cursor= | session | scopes: `reference`, `mine` |
| GET/POST | /sync/conflicts, /sync/conflicts/:id/resolve | owner of record or approver | |

### tally (Phase 05/11)
| GET | /tally/companies, POST /tally/companies | tally.connector.manage | create company record (expected identity) |
| POST | /tally/companies/:id/registration-code | tally.connector.manage | one-time code, 15 min |
| GET | /tally/agents, POST /tally/agents/:id/revoke | tally.connector.manage | |
| GET | /tally/status | dashboard.view | last heartbeat, lease, watermarks, queue counts, stale flag |
| GET | /tally/ledgers, /tally/vouchers, /tally/vouchers/:guid | tally.data.view | read-only mirror |
| GET/PUT | /tally/mappings, /tally/mappings/:postingKey | tally.mapping.edit | ledger must exist in mirror |
| POST | /tally/mappings/:postingKey/approve | tally.mapping.approve | |
| GET | /tally/outbox?status= | tally.posting.manage | |
| POST | /tally/outbox/:id/retry, /cancel | tally.posting.manage | cancel only if verified absent |
| POST | /tally/companies/:id/posting-mode | OWNER only | PRODUCTION needs owner_approval record |

### parties, inventory (Phase 06)
| GET/POST/PATCH | /parties | party.view / party.edit | Tally-sourced fields read-only |
| GET/POST/PATCH | /inventory/products, /categories, /uoms, /locations | inventory.view / inventory.edit | |
| GET | /inventory/balances, /inventory/expiring | inventory.view | |
| POST | /inventory/movements | inventory.edit | manual movements; write-offs → PENDING_APPROVAL |
| POST | /inventory/movements/:id/approve | inventory.writeoff.approve | |
| GET | /inventory/tally-lines/unassigned | inventory.edit | imported purchase/sales lines needing lot/location |
| POST | /inventory/tally-lines/:guid/:line/assign | inventory.edit | creates RECEIPT/ISSUE movement once |
| POST/GET | /inventory/processing-batches | inventory.edit | |
| POST | /inventory/counts, /counts/:id/submit, /approve | inventory.edit / inventory.writeoff.approve | |

### expenses, approvals, advances (Phase 10)
| GET/POST | /expenses, PATCH /expenses/:id (DRAFT only) | expense.create / expense.view | |
| POST | /expenses/:id/submit, /cancel | expense.create (own) | |
| GET | /approvals?status=PENDING | any *.approve | queue filtered by permissions/thresholds |
| POST | /approvals/:id/approve, /reject | per entity policy | creates financial_event + outbox on approve |
| GET/POST | /expense-categories | settings.manage | |
| GET/POST | /advances, POST /advances/:id/submit | advance.create | |
| POST | /advances/:id/settlements, /settlements/:id/submit | advance.settle | |
| POST | /financial-events/:id/reverse | tally.posting.manage + OWNER/ACCOUNTANT | creates REVERSAL event |

### factory, labour (Phase 07)
| GET/PUT | /factory, GET/POST /factory/logs | factory.view / factory.edit | |
| GET/POST/PATCH | /labour/workers, /labour/workers/:id/rates | labour.view / labour.edit | |
| GET/POST | /labour/attendance?date= (bulk upsert per day via sync) | attendance.record | |
| POST | /labour/periods/:month/calculate | wages.calculate | |
| POST | /labour/periods/:month/approve | wages.approve | WAGE_ACCRUAL events |
| POST | /labour/wage-lines/:id/payments | wages.approve | WAGE_PAYMENT event |
| GET | /labour/workers/:id/statement | labour.view | |

### fleet, drivers, finance (Phase 08)
| GET/POST/PATCH | /fleet/vehicles, /documents, /service-schedules, /service-records, /tyres, /fuel, /downtime | fleet.view / fleet.edit | |
| GET | /fleet/vehicles/:id/summary | fleet.view | km, fuel efficiency, costs |
| GET/POST/PATCH | /drivers, /drivers/:id/pay-rules, /documents | driver.view / driver.edit | driver sees own only |
| GET | /drivers/:id/statement | driver.view (OWN for drivers) | |
| GET/POST | /finance/agreements, /agreements/:id/schedule (upload/enter) | finance.view / finance.edit | |
| POST | /finance/schedule-lines/:id/payments | finance.edit | LOAN_EMI / LEASE_PAYMENT event via approval |
| GET | /finance/forecast?months= | finance.view | |

### trips (Phase 09)
| GET/POST/PATCH | /trips | trip.view / trip.create / trip.edit | driver: own trips |
| POST | /trips/:id/start, /deliver, /close, /cancel | trip.edit / trip.close | |
| POST | /trips/:id/expenses (link), /proofs | trip.edit | |
| GET | /trips/invoice-queue | report.financial.view | EXTERNAL, CLOSED, invoice_status=PENDING |
| POST | /trips/:id/link-invoice {tallyVoucherGuid} | tally.posting.manage | must be imported SALES voucher, not linked elsewhere |
| GET | /trips/:id/profitability | report.financial.view | |

### recon, reports, dashboard (Phase 13)
| POST/GET | /recon/bank-imports, /recon/lines?status=, POST /recon/matches | recon.edit / recon.view | |
| POST/GET | /recon/cash-counts | recon.edit | |
| GET | /dashboard | dashboard.view | tiles filtered by permissions |
| GET | /reports/:reportId?from=&to=&division=&format=json|xlsx|pdf | report.* per report | report envelope §6 |

## 3. Permissions and default role matrix

Permissions: `users.manage roles.manage settings.manage audit.view tally.connector.manage tally.data.view
tally.mapping.edit tally.mapping.approve tally.posting.manage party.view party.edit inventory.view
inventory.edit inventory.writeoff.approve factory.view factory.edit labour.view labour.edit
attendance.record wages.calculate wages.approve driver.view driver.edit fleet.view fleet.edit finance.view
finance.edit trip.view trip.create trip.edit trip.close expense.create expense.view expense.approve
advance.create advance.approve advance.settle recon.view recon.edit report.operational.view
report.financial.view dashboard.view`

| Role | Grants (scope) |
|---|---|
| OWNER | all (ALL) |
| ADMIN | users.manage, roles.manage, settings.manage, audit.view, tally.connector.manage, tally.data.view, dashboard.view (ALL). No financial approvals by default. |
| ACCOUNTANT | tally.*, party.*, expense.view/approve, advance.approve/settle, wages.approve, finance.*, recon.*, report.*, dashboard.view, *.view (ALL) |
| FACTORY_MANAGER | inventory.*, factory.*, labour.*, attendance.record, wages.calculate, expense.create, expense.view, expense.approve (DIVISION=MEAT, ≤ threshold), advance.create, report.operational.view, dashboard.view (DIVISION) |
| SUPERVISOR | attendance.record, factory.edit, inventory.edit (draft movements), trip.create, trip.edit, fleet.view, expense.create, expense.view (OWN), advance.create (DIVISION) |
| DRIVER | trip.view, trip.edit (OWN: start/deliver/km/proof), expense.create, expense.view, advance.create, driver.view (OWN) |

Rules: scope OWN = `created_by = user` or `driver.user_id = user`; DIVISION = record division ∈ user_role
divisions. NOT_FOUND for out-of-scope. Approval thresholds from `approval_policy` (OD-042). No self-approval
except OWNER.

## 4. Device sync contract (details: SYNC_DESIGN §2)

```
POST /api/v1/sync/push
{ "deviceId": uuid, "mutations": [ { "mutationId": uuid, "entityType": "expense", "entityId": uuid,
   "op": "CREATE|UPDATE|SUBMIT|CANCEL", "baseVersion": int|null, "clientCreatedAt": ts,
   "payload": { ...entity create/update DTO... } } ] }
→ { "results": [ { "mutationId", "result": "APPLIED|CONFLICT|REJECTED|DUPLICATE_SUSPECTED|BLOCKED_BY_PREVIOUS",
   "entity"?: { "id","version","status","number","syncStatus" }, "conflictId"?, "error"?: {code,message} } ] }

GET /api/v1/sync/pull?scope=reference|mine&cursor=<int>&limit=500
→ { "changes": [ { "entityType","entityId","syncSeq","deleted": bool,"data": {...} } ], "nextCursor": int, "hasMore": bool }
```
Syncable entity types v1: expense, advance, advance_settlement, attendance, trip, trip_proof, fuel_entry,
service_record, factory_log, stock_movement, processing_batch. Reference types: expense_category, vehicle,
driver (limited), worker (limited), product, uom, stock_location, party (name/id only), division.

## 5. Connector contract (agent ↔ cloud, `/connector/v1`)

Signed headers on every call except `register`: `X-Agent-Id`, `X-Timestamp` (±300 s), `X-Nonce` (uuid,
single use), `X-Signature` = base64 ECDSA-P256-SHA256 over
`METHOD\nPATH\nTIMESTAMP\nNONCE\nhex(sha256(body))`. Mutating calls also carry `"epoch"` in the body.

| Method | Path | Body → Response |
|---|---|---|
| POST | /register | {registrationCode, machineName, machineFingerprint, publicKeyPem, agentVersion} → {agentId, companyId, expectedCompany{tallyName, companyNumber, booksFrom}} |
| POST | /lease/acquire | {companyFingerprint} → {epoch, expiresAt} or 409 LEASE_HELD {holderAgentId, expiresAt} |
| POST | /lease/release | {epoch} → 204 |
| POST | /heartbeat | {epoch, tallyReachable, tallyVersion, companyMatch, journalPending, lastError} → {expiresAt, postingMode, commands[]} (`FULL_RECON`,`REFRESH_MASTERS`,`VERIFY_UNCERTAIN`) |
| POST | /company/verify | {observed{tallyName, companyNumber, booksFrom, guid?}} → {match, fingerprint} |
| GET | /watermarks | → [{stream, lastAlterId, lastFullReconAt}] |
| POST | /import-batches | {batchId, epoch, stream, fromAlterId, toAlterId, records[≤500]} → {status:"APPLIED"} (idempotent by batchId) |
| POST | /recon-snapshots | {batchId, epoch, periodFrom, periodTo, vouchers[{guid, alterId}]} → {missingMarkedDeleted:int} |
| POST | /outbox/claim | {epoch, max≤10} → [{outboxId, eventId, attemptNo, marker, payload, payloadSha256}] (only when postingMode≠DISABLED) |
| POST | /outbox/:id/result | {epoch, attemptNo, outcome, tallyGuid?, masterId?, voucherNumber?, errorCode?, responseExcerpt?} |
| GET | /outbox/uncertain | → [{outboxId, eventId, marker, voucherDate, amount}] |
| POST | /outbox/:id/verify-result | {epoch, found, tallyGuid?, masterId?, voucherNumber?} |
| GET | /version | → {minimumVersion, latestVersion, downloadNote} |

## 6. Report envelope

`{ "reportId", "params", "source": "TALLY|ERP_MANAGEMENT|ESTIMATE|MIXED", "asOf": ts|null, "stale": bool,
"columns": [{key,label,type:"money|qty|text|date|pct",source}], "rows": [...], "totals"?: {...}, "notes": [string] }`.
Excel/PDF exports render the same envelope, including source and as-of footer.

## 7. Internal service interfaces (cross-module calls; TypeScript signatures in `modules/<m>/index.ts`)

```
core.audit.record(tx, {action, entityType, entityId, before?, after?})
core.numbers.next(tx, sequenceName, businessDate) -> string
core.attachments.link(tx, attachmentId, entityType, entityId, role)
core.jobs.enqueue(tx, kind, payload, runAt?)
ledger.createEvent(tx, {eventType, sourceEntity, sourceId, sourceSeq?, voucherDate, narration, lines[]}) -> eventId
   // validates balance, posting-key format; enqueues posting_outbox PENDING in same tx
ledger.reverseEvent(tx, eventId, reason) -> reversalEventId
approvals.request(tx, {entityType, entityId, amount, divisionId, categoryId?})
approvals.registerHandler(entityType, {onApproved(tx, entityId, actor), onRejected(...)})
expenses.listUnsettledFromAdvance(tx, advanceId)
advances.recordPayrollRecovery(tx, advanceId, amount, wageLineId)
tally.findVoucher(tx, companyId, guid) / tally.listUnlinkedSalesVouchers(...)
tally.getFreshness(companyId) -> {lastSuccessAt, stale}
sync.registerEntity(entityType, {scopes, create?, update?, submit?, cancel?, scopeFilter, serialize, applyResolution?})
   // handlers run in the push transaction (framework holds the per-entity lock) and return
   // APPLIED{entity, merged?} | CONFLICT{reason, baseVersion, serverVersion, serverSnapshot} |
   // REJECTED | DUPLICATE_SUSPECTED, or throw AppError / ZodError (recorded as REJECTED).
   // Update handlers decide stale-version policy with classifyStaleUpdate (SYNC_DESIGN 2.3).
   // scopeFilter(tx, caller, scope, afterSeq, limit) -> rows after the cursor; types: modules/sync/types.ts
```

Sync wire details settled in WP-03.4 (contracts: `packages/contracts/src/sync.ts`): success bodies use the
section 1 envelope (`{ data: { results } }`, `{ data: { changes, nextCursor, hasMore } }`); `GET /sync/conflicts`
lists own conflicts plus those of entity types whose handler `approverPermission` (e.g. `expense.approve`) the caller holds
(types without one are owner-only), `status=OPEN|ALL|RESOLVED_*`, cursor = last conflict id in `meta.nextCursor`; `POST /sync/conflicts/:id/resolve`
takes `{resolution, values?, note?}` (`values` only for MERGED) and returns `{ conflict, entity|null }`; push requires a session bound to a
device and the body `deviceId` must equal it (the session device is what is stored and audited). Only final results (APPLIED/CONFLICT/REJECTED) are stored for replay; BLOCKED_BY_PREVIOUS
and DUPLICATE_SUSPECTED are transient. Any code that writes a syncable table outside the sync server must call
`lockSyncWrite(tx)` first (pull takes the exclusive lock so a cursor never skips an uncommitted row).
