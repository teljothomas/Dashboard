# Questions for the Chartered Accountant (CA)

Purpose: the ERP is an operational and management-reporting system; TallyPrime remains the official books. The
items below are accounting treatments the ERP must NOT guess. Until you answer, development uses only the
"provisional assumption" shown, on test data, and nothing is posted to live books.

Please answer in the box. A one-line answer plus "per section/rule" reference is enough.

Running example used below (advance settlement): a driver is given an advance of 5,000. On the trip: diesel 3,500,
toll 500, parking 200, cash returned 800. 3,500 + 500 + 200 + 800 = 5,000, so the advance is fully cleared.

### OD-010 — GST treatment of expenses
Input credit on diesel (assumed none), repairs, rent, utilities; reverse charge on transport (GTA); GST on external freight.
Example: diesel 3,500 in the example above — gross expense, or any GST split?
- Provisional assumption: expenses posted gross, no GST split.
- Answer: ______________________

### OD-011 — Inventory valuation and Tally stock items
FIFO or weighted average? Is stock maintained in Tally with stock items?
- Provisional assumption: weighted average, management view only.
- Answer: ______________________

### OD-012 — Depreciation
Method and rates for trucks, reefer units, factory equipment; posted by you in Tally or by the ERP?
- Provisional assumption: ERP shows depreciation as a management estimate only.
- Answer: ______________________

### OD-013 — Payroll statutory treatment
PF, ESI, professional tax, TDS applicability; wage register format.
- Provisional assumption: no statutory deductions; a flag is shown.
- Answer: ______________________

### OD-014 — Truck loan accounting
One ledger per loan? Separate interest ledger? Post from the lender's schedule or an ERP-computed schedule?
Example: EMI 20,000 = principal 12,000 (reduces liability) + interest 8,000 (expense); never the whole EMI as expense.
- Provisional assumption: lender schedule entered manually, principal/interest split per schedule.
- Answer: ______________________

### OD-015 — Lease accounting
Operating expense, or right-of-use asset with lease liability?
- Provisional assumption: lease rent as expense (configurable flag, test only).
- Answer: ______________________

### OD-016 — Ledger mapping
Exact Tally ledger for each ERP posting key (diesel, toll, parking, wages, advances, loans, bank, cash). For driver/worker
advances: one ledger per person under a group, or one control ledger with the ERP holding the per-person detail?
- Provisional assumption: one ledger per person under "Loans & Advances (Asset)" in the test company.
- Answer: ______________________

### OD-017 — Cost centres for divisions
Use Tally cost centres for the two divisions (Meat, Logistics)?
- Provisional assumption: yes, cost category "Division" in the test company.
- Answer: ______________________

### OD-018 — Opening balances and cut-over date
Advances outstanding, loan outstanding, stock lots at the date the ERP starts. Who prepares them and from which Tally report?
- Provisional assumption: synthetic test data.
- Answer: ______________________

### OD-019 — Internal logistics cost allocation basis
Per km, per trip, per kg, or actual trip cost? (Internal trips never create revenue.)
- Provisional assumption: actual trip cost allocated 100% to Meat.
- Answer: ______________________

### OD-020 — Voucher types for ERP postings
Payment, Journal, or custom types "ERP Payment" / "ERP Journal"?
- Provisional assumption: custom types in the test company.
- Answer: ______________________

### OD-021 — Wage payment timing
Expense when paid, or accrue monthly and pay later?
- Provisional assumption: accrue on approval of the wage sheet, pay separately.
- Answer: ______________________

### OD-022 — Trip payments and allowances to drivers
Expense on trip close, or through salary?
- Provisional assumption: expense on trip close via a driver payable.
- Answer: ______________________

### OD-033 — Data retention periods
Statutory books retention (assumed at least 8 years) — please confirm; also for attachments and audit logs.
- Provisional assumption: retain everything.
- Answer: ______________________

### OD-047 — Stock write-offs in Tally
Should wastage, spoilage, expiry and count adjustments be reflected in Tally (stock journal / physical stock voucher)? Who posts them?
- Provisional assumption: ERP-only management records; no voucher.
- Answer: ______________________

### OD-048 — UPI payments
Always from the business current account, or sometimes from personal accounts or wallets? Which ledger to credit in each case?
- Provisional assumption: UPI is the business current account.
- Answer: ______________________
