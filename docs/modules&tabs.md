# Modules & Tabs

Every screen in the VFW Console, grouped the way the left navigation rail groups them, with the role that can reach it and the tabs it contains.

Source of truth: `frontend/src/shell/Shell.tsx` (the `NAV` array) and `frontend/src/App.tsx` (the route table). Six modules use tabs — Administration, Logs, Attendance, Payroll, Emails, and Reports (as a report picker). Everything else is a single screen.

Roles: **SALES** (Sales Representative), **INTERN**, **ACCT** (Accounting), **MGR** (Sales Manager), **ADMIN** (Administrator).

---

## Work

### Dashboard — `/`
**All roles.** The landing screen: accounting and admins see what is awaiting approval, everyone else sees their own submissions.

*No tabs.*

### New submission — `/new`
**All roles** (`submission.create`). The form for creating a new submission — contact, show, package,
add-ons, and pricing.

*No tabs.*

**Per-sale package customization.** A rep is not limited to the catalogue as priced. On a sale they can
override the package's price, or its name / looks / description, or abandon the catalogue entirely and
build a custom package for that sale alone. Any of these sets `packageCustomized` on the submission,
which is what the Approval queue keys its extra sign-off off. The catalogue itself is untouched — this
is a per-sale deviation, not a rate-card edit.

### Submissions — `/submissions`
**All roles.** The list of all submissions you are allowed to see, opening into a detail view (`/submissions/:id`) and an edit view (`/submissions/:id/edit`).

*No tabs.*

The detail view carries an **Invoice number** card, and the edit view's availability both shift at
approval — before it, a sale and its invoice number belong to whoever owns them; after it, both
belong to Accounting. The button says *Edit* before a decision and *Amend* after one, and an
amendment keeps the approval rather than sending the sale back through the queue. Editing an
`EXPORTED` sale warns that QuickBooks will not follow. Full rules in
`docs/roles-and-permissions.md` → *Editing a sale, and its invoice number*.

The detail view also carries the money side of a sale:

- **Generate invoice** (`invoice.generate` — ACCT, ADMIN) once the sale is `APPROVED` and has no
  number yet, then **Download invoice (PDF)** server-rendered from the same record.
- **Send invoice** (`email.send` — ACCT, ADMIN) emails it to the contact; the copy is logged in
  **Emails**, and the screen links straight there.
- **Installments card** — the payment plan: scheduled instalments, and marking one paid posts a real
  `Payment` to the ledger. Reading a plan carries no permission of its own (it rides on the sale, so
  whoever sees the sale sees how it is being paid); writing splits into `installment.plan`
  (reschedule, moves no money) and `installment.mark` (post a payment), both now open to every role
  that can work a sale. An undo reverses a mark with a visible negative entry rather than deleting it.
- **Void** (`submission.void` — ACCT, ADMIN) is a soft delete: hidden from lists and reports, kept for
  audit, reversible.

### Contacts — `/contacts`
**SALES, ACCT, MGR, ADMIN.** Searchable directory of client contacts and brands, opening into a per-contact history (`/contacts/:id`).

*No tabs.*

### Messages — `/messages`
**All roles.** Real-time internal chat between staff, with a live unread badge on the nav rail.

*No tabs.* The screen is a conversation list beside the open thread, not tabbed.

### Emails — `/emails`
**All roles** (`email.viewOwn`). The log of mail the system has sent and received — invoices, OTPs,
resets, notifications — with a detail view per message.

| Tab | Who | What |
| --- | --- | --- |
| Sent | all roles | Outbound mail. Row-scoped: a rep sees only mail they triggered; `email.viewAll` (ACCT, MGR, ADMIN) sees the whole log. |
| Received | same | Inbound mail, scoped the same way. |

Reading is split like submissions — everyone may open the module, the list decides which rows.
*Sending* an invoice is an accounting action (`email.send` — ACCT, ADMIN) and happens from the
submission detail, not from here. How mail actually leaves the box is `docs/email-delivery.md`.

### Approval queue — `/queue`
**SALES, ACCT, ADMIN** (`submission.queueView`). Submissions waiting on accounting sign-off, where they
get approved or returned to sales; carries an unread badge showing queue depth.

*No tabs.* Two stacked cards: **Pending accounting approval** and **Returned to sales**.

