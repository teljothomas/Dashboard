# Tally Discovery Questionnaire

For: the owner (and whoever uses the designated Tally computer). Purpose: record facts about your Tally setup so
the ERP connector can be built correctly. Nothing here needs any change to Tally.

> **Do not change any Tally setting or data while answering.** Only look, read and copy. If a screen asks you to
> save, press Esc. If unsure, skip the question and write "ask developer".

How to answer: type your answer under "Answer". Tick "Screenshot" once you have saved a screenshot (store it in
`docs/discovery/screenshots/`, never commit passwords or licence serial numbers visible in clear text — blur them).

## Part A — Discovery checks (DC-01 to DC-15)

### DC-01 — Which computer is the designated Tally computer?
- Why it matters: the connector runs only on this one PC.
- How to find out: you tell us the PC and who logs in; press Windows key + R, type `winver`, Enter, screenshot, then close.
- Answer: ______________________
- [ ] Screenshot

### DC-02 — Exact TallyPrime version
- Why it matters: the connector protocol is verified only for TallyPrime 7.0.
- How: inside Tally open Help > About and screenshot. Do not click Update.
- Answer: ______________________
- [ ] Screenshot

### DC-03 — Licence edition and support (TSS) status
- Why it matters: some connectivity features depend on an active licence/support subscription.
- How: read the licence screen in Tally (view only). Blur the serial number if sharing the screenshot.
- Answer (Silver/Gold, TSS active until what date): ______________________
- [ ] Screenshot

### DC-04 — Company name, number, books-from date, financial year
- Why it matters: the connector must match the exact company; mismatches cause wrong posting.
- How: Gateway of Tally > select company > view company information. Copy the exact spelling.
- Answer: ______________________
- [ ] Screenshot

### DC-05 — Where company data is stored, and free disk space
- Why it matters: backups and disk-full risk.
- How: the company list screen shows the data path. Free space: open File Explorer > This PC.
- Answer: ______________________
- [ ] Screenshot

### DC-06 — Do other PCs hold copies of the company?
- Why it matters: we must know which copy is the official books. Copies are never merged automatically.
- How: ask your accountant and staff.
- Answer: ______________________
- [ ] Screenshot (not needed)

### DC-07 — Backup routine and last restore test
- Why it matters: the connector relies on Tally data being safe.
- How: ask whoever manages Tally; when was a backup last restored on a test basis?
- Answer: ______________________
- [ ] Screenshot (not needed)

### DC-08 — Is a test company available?
- Why it matters: we test posting on a test company, never on live books.
- How: ask; check whether a company with a name like "TEST" exists in the company list (view only).
- Answer: ______________________
- [ ] Screenshot

### DC-09 — Is Tally's server/connectivity setting turned on, and on which port?
- Why it matters: the connector talks to Tally on this computer only.
- How: look at the connectivity/server settings screen (the menu path varies by version; ask the developer on a call). View only; do not toggle anything.
- Answer: ______________________
- [ ] Screenshot

### DC-10 — Windows Firewall state for the Tally port
- Why it matters: Tally's port must never be reachable from other computers.
- How: developer runs a read-only PowerShell listing of firewall rules with you watching. Do not edit rules.
- Answer: ______________________
- [ ] Screenshot

### DC-11 — Is stock kept in Tally (stock items, batches, godowns)?
- Why it matters: decides how stock reports compare to Tally.
- How: open Stock Summary (view only).
- Answer: ______________________
- [ ] Screenshot

### DC-12 — Are cost centres used?
- Why it matters: decides whether divisions can be tagged on vouchers.
- How: open Chart of Accounts, check for Cost Centres (view only).
- Answer: ______________________
- [ ] Screenshot

### DC-13 — Existing ledgers for diesel, toll, wages, advances, loans
- Why it matters: the ERP maps its entries to your existing ledgers; we never create ledgers automatically.
- How: open the ledger list, export or screenshot the names only (no balances needed).
- Answer: ______________________
- [ ] Screenshot

### DC-14 — Internet reliability and power backup at the Tally PC
- Why it matters: sync happens over the internet; outages delay it.
- How: ask; is there a UPS/inverter, how often does the internet drop?
- Answer: ______________________
- [ ] Screenshot (not needed)

### DC-15 — Permission to install a background service on the Tally PC
- Why it matters: the connector runs as a Windows service. Needs administrator rights and the .NET runtime.
- How: ask whether you have administrator rights on that PC.
- Answer: ______________________
- [ ] Screenshot (not needed)

## Part B — Tally decisions (owner)

Fill in each answer. If you do not know, write "need to check".

### OD-001 — Which Windows PC is the designated Tally computer?
Windows version, user account, and whether it is switched on every day.
- Provisional assumption: connector developed against a simulator.
- Answer: ______________________

### OD-002 — TallyPrime 7.0 licence edition and support status
Silver or Gold, serial (do not write it here if sensitive), and whether TSS is active.
- Answer: ______________________

### OD-003 — Company details
Exact company name, company number, books-from date, financial year, data path.
- Provisional assumption: test company named "ERP TEST CO".
- Answer: ______________________

### OD-004 — Do other PCs hold separate company copies?
If yes, which is the official one and how will past differences be reconciled (by the accountant, manually)?
- Provisional assumption: one copy.
- Answer: ______________________

### OD-005 — Current backup practice and restore test
- Answer: ______________________

### OD-006 — Is a non-production test company (or a second PC/educational-mode copy) available?
- Provisional assumption: simulator only until answered.
- Answer: ______________________

### OD-007 — Does the company use a password, TallyVault or user security?
If yes, how may the connector get read and import access without anyone storing a plain-text password?
- Provisional assumption: test company without password.
- Answer: ______________________
