# Walkthrough — the system, one cycle at a time

What this document is: every full cycle in the VFW Console, walked end to end against a **running
local system with real data**. Every number, reference and error message below was produced by
executing the cycle, not by reading the code and describing what it ought to do.

Companion documents: `docs/modules&tabs.md` (what every screen *is*), `docs/roles-and-permissions.md`
(who may do what and why). This one is the verb: what actually happens, in order.

> **How to reproduce.** Backend `cd backend && npm run dev` (port 3001), frontend
> `cd frontend && npm run dev` (port 5173 — `host: '127.0.0.1'` is already pinned in
> `vite.config.ts`, so no `--host` flag is needed). Sign in at http://localhost:5173.
> All seeded accounts share the password in `backend/prisma/seed.ts` (`Vfw@2026!` on localhost only —
> the seed refuses to use it against a non-local database).

---

## The cast

Seeded staff, and the role each one plays in the cycles below.

| Person | Email | Role | Commission | Their part |
| --- | --- | --- | --- | --- |
| Aiko Tanaka | `aiko@` | SALES | 10% | Closes the clean sale |
| Priya Raman | `priya@` | SALES | 8% | Closes the customized, over-discounted sale |
| Diego Salazar | `diego@` | SALES | 8% | Closes the one that gets returned |
| Marielle Fontaine | `marielle@` | SALES | 8% | — |
| Marcus Bell | `sales.director@` | MGR | — | Reads the team, not the payroll |
| Hannah Okafor | `accounting@` | ACCT | — | The checker on every cycle |
| System Administrator | `it@` | ADMIN | — | Catalogue and access |

Seeded catalogue: **7 shows** across VFW, VKFW and GFC (Vancouver, New York, London, Milan, Paris,
Tokyo), **14 packages**, **11 add-ons**, **6 tax profiles**. Reporting currency is CAD; FX at the time
of this walkthrough was USD 1.37, EUR 1.49, GBP 1.74.

## The sales this walkthrough created

Five real submissions, referenced throughout. The first four were created through the API; the fifth
was created through the browser UI (Cycle 6).

| Ref | Designer / brand | Show | Package | Value | Ends up |
| --- | --- | --- | --- | --- | --- |
| `S-26-1001` | Nadia Oyelaran — OYELARAN | VFW FW26 Vancouver | Gold | USD 22,050 | Exported, part-paid, contract attached |
| `S-26-1002` | Lucia Ferrante — CASA FERRANTE | GFC Milan FW26 | Gold, *customized* | EUR 22,690.80 | Exported after double sign-off |
| `S-26-1003` | Tomas Rehak — REHAK ATELIER | VKFW FW26 | VIP | USD 12,810 | Returned to sales |
| `S-26-1004` | Émilie Ndoye — ÉTUDE—NDOYE | GFC Paris FW26 | Silver, renamed | EUR 24,300 | Approved after custom-package sign-off |
| `S-26-1005` | Rin Matsuda — MATSUDA ATELIER | GFC Tokyo FW26 | Silver | USD 21,340.80 | Exported, part-paid, **created in the UI** |

---

# Cycle 1 — The sale, intake to ledger

The spine of the system. Six stages, three different people, and two places it can refuse to continue.

```
 rep drafts ──> PENDING ──> accounting approves ──> APPROVED
                                 │                     │
                         (or returns)            invoice number
                                 │                     │
                            RETURNED             invoice PDF ──> emailed
                                                       │
                                            payment plan ──> payments
                                                       │
                                                  EXPORTED (QuickBooks)
```

## 1.1 — Intake: the rep drafts the sale

Aiko creates `S-26-1001` on the **New submission** screen: contact details, show `VFW-FW26`, package
`VFW-GOLD`, add-ons *Runway Photo & Video Rights* and *Backstage Media Content*, a 10% discount and a
5,000 deposit.

**The client sends what was sold; the server decides what it costs.** `CreateSubmissionDto` carries no
price, no subtotal, no tax and no total — a browser cannot be the authority on what a package costs.
What came back:

| | |
| --- | --- |
| Package (Gold, Vancouver) | USD 22,000 |
| Add-ons (600 + 600) | USD 1,200 |
| **Subtotal** | **USD 23,200** |
| Discount, 10% | −2,200 |
| Taxable | 21,000 |
| GST 5% | 1,050 |
| **Total** | **USD 22,050** |
| Deposit | 5,000 |
| **Balance** | **17,050** |
| Commission (10%) | 2,100 |

**Two rules are visible in that arithmetic, and both are easy to get wrong:**

- **The discount is 2,200, not 2,320.** A percentage discounts the *package only* and never touches
  the add-ons. `pricing.service.spec.ts` pins this twice — once for percentages, once for a flat
  amount larger than the package, which "never spills into the add-ons".
- **Commission is 2,100 — 10% of 21,000**, the discounted *pre-tax* figure. Not of the subtotal, and
  not of the total. The rep is paid on the revenue they actually brought in, not on the tax the
  government takes.