**Reading the queue is not deciding on it.** SALES holds `queueView` so a rep can see where their own
submission sits, and the read is row-scoped like every other submission read. Acting on one stays with
`submission.approve` / `.reject` / `.return` (ACCT, ADMIN) — the maker and the checker must not be the
same person.

Two things the queue does beyond approve/return:

- **Custom-package sign-off.** A row whose sale was customized (see *New submission*) shows a
  **Custom package** pill, and the approve dialog will not submit until the approver ticks an explicit
  acknowledgement that they are approving a non-catalogue package *as priced*. Approving blind is the
  failure this prevents.
- **Direct Edit shortcut** on a row, so a returned sale can be corrected without opening it first.

### QuickBooks — `/qbo`
**ACCT, ADMIN.** Exports approved submissions to QuickBooks and keeps the ledger of what has already gone across.

*No tabs.* Two stacked cards: **Ready to export** and **Export ledger**.

---

## People

### Attendance — `/attendance`
**All roles.** The timesheet: which days you worked and for how long. A month calendar where each day
opens an editor (status, start/finish, hours, note), plus a Clock in / Clock out pair for today and a
KPI strip totalling the month.

**Two tabs, but only for `ACCT`, `MGR` and `ADMIN`** — a rep sees the single screen with no tab bar,
because "My timesheet" and nothing else is not a choice worth rendering.

| Tab | Who | What |
| --- | --- | --- |
| My timesheet | all roles | Your own month, with the clock buttons. |
| Team | `attendance.viewTeam` | Every active account rolled up for the month — days worked, hours, average, days away — and **including people who recorded nothing**, which is the point of the screen. Opening a person swaps the panel for their calendar, where a manager can correct a day. |

Three things about the data model that the screen depends on:

- **A day is a calendar day, not an instant** (`@db.Date`), and the times are wall-clock `"HH:MM"`
  strings. The browser sends both, because the API runs in UTC and has no idea what time it is where
  the person is standing.
- **One row per person per day**, enforced by a unique constraint. Marking the same day twice rewrites
  it rather than adding a second answer.
- **Times beat a typed total.** If start and finish are both set, `hours` is derived from them —
  otherwise the row could contradict itself.

Attendance is deliberately *not* derived from the `UserSession` telemetry behind Logs: a socket being
connected is a different claim from a day being worked.

### Payroll — `/payroll`
**All roles for your own pay; `ACCT` and `ADMIN` for everyone's.** What each person earned in a month,
and the arithmetic it came from.

| Tab | Who | What |
| --- | --- | --- |
| My pay | all roles | Your own statement: base, commission, gross — beside your full profile, the hours and sales it was derived from, and your lifetime earnings. Also where you submit the month for approval, and where you download the month as a **payslip**. |
| Payroll run | `payroll.viewAll` (ACCT, ADMIN) | Every active account for the month, with run totals, and a row that opens into that person's statement. |
| Approvals | `payroll.approve` (ACCT, ADMIN) | The queue of submitted payroll invoices — edit the figures, then approve or reject. |

A rep with neither permission sees no tab bar at all, just their own statement.

A statement is **base + commission = gross**, with each part shown as its own arithmetic rather than
as a total to be taken on faith:

- **Base** comes from the account's pay type — `SALARY` (a fixed monthly figure), `HOURLY` (the rate
  × the hours on their Attendance timesheet) or `COMMISSION_ONLY` (no base). Set in Administration →
  Users & roles.
- **The pay basis is two settings, not one.** Alongside the pay type, `earnsCommission` says whether
  the account is on commission at all. Crossed, they give the three arrangements people are hired
  on: *commission only* (`COMMISSION_ONLY`), *salary only* (`SALARY`/`HOURLY` with commission off),
  and *both*. `COMMISSION_ONLY` with commission off is refused — it is an account paid nothing.
  Turning commission off applies where the rate is stamped onto the sale at creation, so it moves the
  **next** sale and never rewrites one already on the books; a rep taken off commission is still paid
  what they closed before the change.
- **Commission** is the sum of `commissionAmount` on the sales they closed, counted in the month the
  sale was **approved**, consolidated to CAD. The rate is the one recorded on each sale when it was
  created, so changing someone's percentage today moves their next sale and not one already booked.
- **Commission not yet collected** is shown beside the total: commission is earned on approval, so
  part of a month's gross can be sitting against invoices the client has not settled.

