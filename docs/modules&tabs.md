# Modules & Tabs

Every screen in the VFW Console, grouped the way the left navigation rail groups them, with the role that can reach it and the tabs it contains.

Source of truth: `frontend/src/shell/Shell.tsx` (the `NAV` array) and `frontend/src/App.tsx` (the route table). Only three modules use tabs — Administration, Logs, and Reports (as a report picker). Everything else is a single screen.

Roles: **SALES** (Sales Representative), **INTERN**, **ACCT** (Accounting), **MGR** (Sales Manager), **ADMIN** (Administrator).

---

## Work

### Dashboard — `/`
**All roles.** The landing screen: accounting and admins see what is awaiting approval, everyone else sees their own submissions.

*No tabs.*

### New submission — `/new`
**SALES, INTERN, ADMIN.** The form for creating a new submission — contact, event, package, add-ons, and pricing.

*No tabs.*

### Submissions — `/submissions`
**All roles.** The list of all submissions you are allowed to see, opening into a detail view (`/submissions/:id`) and an edit view (`/submissions/:id/edit`).

*No tabs.*

### Contacts — `/contacts`
**SALES, ACCT, MGR, ADMIN.** Searchable directory of client contacts and brands, opening into a per-contact history (`/contacts/:id`).

*No tabs.*

### Messages — `/messages`
**All roles.** Real-time internal chat between staff, with a live unread badge on the nav rail.

*No tabs.* The screen is a conversation list beside the open thread, not tabbed.

### Approval queue — `/queue`
**ACCT, ADMIN.** Submissions waiting on accounting sign-off, where they get approved or returned to sales; carries an unread badge showing queue depth.

*No tabs.* Two stacked cards: **Pending accounting approval** and **Returned to sales**.

### QuickBooks — `/qbo`
**ACCT, ADMIN.** Exports approved submissions to QuickBooks and keeps the ledger of what has already gone across.

*No tabs.* Two stacked cards: **Ready to export** and **Export ledger**.

---

## People

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
**ADMIN only.** The control panel for who gets in, what things cost, and how the system behaves.

| Tab | What it does |
| --- | --- |
| Invitations & approvals | Issues invitation codes with a fixed role, revokes them, and reviews sign-ups pending approval. |
| Users & roles | Lists staff accounts and changes each one's role. |
| Packages & pricing | Adds to and maintains the package catalogue and its add-ons and prices. New packages and add-ons are created from the button on each card; the id is derived from the brand and the name. |
| Tax rates | Adds to and maintains the tax rates applied at pricing time. New profiles are created from the button on the card; the code is typed, not derived, because it is the key packages and cities point at. |
| Settings | Discount approval threshold, invoice prefix and next invoice number (read-only, allocated transactionally), and the FX rates every report converts through. |
| Configuration | Edits runtime config straight to the database — no redeploy — for values that aren't needed before the database is reachable. Passwords and secrets stay in env. |

Tabs are defined in `frontend/src/pages/Admin.tsx` (`TABS`); the Configuration tab lives in `frontend/src/pages/AdminConfig.tsx`.

Every catalogue write is additive and never reaches a sale that has already been priced — a submission copies its prices and its tax rate onto the record at submission time. `backend/src/admin/catalogue-create.spec.ts` and `catalog.spec.ts` hold that line.

#### Known gap — `listValue` and `cap` are not editable

`Package.listValue` (the revenue forgone on a sponsored package, which reporting shows) and `Package.cap` (a per-event limit — VKFW VIP has only 2) exist in the schema and are set by the seed, but no admin screen touches either. Neither the new-package modal nor the edit modal can set them, so a sponsored or capped package cannot currently be created from the console — it has to be seeded or written directly. Wiring them up means adding them to both modals together; adding them to only one would leave the tab able to create a package it cannot then edit.

### Logs — `/logs`
**ADMIN only.** Telemetry on how the console itself is being used, as opposed to the business events in Audit trail.

| Tab | What it does |
| --- | --- |
| Users | Per-user view of console usage and presence. |
| Activity | The stream of module views and actions, one row per event. |
| Sessions | Sign-in sessions, with device and duration. |

Tabs are defined in `frontend/src/pages/Logs.tsx` (`TABS`).

---

## Console (not in the nav rail)

Reached from the user menu in the top-right rather than the rail.

### Settings — `/settings`
**All roles.** Personal preferences — currently the theme (Light / Dark / System).

*No tabs.*

### Account — `/account`
**All roles.** Your own profile details.

*No tabs.*

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
| Console → Settings, Account | Personal preferences and your own profile. |

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
