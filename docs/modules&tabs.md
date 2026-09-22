# Modules & Tabs

Every screen in the VFW Console, grouped the way the left navigation rail groups them, with the role that can reach it and the tabs it contains.

Source of truth: `frontend/src/shell/Shell.tsx` (the `NAV` array) and `frontend/src/App.tsx` (the route table). Six modules use tabs — Administration, Logs, Attendance, Payroll, Emails, and Reports (as a report picker). Everything else is a single screen.

Roles: **SALES** (Sales Representative), **INTERN**, **ACCT** (Accounting), **MGR** (Sales Manager), **ADMIN** (Administrator).

**Global search** (Cmd/Ctrl-K, or the ⌕ icon in the rail) is not a screen — it's a command palette
mounted once in `Shell.tsx` and reachable from every authenticated page. `GET /api/search?q=` covers
Submissions and Contacts (not yet Emails — it has no per-record route to deep-link to). Every result
goes through the same scoped service method its owning screen already uses, so a result can never
point at something the signed-in user couldn't already open directly.

---

## Work

### Dashboard — `/`
**All roles.** The landing screen: accounting and admins see what is awaiting approval, everyone else sees their own submissions.

*No tabs.* Below the KPI strip: a revenue trend, a submission-status breakdown, and a top-packages
chart, all derived client-side from data the screen already fetches — no separate chart endpoint, and
the row-scoping is inherited for free from the already-scoped submissions list.

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

Each row also opens a read-only **quick look** — a modal summary of the sale (parties, show,
package, pricing, balance) that costs no navigation and no way back. It is deliberately read-only:
everything that changes a sale lives on the detail page. The list payload already carries everything
the modal shows, so opening one costs no second request.

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
- **Documents card** — files attached to the sale (contracts, artwork, and the like), uploaded
  straight to R2 the same three-step way an Account profile picture is (presign → PUT → commit), so
  the upload never passes through our own API.

### Contacts — `/contacts`
**SALES, ACCT, MGR, ADMIN.** Searchable directory of client contacts and brands, opening into a per-contact history (`/contacts/:id`).

*No tabs.* An **Import CSV** button (gated by the same permission as "+ New contact") bulk-creates
contacts by looping the real single-row create call — a bad row reports its file row number and the
exact error the single-create path would have produced, and good rows still land.

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

Two scheduled jobs also write here (`backend/src/emails/reminders.service.ts`): a daily overdue-payment
reminder to the contact, and a weekly renewal nudge to the *rep* — not the contact, deliberately, since
nothing in this system auto-emails a past customer without a person deciding to. Both reuse the same
receivables/retention data Reports shows, so a reminder can never disagree with what the Reports screen
says.

### Approval queue — `/queue`
**SALES, ACCT, ADMIN** (`submission.queueView`). Submissions waiting on accounting sign-off, where they
get approved or returned to sales; carries an unread badge showing queue depth.

*No tabs.* Two stacked cards: **Pending accounting approval** and **Returned to sales**.

A row pending past 3 calendar days carries an amber SLA pill instead of a plain submitted-date note
(`APPROVAL_SLA_DAYS` in `frontend/src/pages/Queue.tsx` — a flat constant, not a Settings field, for now).

**Reading the queue is not deciding on it.** SALES holds `queueView` so a rep can see where their own
submission sits, and the read is row-scoped like every other submission read. Acting on one stays with
`submission.approve` / `.reject` / `.return` (ACCT, ADMIN) — the maker and the checker must not be the
same person.

Two things the queue does beyond approve/return:

- **Custom-package sign-off.** A row whose sale was customized (see *New submission*) shows a
  **Custom package** pill, and the approve dialog will not submit until the approver ticks an explicit
  acknowledgement that they are approving a non-catalogue package *as priced*. Approving blind is the
  failure this prevents.
- **Second sign-off on a deep discount.** A row discounted past `Settings.discountApprovalPct` cannot
  be approved by one person alone. The first `submission.approve` call records who's asking and leaves
  the sale `PENDING`, showing "Awaiting 2nd sign-off — requested by X"; a *different* ACCT/ADMIN's
  approve call is what actually moves it to `APPROVED`. The requester never sees an Approve button on
  their own request — the same maker/checker split as Payroll submit/approve, enforced both in the UI
  and (the real guarantee) server-side: the same user trying to confirm their own request is refused.
- **Direct Edit shortcut** on a row, so a returned sale can be corrected without opening it first.

### QuickBooks — `/qbo`
**ACCT, ADMIN.** Exports approved submissions to QuickBooks and keeps the ledger of what has already gone across.

*No tabs.* A connection banner up top — the connected company name and environment, or a prompt to
connect one under Administration → Configuration — then two stacked cards: **Ready to export** and
**Export ledger**. Without a connected company, exporting still allocates an invoice number and moves
the sale `APPROVED` → `EXPORTED` exactly as before; nothing is posted to QuickBooks until a company
is connected, and connecting one makes the same button start posting for real. Full mechanics in
`docs/quickbooks-integration.md`.

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
**All roles for your own pay; `ACCT` and `ADMIN` for everyone's.** What each person earned over a
period, and the arithmetic it came from.