The rate used is the one recorded on the sale at creation. Changing Aiko's percentage tomorrow moves
her next sale and not this one.

**A contact is created as a side effect.** After the three sales, Contacts held OYELARAN, CASA FERRANTE
and REHAK ATELIER without anyone visiting the Contacts screen. Intake is the customer book's write path.

## 1.2 — The queue: accounting decides

Hannah opens **Approval queue** and sees all three pending sales. Aiko sees only her own row — the
queue read is row-scoped, which is why `submission.queueView` can safely include SALES.

**The maker cannot be the checker.** Aiko approving her own sale:

```
POST /api/submissions/{id}/approve        (as Aiko, SALES)
403  "Your role cannot submission.approve"
```

Reading the queue and deciding on it are different permissions on purpose. `queueView` lets a rep
watch their sale's progress; `approve`/`reject`/`return` stay with ACCT and ADMIN.

Hannah approves `S-26-1001` with a GL account and cost centre. Status → `APPROVED`.

## 1.3 — Invoice number, then the PDF

Approval does **not** allocate an invoice number — that is a separate, deliberate act.

```
POST /api/submissions/{id}/invoice
S-26-1001 (VFW)  ->  VFW-2041
S-26-1002 (GFC)  ->  GFC-1001
```

**Two brands, two sequences.** VFW sales draw from `invoicePrefix` + `nextInvoiceSeq`; GFC sales draw
from `gfcInvoicePrefix` + `nextGfcInvoiceSeq`. They are allocated transactionally and the counters are
read-only in the admin Settings tab — nobody hand-types the next number, because two people clicking
at once must not get the same one.

The PDF is rendered server-side from the same record:

```
GET /api/submissions/{id}/invoice.pdf
200  application/pdf   2,498 bytes   (PDF 1.3, 1 page)
```

`invoice.generate` (ACCT, ADMIN) gates both. Sending it to the client is `email.send` — same two roles
— and the sent copy is logged in the **Emails** module, which the submission screen links to directly.

## 1.4 — Getting paid: the plan and the ledger

The plan is not accounting's private business. Aiko — a **sales rep** — sets the schedule on the
17,050 balance herself:

| # | Label | Due | Amount |
| --- | --- | --- | --- |
| 1 | On signing | 2026-08-20 | 6,000 |
| 2 | 60 days before show | 2026-01-15 | 6,000 |
| 3 | Balance, on show week | 2026-03-16 | 5,050 |

`installment.plan` and `installment.mark` are open to every role that can work a sale, so a rep
arranges terms with their designer and records money as it lands without routing each step through
Accounting. The schedule is a **PUT** — the client sends the plan it wants to exist and the server
reconciles; instalments already paid cannot be rewritten.

Aiko marks instalment 1 paid, reference `FT26218004311`:

```
paid 5,000 → 11,000        balance 17,050 → 11,050        payStatus PARTIAL
```

**Then the part that matters.** Undoing that mark does not delete it:

```
payments ledger after unmark:
  2026-08-06   +6,000   Wire transfer   FT26218004311
  2026-08-06   −6,000   Wire transfer   Reversal of instalment 1
```

The balance returns to 17,050 by *arithmetic*, not by erasure. This is why widening who may record a
payment does not widen what a payment can quietly do — every correction leaves both lines standing.

## 1.5 — QuickBooks

```
POST /api/submissions/{id}/export        (as Hannah, ACCT)
VFW-2041 → EXPORTED
GFC-1001 → EXPORTED

POST /api/submissions/{id}/export        (as Aiko, SALES)
403  "Your role cannot quickbooks.export"
```

The audit line records what was posted and as what:
`EXPORTED — Posted to QuickBooks Online as Invoice VFW-2041`.

Editing a sale after this point still works but warns that QuickBooks will not follow — the ledger
across the boundary is no longer this system's to correct.

---

# Cycle 2 — When the sale is not routine

Three exception paths, each with its own gate. They compose: `S-26-1002` triggered two at once.

## 2.1 — Return to sales, and resubmit

Diego's `S-26-1003` (VKFW VIP, USD 12,810) arrives with the invoice-to entity unconfirmed. Hannah
returns it with a note — which is **required**, not optional:

```
POST /api/submissions/{id}/return
{"note": "Invoice-to entity not confirmed. Please attach the parent company details and resubmit."}
status → RETURNED
```

The sale lands in the queue's second card, **Returned to sales**, where Diego corrects it and sends it
back. The queue also carries a direct **Edit** shortcut on the row, so a returned sale can be fixed
without opening it first.

## 2.2 — Discount above the threshold

`Settings.discountApprovalPct` is **15%**. Priya's Milan sale is discounted 25%. Approving it plainly:

```
400  "This sale is discounted 25.00%, above the 15.00% that needs accounting sign-off.
      Re-send with acknowledgeDiscountOverride: true to approve it anyway."
```

Not a warning banner. The API refuses, names both numbers, and says exactly what to send. The approver
has to say out loud that they are overriding the threshold, and the audit entry records that they did.