The **statement** is derived on every read — nothing is stored. See `docs/roles-and-permissions.md` →
*Payroll: derived, never stored* for why, and for the one place `MGR` sees less than Accounting.

#### The payslip — `GET /api/payroll/payslip.pdf?month=&userId=`

The same statement as a document: one person, one month, printable and keepable. It carries the
period and the whole person (name, employee ID, role, title, department), the pay basis as one
phrase, the earnings with each line's arithmetic beside it, the sales summary and attendance it was
derived from, and — where the month has been claimed — the payroll invoice's status, reviewer and
date.

Three decisions are worth recording, because each had an obvious-looking alternative:

- **It is not an export dataset.** `/api/export/:dataset` renders a *table* in csv/xlsx/pdf, and a
  payslip is not a table; forcing it through would have produced a two-column Item/Value spreadsheet
  nobody asked for. It follows `submissions/:id/invoice.pdf` instead — one record, one client-facing
  artefact — and reuses the same **pdfkit** renderer, so no second PDF library entered the tree. This
  is also why *Payroll → My pay* still has no `<ExportMenu>`: the month it came from exports from
  *Payroll run*, and the single statement gets a document rather than a table.
- **It owns no permission check.** The route carries `payroll.viewOwn` to reach the module and then
  goes through `PayrollService.statementFor`, whose `subject()` already resolves whose month this is:
  yours always, anyone else's only with `payroll.viewAll`. A second copy of that rule on a route that
  hands out a *file* is exactly the copy that would drift.
- **Every generation is audited** (`PAYSLIP_GENERATED`), including your own. A payslip is a file that
  leaves the system and gets forwarded, and the question it eventually provokes is "who produced this
  copy, of whose pay, for which month" — a trail that logged only somebody-else's downloads could not
  answer it for the copy most likely to be in dispute.

Not one figure on it is recomputed — a payslip that disagreed with the screen it was downloaded from
would be the worst bug this module could have, because the printed copy is the one that gets argued
from.

#### Payroll invoices — the one thing here that *is* stored

The derived statement is a calculation; a **payroll invoice** is a claim made against it, and a claim
has to persist because it gets argued over. The lifecycle is maker/checker, exactly like a sale:

1. **Submit** (`payroll.submit` — all roles, and it can only ever resolve to the caller). You send
   your own month's statement for approval from *My pay*.
2. **Review** (`payroll.approve` — ACCT, ADMIN). Accounting can *edit the figures before sign-off* —
   the derived number is the starting position, not the last word — then approve or reject.

`payroll.submit` mirrors `payroll.viewOwn` (yours to see, yours to submit) and `payroll.approve`
mirrors `submission.approve`: the maker and the checker must not be the same permission. **`MGR` holds
neither half of the approval** — a sales manager reads the team's hours and their numbers, not their
salaries. **Lifetime earnings** roll up from approved invoices and show on both *My pay* and Account.

### Leaderboard — `/board`
**All roles.** Ranks sales representatives by performance over the selected period.

*No tabs.*

### Designer feedback — `/feedback`
**ACCT, MGR, ADMIN.** Collects and reviews the feedback designers leave against submissions.

*No tabs.*

### Internal notes — `/internal`
**ACCT, MGR, ADMIN.** Internal operational comments on submissions, kept out of anything client-facing.

*No tabs.*

---

## Insight

### Reports — `/reports`
**ACCT, MGR, ADMIN.** Runs a chosen report over a chosen period, and exports it through the
system-wide export menu (PDF / Excel / CSV) like every other screen — see *Export coverage*.

Not tabs strictly — a toolbar of report types (defined in `backend/src/reports/reports.service.ts`), one shown at a time:

| Report | What it shows |
| --- | --- |
| Revenue analysis | Revenue totals across the period, consolidated to CAD. |
| Sales by event | Revenue and volume broken down per event. |
| Sales by city | Revenue and volume broken down per city. |
| Package popularity | Which packages are selling and how often. |
| Customer retention | Repeat-business behaviour across contacts. |
| Outstanding receivables | What has been invoiced but not yet collected. |
| Payment collection | Payments recorded over the period. |
| Sales representative performance | Per-rep volume and revenue. |
| Designer feedback trends | Aggregate patterns in designer feedback. |
| Internal operational comments | Internal notes rolled up for review. |