| Tab | Who | What |
| --- | --- | --- |
| My pay | all roles | Your own statement: base, commission, gross — beside your full profile, the hours and sales it was derived from, and your lifetime earnings. Also where you submit the period for approval, and where you download it as a **payslip**. |
| Payroll run | `payroll.viewAll` (ACCT, ADMIN) | Every active account for the period, with run totals, and a row that opens into that person's statement. |
| Approvals | `payroll.approve` (ACCT, ADMIN) | The queue of submitted payroll invoices — edit the figures, then approve or reject. |
| Commission tiers | `payroll.manageTiers` (ACCT, ADMIN) | The global tier table — a revenue threshold and a bonus %, applied progressively on top of the flat per-sale commission every rep already earns. Seeded with a placeholder pending real numbers. |

A rep with neither `payroll.viewAll` nor `payroll.approve` sees no tab bar at all, just their own statement.

**Tier bonus is additive, never a rewrite.** `gross = base + commission + tierBonus`. The per-sale
commission stamped on each `Submission` at creation is never touched by the tier table — only the
aggregate bonus, computed once per period from the rep's total commission-eligible revenue, moves. A
rep who never crosses a threshold sees no tier-bonus line at all, not a $0.00 one. Once a payroll
invoice is submitted, its `tierBonus` freezes exactly like base and commission already did — editing
the tier table afterward never moves a figure already submitted for approval.

**The period defaults to a calendar month but is not limited to one.** The picker steps month by
month, or drops into a custom `from`/`to` range typed in directly — a genuinely custom range spells
out both ends (`Aug 1 – Aug 15, 2026`) rather than pretending to be a month. `frontend/src/lib/period.ts`
holds the shared logic, and the payslip endpoint mirrors the same labelling rule so a downloaded
payslip never describes its period differently from the screen it came from.

**Sales this period**, embedded under the statement on *My pay*, lists every sale behind the
commission line and who it was sold to, for whatever period is on screen. It is the same component
and the same endpoint that Administration → Users & roles uses under a person's detail, so the two
screens can never disagree about the same person's money for the same period.

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

A **saved views** dropdown lets you name and reapply a report type + period combination —
browser-local only (`frontend/src/lib/savedFilters.ts`), no backend model, so it doesn't follow you to
another device. A saved view pointing at a since-removed report type is shown disabled rather than
applied silently.

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
| Users & roles | Lists staff accounts and changes each one's role, pay basis (pay type plus whether they earn commission) and rates. Opening a user also shows their **Sales this period** — the same panel Payroll → My pay uses. |
| Packages & pricing | Three cards: **Shows**, the package catalogue, and the add-on catalogue. New rows are created from the button on each card, or bulk-created via **Import CSV** (same underlying create call, per-row error reporting, no schema bypassed); package and show ids are derived from the brand (and city/season), and stay fixed once created because that is what submissions point at. |
| Tax rates | Adds to and maintains the tax rates applied at pricing time. New profiles are created from the button on the card; the code is typed, not derived, because it is the key packages and cities point at. |
| Settings | Discount approval threshold, invoice prefix and next invoice number (read-only, allocated transactionally), and the FX rates every report converts through — editing them appends to a rate history rather than overwriting it, so a report for an old period keeps using the rate that was actually in force then, not whatever's live today. |
| Configuration | Edits runtime config straight to the database — no redeploy — for values that aren't needed before the database is reachable. Passwords and secrets stay in env. Also where QuickBooks itself is connected: OAuth connect/disconnect, and a mapping card pointing VFW tax profiles, GL accounts and departments at their QuickBooks counterparts. See `docs/quickbooks-integration.md`. |

Tabs are defined in `frontend/src/pages/Admin.tsx` (`TABS`); the Configuration tab lives in `frontend/src/pages/AdminConfig.tsx`.

Every catalogue write is additive and never reaches a sale that has already been priced — a submission copies its prices and its tax rate onto the record at submission time. `backend/src/admin/catalogue-create.spec.ts` and `catalog.spec.ts` hold that line.

**Shows** (the `Event` table) follow the same rule: adding one makes it selectable on the new-submission
form and changes nothing already sold. The card exists because seasons used to be a deploy-time
concern — the Summer/Spring filter on the submission form rendered an empty list purely because no SS
shows had been seeded, which is a content problem wearing a bug's clothes.

#### `listValue` and `cap` are editable

`Package.listValue` (the revenue forgone on a sponsored package, which reporting shows) and
`Package.cap` (a per-event limit — VKFW VIP has only 2) are optional fields on both the new-package
and edit-package modals, alongside price, tax code and GL account. Both are wired together
deliberately — adding one to only one modal would leave the tab able to create a package it could not
then edit. A sponsored or capped package no longer has to be seeded or written directly to the
database.

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
| Administration → Packages & pricing | Shows | `shows` | `admin.manage` |
| Administration → Tax rates | Tax profiles | `taxes` | `admin.manage` |
| Attendance → My timesheet | The month | `attendance` | scoped in `load` (own sheet, or one you may open) |
| Attendance → Team | Everyone | `attendance-team` | `attendance.viewTeam` |
| Payroll → Payroll run | Everyone | `payroll` | `payroll.viewAll` |
| Payroll → Approvals | Submitted invoices | `payroll-approvals` | `payroll.approve` |
| Emails → Sent | Outbound mail | `emails-sent` | scoped in `load` (own sends, or all with `email.viewAll`) |
| Emails → Received | Inbound mail | `emails-received` | scoped in `load` (own sends, or all with `email.viewAll`) |
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