## 2.3 — Customized and non-catalogue packages

A rep is not limited to the rate card. On `S-26-1002` Priya overrode the price (27,000 EUR against a
30,600 catalogue price), the name, the look count (21) and the description — the sale still prices
through `PricingService` exactly like a catalogue sale, and comes back flagged `packageCustomized: true`.

The queue shows a **Custom package** pill on the row. And the sign-off is *separate* from the discount
one — acknowledging the discount alone is not enough:

```
POST .../approve  {"acknowledgeDiscountOverride": true}
400  "This sale uses a customized or non-catalogue package.
      Re-send with acknowledgeCustomPackage: true to approve it as priced."
```

**Two independent gates, both required.** They answer different questions — *"is this price too low?"*
and *"is this even our product?"* — and neither implies the other. Only with both did it approve:

| | |
| --- | --- |
| Package (overridden) | EUR 27,000 |
| Add-on (photo rights) | 760 |
| Subtotal | 27,760 |
| Discount 25% (of 27,000) | −6,750 |
| Taxable | 21,010 |
| GFC quoted 8% | 1,680.80 |
| **Total** | **EUR 22,690.80** |

The catalogue itself was untouched. This is a per-sale deviation, not a rate-card edit.

## 2.4 — Void

`submission.void` (ACCT, ADMIN) is a **soft delete**: hidden from lists and reports, kept for audit,
and reversible with `unvoid`. There is no hard delete on a sale anywhere in the system.

---

# Cycle 3 — The people cycle: hours to payment

Attendance and Payroll are joined but not merged, and the seam is deliberate.

## 3.1 — Attendance

Aiko records four days. Two ways to state a day, and the system resolves the conflict in one direction:

| Date | Status | In | Out | Hours |
| --- | --- | --- | --- | --- |
| 2026-08-03 | PRESENT | 09:00 | 17:30 | **8.5** (derived) |
| 2026-08-04 | PRESENT | 09:00 | 17:30 | **8.5** (derived) |
| 2026-08-05 | PRESENT | 09:00 | 17:30 | **8.5** (derived) |
| 2026-08-06 | REMOTE | — | — | **6.5** (typed) |

Month summary: `days 4, daysWorked 4, hours 32.00, avgHours 8.00`.

**Times beat a typed total.** When both are present the times win, so a row can never contradict
itself. A day is written with **PUT**, whole — omitted fields are cleared, not preserved, because half
a day's record arriving without the other half is how a row ends up claiming someone worked remotely
for zero hours between times that no longer agree.

The times are wall-clock strings and the date is a calendar date, both sent by the **browser** — the
API runs in UTC and does not know what time it is where the person is standing.

Marcus (MGR) opens **Attendance → Team** and sees every active account for the month, *including the
people who recorded nothing* — which is the entire point of the screen.

## 3.2 — The payroll statement is derived

Aiko's August, read live — nothing here is stored:

```
sales:      count 1   revenue CAD 28,770.00   invoiced CAD 30,208.50
attendance: days 4    hours 32.00
pay:        base 0.00 + commission 2,877.00 = gross 2,877.00
            commissionUnpaid 2,877.00
```

- **USD 2,100 commission × 1.37 = CAD 2,877.** Everything consolidates to CAD through the FX rates in
  Administration → Settings.
- **Base is 0.00 even though she worked 32 hours** — Aiko is `COMMISSION_ONLY`. An `HOURLY` account
  would multiply those same hours by their rate; `SALARY` would ignore them. This is the join between
  the two screens, and it only pulls for one pay type.
- **`commissionUnpaid` equals the whole commission.** Commission is earned on *approval*, but the
  client has only part-paid — so a month's gross can sit entirely against money not yet collected.
  The figure is shown beside the total rather than buried.

## 3.3 — The payroll invoice is stored, because it is a claim

The statement is a calculation. An invoice is a **claim made against it**, and claims get argued over,
so they persist. Same maker/checker shape as a sale:

**Submit** (Aiko, `payroll.submit`) → `SUBMITTED`, freezing base 0 / commission 2,877 / gross 2,877.

**Edit before sign-off** (Hannah, `payroll.approve`). Accounting can correct the frozen figures — but
the note is mandatory:

```
PATCH /api/payroll/invoices/{id}   {"base": 500}
400  "note must be a string" / "note must be longer than or equal to 1 characters"
```

An edit to someone's pay must always say why. With one:

```
{"base": 500, "note": "Q3 retention bonus agreed by Marcus; not derivable from the month."}
base 0 → 500      gross 2,877 → 3,377
```

**Self-approval is refused:**

```
POST /api/payroll/invoices/{id}/approve   (as Aiko)
403  "Your role cannot payroll.approve"
```

Hannah approves. `status → APPROVED`, and Aiko's `lifetimeEarned` moves `0.00 → 3,377.00`, visible on
both *My pay* and Account.

Note the statement still derives 2,877 while the approved invoice says 3,377. That is correct and is
the reason invoices exist: the derived number is the starting position, not the last word.

