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
**ACCT, MGR, ADMIN.** Runs a chosen report over a chosen period and exports the table as CSV, JSON, or print/PDF.

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