All figures convert through the FX rates set in **Administration → Settings** before they are summed; CAD is the reporting currency.

### Audit trail — `/audit`
**ACCT, MGR, ADMIN.** Immutable record of business events (who changed what, when) for compliance review.

*No tabs.*

---

## System

### Administration — `/admin`
**ACCT and ADMIN** (`admin.manage`). The control panel for who gets in, what things cost, and how the
system behaves.

Accounting holds this as a *second keyholder*, so account recovery does not depend on a single admin
being reachable. Note the consequence, stated plainly because it is not obvious: **a role that can edit
roles can raise its own to ADMIN**, so this grant is effectively a grant of everything below it.

| Tab | What it does |
| --- | --- |
| Invitations & approvals | Issues invitation codes with a fixed role, revokes them, and reviews sign-ups pending approval. |
| Users & roles | Lists staff accounts and changes each one's role, pay basis (pay type plus whether they earn commission) and rates. |
| Packages & pricing | Three cards: **Shows**, the package catalogue, and the add-on catalogue. New rows are created from the button on each card; package and show ids are derived from the brand (and city/season), and stay fixed once created because that is what submissions point at. |
| Tax rates | Adds to and maintains the tax rates applied at pricing time. New profiles are created from the button on the card; the code is typed, not derived, because it is the key packages and cities point at. |
| Settings | Discount approval threshold, invoice prefix and next invoice number (read-only, allocated transactionally), and the FX rates every report converts through. |
| Configuration | Edits runtime config straight to the database — no redeploy — for values that aren't needed before the database is reachable. Passwords and secrets stay in env. |

Tabs are defined in `frontend/src/pages/Admin.tsx` (`TABS`); the Configuration tab lives in `frontend/src/pages/AdminConfig.tsx`.

Every catalogue write is additive and never reaches a sale that has already been priced — a submission copies its prices and its tax rate onto the record at submission time. `backend/src/admin/catalogue-create.spec.ts` and `catalog.spec.ts` hold that line.

**Shows** (the `Event` table) follow the same rule: adding one makes it selectable on the new-submission
form and changes nothing already sold. The card exists because seasons used to be a deploy-time
concern — the Summer/Spring filter on the submission form rendered an empty list purely because no SS
shows had been seeded, which is a content problem wearing a bug's clothes.

#### Known gap — `listValue` and `cap` are not editable

`Package.listValue` (the revenue forgone on a sponsored package, which reporting shows) and `Package.cap` (a per-event limit — VKFW VIP has only 2) exist in the schema and are set by the seed, but no admin screen touches either. Neither the new-package modal nor the edit modal can set them, so a sponsored or capped package cannot currently be created from the console — it has to be seeded or written directly. Wiring them up means adding them to both modals together; adding them to only one would leave the tab able to create a package it cannot then edit.

### Logs — `/logs`
**ACCT and ADMIN** (`activity.view`). Telemetry on how the console itself is being used, as opposed to the business events in Audit trail. It is user-monitoring — who signed in, what they opened, who they messaged — so it is HR/security-sensitive and stops at the two roles that carry full authority.

| Tab | What it does |
| --- | --- |
| Users | Per-user view of console usage and presence. |
| Activity | The stream of module views and actions, one row per event. |
| Sessions | Sign-in sessions, with device and duration. |

Tabs are defined in `frontend/src/pages/Logs.tsx` (`TABS`).

#### Fixed — the rail and the guard used to disagree about Logs

`activity.view` was widened to `['ACCT', 'ADMIN']` (commit 62451e3, *"Give Accounting the Logs too"*)
and the route guard in `App.tsx` read that permission, but the `NAV` entry in `Shell.tsx` was missed
and still said `roles: ['ADMIN']`. Accounting could open `/logs` by typing the URL and could not see
the link. The rail now matches the guard. Every nav item's `roles` is now consistent with its route's
permission — that is the invariant to check when adding one.

---

## Console (not in the nav rail)

Reached from the user menu in the top-right rather than the rail.

### Settings — `/settings`
**All roles.** Personal preferences — currently the theme (Light / Dark / System).

*No tabs.*

### Account — `/account`
**All roles.** Your own profile, and the only screen on which you can edit it.

*No tabs.* Two stacked cards:

- **Profile** — name, job title, phone, department, avatar colour, and a profile picture uploaded
  straight to R2 the same three-step way a submission document is (presign → PUT → commit). Below the
  form, a read-only block for what an administrator owns: work email, role, employee ID, join date and
  last sign-in.
- **Password** — current + new + confirm. A successful change signs out every *other* device and keeps
  this one, by re-issuing the caller's cookie after the `tokenVersion` bump.

Everything here acts on the session's own user — there is no `:id` and no permission, which is what
makes "may I edit this profile?" unanswerable rather than merely answered correctly. See
`docs/roles-and-permissions.md` → *Self-service*.

---

## Unauthenticated routes

Shown only when signed out, so they carry no nav or tabs.

| Route | Purpose |
| --- | --- |
| `/signup`, `/signup/:code` | Sign up, optionally pre-filled from an invitation code. |
| `/verify` | Enter the OTP emailed at sign-up to verify the address. |
| `/forgot` | Request a password reset link. |
| `/reset` | Set a new password from a reset link. |
| `*` (any other path) | Login. |

---

## Export coverage

The system-wide export is `<ExportMenu dataset="…" />` (`frontend/src/shell/ExportMenu.tsx`) over a
server-side dataset registry (`backend/src/export/`). It gives every screen the same PDF / Excel /
CSV menu, decides rows and columns on the server, and writes a `DATA_EXPORT` activity line for each
download. Adding one to a screen is a dataset file plus one line of JSX.

There is now exactly one export path in the system. Reports used to have its own, built in the
browser (see *History* below).

### Where it is

| Screen | Table | Dataset | Gate |
| --- | --- | --- | --- |
| Submissions | Submissions | `submissions` | rep-scoped in `load` |
| Contacts | Contacts | `contacts` | `contacts.view` **and** rep-scoped |
| QuickBooks | Export ledger | `qbo-ledger` | `quickbooks.export` |
| Designer feedback | All responses | `feedback` | `feedback.view` |
| Internal notes | All internal comments | `internal-comments` | `internal.view` **and** `notAboutMe` |
| Reports | each of the 10 reports | `report-<key>` | `reports.view` |
| Audit trail | Audit trail | `audit` | `reports.view` |
| Administration → Invitations & approvals | Pending approval | `user-approvals` | `admin.manage` |
| Administration → Invitations & approvals | Invitations | `invitations` | `admin.manage` |
| Administration → Users & roles | Users | `users` | `admin.manage` |
| Administration → Packages & pricing | Package rate card | `packages` | `admin.manage` |
| Administration → Packages & pricing | Add-on catalogue | `addons` | `admin.manage` |
| Administration → Tax rates | Tax profiles | `taxes` | `admin.manage` |
| Attendance → My timesheet | The month | `attendance` | scoped in `load` (own sheet, or one you may open) |
| Attendance → Team | Everyone | `attendance-team` | `attendance.viewTeam` |
| Payroll → Payroll run | Everyone | `payroll` | `payroll.viewAll` |
| Logs → Users | Users | `log-users` | `activity.view` |
| Logs → Activity | Activity | `activity` | `activity.view` |
| Logs → Sessions | Sessions | `sessions` | `activity.view` |

### How a dataset is scoped, and why some carry both gates

`load` is expected to return rows already scoped to the caller, so the export can never reveal more
than the screen it sits on. Where that is the whole story — Submissions — no `permission` is needed.

It is not always the whole story, and the two gates answer different questions:

- **`permission` answers "may this ROLE export this at all".** The admin, Logs and Reports datasets
  need it because their `load` returns the same rows to everyone; it is the only thing between a
  signed-in rep and the staff list.
- **`load` answers "WHICH rows".** Contacts needs both: `contacts.view` refuses an INTERN outright
  (the customer book is designer PII and a trainee does not hold it), while the row scope gives a
  rep their own brands. Neither implies the other.
- **Attendance is the cleanest example of the first bullet's opposite.** `attendance` carries no
  `permission` at all, because `load` calls `AttendanceService.list` — the same method the screen
  calls, resolving the same subject through the same check. A file can only ever hold a month the
  caller could have opened. `attendance-team` needs a `permission` precisely because it has no
  subject to scope: it is everybody by definition.