## 3.4 — Where the manager stops

Marcus (MGR) holds `attendance.viewTeam` and reads the whole team's hours. He does not hold
`payroll.viewAll`:

```
GET /api/payroll/run?month=2026-08     (as Marcus, MGR)
403  "Your role cannot view the payroll run"
```

**A sales manager reads the team's hours and their numbers, not their salaries.** This is the one
place in the system where MGR sees deliberately less than Accounting, and it is the sharpest line in
the permission matrix.

---

# Cycle 4 — Oversight: what the system remembers

## 4.1 — Audit trail (business events)

Twenty entries were written by the cycles above, each inside the transaction of the change it
describes. There is no POST, PATCH or DELETE on the audit controller and no admin override that adds
one. A sample from `S-26-1001`:

```
EXPORTED           Posted to QuickBooks Online as Invoice VFW-2041          Hannah Okafor (ACCT)
INSTALLMENT_PAID   Instalment 1 (On signing) — 6000.00 USD by Wire transfer
                   (ref FT26218004311)                                      Aiko Tanaka (SALES)
PAYROLL_APPROVED   Payroll approved for 2026-08                             Hannah Okafor (ACCT)
```

Each carries a structured `payload` alongside the human sentence — the instalment line above also
recorded `balance`, `paidAmount`, `payStatus` and the `paymentId`. A rep sees their own record's
history on the submission itself; the company-wide trail is `reports.view` (ACCT, MGR, ADMIN).

## 4.2 — Logs (console telemetry)

A different claim from the audit trail: who signed in, what they opened, who they messaged. Every
login in this walkthrough appeared as a `LOGIN` row. `activity.view` — ACCT and ADMIN.

## 4.3 — Reports

Ten report types, all consolidating to CAD through the configured FX. Run live against this data:

**Revenue analysis**

| Show | Package | Cur | Taxable | Tax | Total | Paid | Balance |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GFC — Milan | Gold Package | EUR | 21,010.00 | 1,680.80 | 22,690.80 | 8,000.00 | 14,690.80 |
| Vancouver Fashion Week | Gold Package | USD | 21,000.00 | 1,050.00 | 22,050.00 | 11,000.00 | 11,050.00 |

**Sales representative performance** — note it scores reps who sold nothing, and counts Diego's
returned sale as closed-none:

| Rep | Subs | Appr | Rev (CAD) | Target | % | Score | Band |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Aiko Tanaka | 1 | 1 | 28,770.00 | 30,000 | 96% | 64 | Needs Improvement |
| Priya Raman | 1 | 1 | 31,304.90 | 25,000 | 125% | 61 | Needs Improvement |
| Marielle Fontaine | 0 | 0 | 0.00 | 160,000 | 0% | 0 | Performance Review Required |
| Diego Salazar | 1 | 0 | 0.00 | 38,000 | 0% | 0 | Performance Review Required |

**Outstanding receivables**

| Ref | Brand | Due | Terms | Total | Paid | Outstanding | Cur |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S-26-1001 | OYELARAN | 2026-09-05 | 30 | 22,050.00 | 11,000.00 | 11,050.00 | USD |
| S-26-1002 | CASA FERRANTE | 2026-09-05 | 30 | 22,690.80 | 8,000.00 | 14,690.80 | EUR |

## 4.4 — Export

One export path system-wide: `GET /api/export/{dataset}?format=csv|xlsx|pdf`. All three verified:

```
csv   200  text/csv                    777 b
xlsx  200  ...spreadsheetml.sheet    7,622 b
pdf   200  application/pdf           2,398 b
```

Three properties worth knowing, all confirmed:

- **The file starts `EF BB BF`** — a UTF-8 BOM, without which Excel mangles the accented designer and
  show names this catalogue is full of. Cells beginning `=`, `+`, `-` or `@` are guarded against
  formula injection.
- **The export can never show more than the screen.** Hannah's submissions export returned 4 lines
  (header + 3 sales); Aiko's returned **2** (header + her own). Same dataset, same endpoint, scoped in
  `load`.
- **Role gates are separate from row scoping.** Aiko requesting the staff list:
  `403 "Your role cannot admin.manage"`. Row scoping answers *which rows*; the permission answers
  *may this role export this at all*. Contacts needs both.
- **`MAX_EXPORT_ROWS` is 10,000** and over the line the download is *refused*, not truncated — a
  truncated export is indistinguishable from a complete one once it is in a spreadsheet, and that is
  exactly the file someone reconciles against.

---

# Cycle 5 — Administration: changing the rules

**ADMIN and ACCT** (`admin.manage`). Accounting holds it as a second keyholder so account recovery
does not depend on one person being reachable — with the consequence, stated plainly, that **a role
that can edit roles can raise its own to ADMIN**.

