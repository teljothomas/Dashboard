# Tally protocol fixtures (WP-05.1, 2026-11-12)

All fixtures are `DOC_ONLY`: constructed from the official TallyPrime JSON integration documentation
(https://help.tallysolutions.com/tally-prime-integration-using-json-1/ and its linked payload samples),
sanitised (no real names, GUIDs replaced). None was captured from a live company. WP-05.7 must confirm each
against the test company and replace this file's status per row.

| File | Status | Notes |
|---|---|---|
| request-ledger-collection.json | DOC_ONLY | Ledger collection export with `fetch_List` incl. `Closing Balance` (covers items b-ledgers and d). No ALTERID filter documented. |
| request-voucher-collection.json | DOC_ONLY | Voucher collection via a TDL collection definition (`tdlmessage`). No date-range or ALTERID filter documented. |
| response-voucher-collection.json | DOC_ONLY | Shortened: shows `guid`, `remoteid`, `vchkey`, `masterid`, `isdeleted`, ledger entries. No `alterid`, no narration key in the sample. |
| request-voucher-import-headers.json | DOC_ONLY (partial) | Headers and mandatory variables only. The documented body is a Sales invoice; a Receipt/Payment body is NOT documented, so none is fixtured here. |
| response-voucher-import.json | DOC_ONLY | `import_result` counters. No per-error text, no error list. |

Not fixtured (NOT VERIFIED, see TALLY_INTEGRATION section 8): company info, groups/units/voucher types/cost centres,
ALTERID filter, narration/marker query, unknown-ledger error text.