- **Some rules are neither.** `internal-comments` goes through `InternalService.list` so the promise
  that nobody reads the coaching notes about their own sale survives into the file. A manager who
  carries deals passes the permission gate — only `notAboutMe` stops them. `people-exports.spec.ts`
  pins that case specifically.

### Two things the contract does that are easy to miss

**Filters travel with the export.** Audit, Logs → Activity/Sessions, Contacts and Reports filter
server-side, so the menu forwards the screen's filters (`params={{ q, action }}`) and `load`
re-applies them. Without this the file would quietly disagree with the table it was pulled from.
The filters are also recorded on the `DATA_EXPORT` line — the same dataset pulled whole and pulled
down to one contact are not the same event.

**The row ceiling fails loudly.** `MAX_EXPORT_ROWS` (10,000) is a correctness limit, not a
performance one: a truncated export is indistinguishable from a complete one once it is in a
spreadsheet, and that is exactly the file someone reconciles against. Over the line, the download is
refused with a message naming the count and telling the user to narrow the filter, which the menu
shows inline. Datasets that read a large table (`audit`, `activity`, `sessions`) query
`MAX_EXPORT_ROWS + 1` so they can detect the overflow without loading the world.

### Static vs dynamic datasets

Most datasets declare `columns` once, next to the resource. Reports cannot: each report is its own
table, and *Sales by event* and *Sales by city* do not share a first column label — the shape is a
property of the answer, not of the resource. Those datasets omit `columns` and return
`{ rows, columns }` from `load` instead. `ExportDataset` is a union of the two, so a dataset must
declare its columns exactly one way; there is no shape that satisfies both or neither.

### Deliberately not exported

| Screen / tab | Why not |
| --- | --- |
| Dashboard | A slice of Submissions, which exports already. |
| Approval queue (both cards) | Subsets of Submissions by status, and the export carries a Status column. |
| QuickBooks → Ready to export | Same — approved submissions, already covered. |
| Leaderboard | Reports → *Sales representative performance* is the same figures, and exports. |
| Messages | Private staff conversation. A one-click dump of everyone's chat is a different decision from a table export and should not arrive as a side effect of consistency. |
| New submission, Submission detail, Contact detail | One record, not a table. A submission's client-facing artefact is its invoice, which is its own concern. |
| Administration → Settings, Administration → Configuration | Forms, not tables — and Configuration holds secrets. |
| Console → Settings, Account | Personal preferences and your own profile — forms, not tables. Your hours are exportable from Attendance. |
| Payroll → My pay | One statement, not a table. The month it came from exports from *Payroll run*, and the statement itself downloads as a **payslip** (`GET /api/payroll/payslip.pdf`) — a document rather than a dataset, for the reasons under *The payslip* above. |

### Not exported, but not obviously by design

These have no dataset and no stated reason. Recorded here so the absence is visible rather than
assumed to be a decision someone made:

| Screen / tab | Note |
| --- | --- |
| Emails (Sent / Received) | A row-scoped table with filters — structurally the same shape as Logs → Activity, which does export. Whether a mail log *should* be downloadable is a real question (it is closer to Messages than to Contacts), but nobody has answered it in writing. |
| Payroll → Approvals | A queue of submitted invoices. The reconciliation case for exporting it is at least as strong as for *Payroll run*, which exports. |
| Administration → Packages & pricing → Shows | The other two cards on the same tab export (`packages`, `addons`); the Shows card was added later and did not get a dataset. This one looks like an oversight rather than a choice. |

### History — the Reports migration

Reports used to build its CSV/JSON in the browser from data already on screen, with `window.print()`
for PDF. It was replaced because of what that could not do, in rising order of how much it mattered:

1. It offered CSV/JSON where the rest of the console offers PDF/Excel/CSV.
2. Its CSV was hand-rolled and skipped the hardening in `export.service.ts` — the UTF-8 BOM (without
   which Excel mangles é, £, ¥) and the formula-injection guard on cells beginning `=`, `+`, `-`, `@`.
3. **It never reached the server, so no `DATA_EXPORT` line was written.** The one screen that
   produces consolidated revenue was the one screen whose exports left no trace.

The JSON format did not survive the move: the global menu is PDF/Excel/CSV, and Reports was the only
screen that offered JSON. If anything downstream consumed those files, it wants
`GET /api/reports/summary` — the same JSON, from the endpoint the screen itself reads.