| Tab | The cycle it runs |
| --- | --- |
| Invitations & approvals | Issue a code with a fixed role → person signs up against it → verifies by OTP → admin approves → account is ACTIVE. Four gates before anyone gets in. |
| Users & roles | Role, pay type, base rate, commission % and target. Changing a commission % moves the next sale, never one already booked. |
| Packages & pricing | Shows, packages, add-ons. Every write is additive. |
| Tax rates | Profiles applied at pricing time. |
| Settings | Discount threshold, both invoice sequences (read-only), FX rates. |
| Configuration | Runtime config straight to the database, no redeploy. Secrets stay in env. |

**Catalogue writes never reach a priced sale.** A submission copies its prices and its tax rate onto
its own record at intake, so changing the Gold package tomorrow leaves `S-26-1001` exactly as sold.
`catalogue-create.spec.ts` and `catalog.spec.ts` hold that line.

**Shows** were added to this tab because seasons used to be a deploy-time concern — the Summer/Spring
filter rendered an empty list purely because no SS shows had been seeded, which is a content problem
wearing a bug's clothes.

---

# Cycle 6 — The same sale, driven through the browser

Everything above was executed against the HTTP API. The cycle was then run a second time **through the
real UI in Chrome**, as a sales intake by an administrator, to confirm the screens agree with the API.
That run produced `S-26-1005` — MATSUDA ATELIER, GFC Tokyo FW26.

## 6.1 — What the intake form does that the API cannot show

- **A live total that admits it is a guess.** The right-hand panel prices the sale as you build it, under
  the label *"Indicative only. Accounting's figure is recomputed from the rate card on submit."* The
  form is a calculator; the server is the authority. On submit the server returned **$21,340.80** —
  identical to the indicative figure, but arrived at independently.
- **The discount rule is printed under the field**: *"Applies to the package price only — add-ons are
  never discounted."* The same rule `pricing.service.spec.ts` pins.
- **The instalment builder** generated 3 × $5,113.60 = $15,340.80 the moment the deposit was entered —
  exactly the balance — and labels itself *"Indicative. The final schedule is generated from
  Accounting's balance when the sale is sent."*
- **Customize this package for this sale** appears as a checkbox only once a package is chosen.

## 6.2 — A real document, really uploaded

Storage was configured against a local S3-compatible bucket, and a signed participation agreement was
attached from the submission detail screen. The full path ran in the browser: presign → PUT direct to
storage → commit. Verified three ways — the Documents table lists it, the audit trail records
`DOCUMENT_ATTACHED — contract: MATSUDA-participation-agreement.pdf`, and the object is in the bucket at
its storage key. A download returned a byte-identical file.

**The file never passes through the API.** The bytes go from the browser straight to storage; the API
only signs a short-lived URL and later records a row pointing at the key.

## 6.3 — The queue makes the approver say it out loud

Two sales sat pending. The clean one (`S-26-1005`) opened a modal with GL account and cost centre and
nothing else. The customized one (`S-26-1004`) opened the same modal plus a panel that puts the two
prices side by side:

```
This sale uses a customized/non-catalogue package.
  Rate card:        Silver Package · 12 looks · €22,500.00 EUR
  Actually charged: Silver — capsule « Harmattan » · 12 looks · €22,500.00 EUR
  ☐ I acknowledge this customized/non-catalogue package and approve it as priced.
```

**The Approve button is disabled until that box is ticked** — the UI enforces in the control what the
API enforces with a 400. The rate-card comparison is the part the API cannot convey: the approver is
shown what the sale *would* have been.

## 6.4 — The rest of the cycle, on screen

| Step | What the screen showed |
| --- | --- |
| After approval | The action bar changed **Edit → Amend**, and *Generate invoice* appeared |
| Invoice | **GFC-1002** — the GFC sequence, one after `GFC-1001`, while VFW sales run on `VFW-204x` |
| QuickBooks | The real QBO JSON payload, previewed before posting: `__apiTarget: /v3/company/{realmId}/invoice`, `DocNumber: GFC-1002`, `CurrencyRef: USD`. The screen states plainly that **the OAuth transport is stubbed** |
| Payment | Instalment 1 marked paid → *"1 of 3 paid · $5,113.60 USD of $15,340.80 USD"*, with **Undo** beside it |
| Invoice number card | Warns, once approved: *"If the invoice has already been sent, the client is holding a document with the old number on it."* |

## 6.5 — Attendance, Payroll and Administration on screen

- **Attendance.** *Clock in* stamped the browser's wall clock (`In 09:39`) — the API never guesses the
  local time. A day recorded 09:00–17:30 became **8.50h**, derived. The Team tab listed all seven staff
  including the six with nothing recorded.
- **Payroll.** Three tabs as documented. The run totalled **$8,063.39 CAD** across 7 people, all of it
  commission, all of it flagged not yet collected. On the Approvals tab, the edit dialog's save button
  is **disabled until a reason is typed** — the same rule the API enforces by rejecting the request. A
  $750 stipend with its justification took Priya Raman's month from $5,186.39 to **$5,936.39**.
- **Administration → Packages & pricing.** The tab carries three cards; the **Shows** card created
  `VFW-VAN-SS27` (id derived from brand + city + season). The new-submission form's *Summer/Spring* tab,
  which had been empty because no such show was seeded, then offered it. That is the whole reason the
  card exists, demonstrated end to end.

---

# Cycle 7 — Oversight and communication

## 7.1 — Logs, and why it is not the Audit trail

`/logs` states the distinction in its own subtitle: *"Activity telemetry across the console — sign-ins,
screens opened and messaging. Read-only and separate from the financial audit trail."* The service says
why: the audit trail is submission-scoped financial evidence and *"must not be polluted with routine
sign-in noise."*

**Users tab** — one row per account: last login, last activity, sessions, time online, messages, with an
`ONLINE` badge for anyone connected. Marielle Fontaine, the one seeded account nobody has signed into,
reads `NEVER`.

**Activity tab** — one row per event, filterable by action and free text, 50 to a page. The action list
is built from the actions actually present, not a hardcoded enum. Observed kinds: `LOGIN`, `LOGOUT`,
`CONNECT`, `DISCONNECT`, `MODULE VIEW`, `ATTENDANCE MARKED`, `DATA EXPORT`.

Two things worth knowing:

- **`LOGOUT` and `DISCONNECT` are different events**, and both fire within the same minute when someone
  signs out — the auth transition and the socket transition are recorded separately.
- **`MODULE_VIEW` is the only action a client may report.** `activity/dto.ts` pins `TrackDto.action` to
  `IsIn(['MODULE_VIEW'])` — *"everything else is written server-side where it cannot be forged."*
  Telemetry is not spoofable from the browser.

**Sessions tab** — one row per connection, with live sessions showing elapsed-so-far. Sessions are
created on the **websocket connect**, not on login, which is why accounts that signed in via the API
alone show zero. The column reads "SESSIONS" but does not mean "logins".

A detail that reflects well on the code: sessions orphaned by a dead process are stamped with an
`endedAt` but a **null duration** — *"we know it started but not when it ended, so we stamp `endedAt`
without a duration (null = unknown) rather than invent one."*

## 7.2 — Emails

Two tabs, Sent and Received, both legitimately empty here (HTTP 200, no mail sent). The empty states
differ meaningfully: Sent says mail *"will appear here"*, Received says *"once an inbox is connected"* —
inbound needs an integration that is not wired up.

The footer caption is permission-derived: an `email.viewAll` holder reads *"Every message the system has
sent and received"*, everyone else *"Emails you have sent."* Same list, scoped by role. A kind filter
(Verification, Welcome, Password reset, Invitation, Invoice, Test, Received, Other) persists across a
Sent↔Received switch.

## 7.3 — Messages

A conversation list beside the open thread, with a **New chat** modal offering Direct message or Group.
Everyone may message everyone — there is no role gate on the picker, and self is excluded from it.

A test message sent to Marcus Bell appeared instantly with a single `✓` — delivered, unread, consistent
with him being offline. **No unread badge appeared, correctly**: the badge sums `unreadCount` across
conversations, which excludes your own messages.

The messaging path feeds Logs: after sending, the admin's `MESSAGES` column moved 0 → 1.

*Not verified:* the badge **incrementing** on an inbound message needs a second staff session sending to
you, which a single-session walkthrough cannot drive.

---

# Cycle 8 — The customer book, and the notes about it

## 8.1 — Contacts, and what "lifetime value" counts

The list is `Brand · Type · Designer · Email · Country`, searchable across brand, designer and company —
**not email**, which is displayed but not searchable.

The detail view carries identity, **Lifetime value**, and submission history. The two deliberately
disagree, which is the point:

| Contact | Submission history | Lifetime value |
| --- | --- | --- |
| OYELARAN | S-26-1001 — USD 22,050.00, *Exported* | **USD 22,050.00** |
| REHAK ATELIER | S-26-1003 — USD 12,810.00, *Returned to sales* | **"No approved deals yet."** |

Lifetime value counts only `APPROVED` and `EXPORTED`, and sums **each currency separately, never across
currencies**. A returned deal appears in the history and contributes nothing to the value.

**The exported file carries more than the screen.** The Contacts CSV adds Company, Phone and Added. It
also demonstrates two hardening measures in one line: a UTF-8 BOM so Excel renders `ÉTUDE—NDOYE`
correctly, and a **leading apostrophe on phone numbers** so `+39 02 5550 1187` is not evaluated as a
formula.

## 8.2 — Designer feedback attaches to the designer, not the sale

Confirmed by inspection of the form: the *Designer / brand* selector's option values are **contact ids**,
identical to the `/contacts/:id` URLs. There is no submission reference anywhere on the model or table.

Opening **+ Record** from a submission shows the same modal **with the selector removed** — the contact is
inferred from the sale. The panel is headed *"Nothing recorded for OYELARAN yet"*: brand-scoped, not
sale-scoped.

**The consequence is worth stating plainly:** feedback recorded from one sale attaches to the designer,
so it surfaces against *every* sale for that brand — not only the one it was recorded from.

**"A coaching signal, not a compensation input" — verified, not assumed.** A 4★ review was recorded
against CASA FERRANTE, whose sale belongs to Priya Raman. The Leaderboard before and after was
**byte-identical**, Priya included. Ranking uses revenue, approved sales, collection and retention only.

## 8.3 — Internal notes, and the rule that outranks being an administrator

Notes are written from the submission detail, tagged by department (Accounting, Production, Marketing,
Event Management), and read on `/internal`.

`S-26-1005` has **System Administrator as its rep** — the account doing this walkthrough. The result is
the sharpest permission behaviour in the system:

**In the UI the entire Internal notes panel is absent from that sale.** Not an error, not an empty
state — the section is not rendered. Underneath, the API refuses both directions:

```
GET  /api/submissions/{S-26-1005}/comments → 403
  "Internal comments about your own submissions are not visible to you"
POST /api/submissions/{S-26-1005}/comments → 403
  "You cannot record an internal comment on your own submission"
GET  /api/submissions/{S-26-1001}/comments → 200
```

**A 403, not an empty list** — an empty list would read as "nothing has been said about you", which is a
claim the endpoint cannot honestly make.

Three layers hold it, and all three were tested rather than assumed:

1. **The ACL** — `internal.view` / `internal.comment`, neither including SALES or INTERN.
2. **`notAboutMe`** — `{ submission: { repId: { not: user.id } } }`, applied to every read. It is
   role-independent, so **being ADMIN does not override it**.
3. **It is not in the payload at all** — fetching the submission directly returns no `comments` key and
   the note text appears nowhere in the response. There is no conditional include to get wrong.

The export path routes through the same filtered list, so the rule survives into a downloaded file —
which matters, because a manager who carries their own deals passes the permission gate and only
`notAboutMe` stops them.

Note the deliberate asymmetry: on that same own-sale page the **Designer feedback panel remains**.
Feedback is about the designer; internal notes are about the rep.

---

# Bugs found while walking the system

All were found by using the system, not by reading it.

### 1. The nav rail and the route guard disagreed about Logs — **fixed**

`activity.view` was widened to `['ACCT', 'ADMIN']`, and the route guard reads that permission, but the
`NAV` entry in `Shell.tsx` still said `roles: ['ADMIN']`. Accounting could reach `/logs` by typing the
URL and could not see the link. Fixed; every nav item's `roles` now matches its route's permission.

### 2. The Approval queue shows a different discount % than the rule uses — **open**

The threshold is evaluated against the **package price** (`pricing.service.ts:161`):

```ts
discountPct: packagePrice.gt(0) ? r2(discountAmount.dividedBy(packagePrice).times(100)) : 0
```

The queue displays the discount against the **subtotal** (`Queue.tsx:98`):

```ts
const pct = Number(s.subtotal) > 0 ? (Number(s.discountAmount) / Number(s.subtotal)) * 100 : 0;
```

Whenever a sale carries add-ons the two disagree, and the displayed figure is always the smaller one.
`S-26-1005` was entered at 5% and the queue rendered **4.8%**.

This matters because of what the number is *for* — the code comment above it says it exists to
"surface a deep discount here rather than making Accounting open the record to find it", i.e. to inform
the approve/reject decision. A sale discounted 15.4% of package with enough add-ons can display as
under 15%, look safely inside the threshold, and then be refused at approval with a message quoting a
percentage the approver never saw. The fix is to divide by `packagePrice`, the same basis the rule uses.

### 3. Every read screen fails silently as an empty state — **open, and the broadest of these**

`SessionsTab` (`Logs.tsx:311`) is representative:

```ts
const { data, isLoading } = useQuery({ ... });   // isError is never read
const rows = data?.sessions ?? [];
…
) : rows.length === 0 ? ( <div className="empty"><h3>No sessions</h3></div> )
```

A failed request leaves `data` undefined, so `rows` is empty, so the screen renders a confident
**"No sessions"**. No error, no console output, nothing. An administrator auditing who was online is
shown a wrong answer with no indication that it is wrong.

Counted across `frontend/src`: **52 `useQuery` call sites, none of which surface a fetch failure.** The
only `isError` in production code guards a *mutation*.

`ContactDetail.tsx:32` is the same bug with a sharper edge — it collapses every failure into
*"Contact not found — it may have been opened from a stale link, or it belongs to another
representative."* The 404-for-out-of-scope behaviour it is imitating is deliberate and correct (so a rep
cannot probe for another rep's customers), but the client now makes that specific authorization claim
in response to a 500 or a dropped connection. The API client throws a typed `ApiError` carrying
`status`, so the information needed to tell these apart is available and discarded.

This bug is also *why the walkthrough itself was misled*: when the backend was crash-looping, the
Sessions tab reported "no sessions" and was believed, until the endpoint was queried directly and
returned 200 with 14 rows. A shared query-state wrapper would fix the class.

### 4. An active tab's label is invisible in dark mode — **open**

Reproducible on `/emails`: the selected Sent/Received tab renders as an empty outlined box. The label is
present in the accessibility tree, so it is purely contrast.

```css
/* additions.css:170          specificity (0,2,0) */
.btn.on { background: var(--text); color: var(--card); }
/* console.css:445            specificity (0,3,0) */
:root[data-theme="dark"] .btn, … { background: var(--card) }
```

The themed rule wins on `background` but not on `color`, leaving card-coloured text on a card-coloured
background.

What makes this instructive rather than trivial: `console.css:485` already carries a dark override for
`.tab.on` with the comment *"Active tab underline uses --ink (dark) in the base — invisible on dark."*
The same trap was hit before, fixed for one class, and missed for `.btn.on`. Any new themed component —
including a test-data row highlight — has to clear the same specificity bar.

### 5. "Time online" silently undercounts — **open, minor**

Sessions orphaned by a dead process carry `durationSec = null` deliberately. The Users tab totals with
`_sum(durationSec)`, and Prisma skips nulls, so those sessions contribute zero. The Sessions tab is
honest and shows `—`; the roll-up presents an undercount as a total with nothing signalling it.

### Not a bug — a false positive worth recording

An agent reported that `S-26-1001` (a **VFW** show) posts to GL `4050 — Designer Package Revenue — GFC`
rather than `4010 — … VFW`. The catalogue is in fact correct: `VFW-GOLD` carries `glCode 4010`. The sale
shows 4050 because this walkthrough passed `"glAccount": "4050"` explicitly when approving it over the
API. **Bad test data, not a defect** — recorded here because it is exactly the kind of finding that
looks like a revenue-misclassification bug until the seed is checked.

---

# What this walkthrough did not execute

Stated plainly rather than papered over.

| Step | Why not | To exercise it |
| --- | --- | --- |
| **Sending the invoice email** | Sending mail is an outward-facing action; I did not trigger one without being asked. The relay reports `email: OPERATIONAL`, so the path is live. Designer addresses here use the reserved `.example` domain and cannot resolve. | Submission detail → **Send invoice**, then check the **Emails** module for the logged copy. |
| **A production storage backend** | Uploads were exercised against a local S3-compatible bucket, not Cloudflare R2. The API path is identical, but R2's own behaviour (CORS, lifecycle, credentials) is untested here. | Set the `R2_*` variables from `docs/railway-variables.md`. |

### Two notes on the storage setup used here

- **`R2_ENDPOINT` must be an IP, not a hostname.** With `http://localhost:9000` the AWS SDK switched to
  virtual-host addressing and tried to resolve `vfw-documents.localhost`, which fails.
  `http://127.0.0.1:9000` forces path-style and works.
- **The status page under-reports.** `POST /api/admin/config/test/storage` returns `{"ok":true}` and
  uploads genuinely work, while `GET /api/health` still reports `Document storage: Not configured`. The
  health check appears to read environment variables only and cannot see credentials set at runtime
  through Administration → Configuration — so the public status page can say a working subsystem is
  down.

---

# Appendix — the invariants, in one place

Everything below was demonstrated above, not asserted.

| # | Invariant | Where it showed |
| --- | --- | --- |
| 1 | The client never sends a price; the server computes it | 1.1 |
| 2 | A percentage discount never touches add-ons | 1.1 (2,200 not 2,320) |
| 3 | Commission is on discounted, pre-tax revenue | 1.1 (2,100 of 21,000) |
| 4 | The maker is never the checker | 1.2, 3.3 (both 403) |
| 5 | VFW and GFC draw invoice numbers from separate sequences | 1.3 |
| 6 | A payment correction reverses, never erases | 1.4 (−6,000 line) |
| 7 | A returned sale requires a written reason | 2.1 |
| 8 | Over-threshold discounts need explicit sign-off | 2.2 |
| 9 | Non-catalogue packages need their *own*, separate sign-off | 2.3 |
| 10 | Deleting a sale is soft and reversible | 2.4 |
| 11 | Recorded times beat a typed hours total | 3.1 |
| 12 | Payroll statements are derived; invoices are stored | 3.2, 3.3 |
| 13 | An edit to someone's pay must say why | 3.3 |
| 14 | MGR reads hours and numbers, never salaries | 3.4 |
| 15 | The audit trail is append-only by construction | 4.1 |
| 16 | An export can never reveal more than the screen it sits on | 4.4 (4 rows vs 2) |
| 17 | An oversized export is refused, never truncated | 4.4 |
| 18 | A priced sale is immune to later catalogue edits | 5 |
| 19 | The browser prices a sale only as a preview; the server re-prices on submit | 6.1 |
| 20 | Uploaded bytes go browser → storage directly, never through the API | 6.2 |
| 21 | The approve control is disabled until a required acknowledgement is ticked | 6.3 |
| 22 | A pay edit cannot be saved until a reason is typed | 6.5 |
| 23 | Adding a show makes a previously empty season selectable, changing nothing sold | 6.5 |
