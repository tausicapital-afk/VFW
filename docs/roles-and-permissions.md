# Roles and permissions

How authorization works in the VFW console: who the roles are, what each may do,
and where the boundary is actually enforced.

## The five roles

There are **five** roles, not four:

| Enum | Label | Seeded demo account |
| --- | --- | --- |
| `SALES` | Sales Representative | 4 (marielle, diego, aiko, priya) |
| `INTERN` | Intern | **none** |
| `ACCT` | Accounting | accounting@vanfashionweek.com |
| `MGR` | Sales Manager | sales.director@vanfashionweek.com |
| `ADMIN` | Administrator | it@vanfashionweek.com |

The count is easy to get wrong, because only four roles have seeded logins — so
only four appear in the demo-credentials table on the sign-in screen. `INTERN` is
real, is offered at signup, and is enforced in the ACL; it simply has no demo
user. This matches the inspiration mockup, which also declares all five
(`vfw-console.html:475`).

Roles are declared in four places that must agree:

- `backend/prisma/schema.prisma` — the `Role` enum (source of truth)
- `backend/src/common/acl.ts` — the permission matrix (**the** security boundary)
- `frontend/src/lib/types.ts` — the `Role` union
- `frontend/src/lib/acl.ts` — a render-only mirror of the matrix

`INTERN` is a **restricted rep**, not a synonym for `SALES`. It drafts and edits
its own submissions and sees the dashboard, leaderboard and messages — but it does
not get the customer book (`contacts.view` / `contacts.create`) or
`feedback.record`. The reasoning: an intern is a supervised trainee, and the CRM
holds designers' direct emails and phone numbers. A trainee can sell without
holding customer PII.

## Modules by role

From the nav in `frontend/src/shell/Shell.tsx`, enforced server-side by
`backend/src/common/acl.ts`.

| Module | Sales | Intern | Accounting | Sales Mgr | Admin |
| --- | :-: | :-: | :-: | :-: | :-: |
| Dashboard | ✓ | ✓ | ✓ | ✓ | ✓ |
| Submissions | ✓ | ✓ | ✓ | ✓ | ✓ |
| Contacts (view) | ✓ | — | ✓ | ✓ | ✓ |
| Contacts (create) | ✓ | — | ✓ | — | ✓ |
| Messages | ✓ | ✓ | ✓ | ✓ | ✓ |
| Attendance (own) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Attendance (team) | — | — | ✓ | ✓ | ✓ |
| Payroll (own) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Payroll (everyone) | — | — | ✓ | — | ✓ |
| Leaderboard | ✓ | ✓ | ✓ | ✓ | ✓ |
| New submission | ✓ | ✓ | — | — | ✓ |
| Approval queue | — | — | ✓ | — | ✓ |
| QuickBooks | — | — | ✓ | — | ✓ |
| Designer feedback | — | — | ✓ | ✓ | ✓ |
| Internal notes | — | — | ✓ | ✓ | ✓ |
| Reports | — | — | ✓ | ✓ | ✓ |
| Audit trail | — | — | ✓ | ✓ | ✓ |
| Administration | — | — | ✓ | — | ✓ |
| Logs | — | — | ✓ | — | ✓ |

**Common to everyone:** Dashboard, Submissions, Messages, Attendance, Payroll,
Leaderboard.

**Payroll is the one place the Sales Manager is *narrower* than Accounting.** MGR
holds `attendance.viewTeam` but not `payroll.viewAll`: a manager reads the team's
hours and their sales numbers, not their salaries. It is the only row in this
table where MGR sees less than the module next to it would suggest, and it is
deliberate — the two questions ("is my team showing up?" and "what does my team
earn?") are not the same question and are not owed to the same person.

**Account is not in the table**, because it has no permission at all. Editing your
own profile, picture and password is reachable by every signed-in user by
construction — see *Self-service: the profile is not an ACL question* below.

**Accounting and Admin are equals.** Both hold every permission, including
Administration (`admin.manage`) and Logs (`activity.view`). Logs is
user-monitoring (who signed in, what they opened, who they messaged), so it is
treated as HR/security-sensitive — but it is shared with Accounting, not
admin-only.

**The Sales Manager is oversight, not operations.** A manager sees everything
(all submissions, Reports, Audit, Feedback, Internal notes) but cannot *create* a
submission, and cannot approve, reject, or export one. Approval and the
QuickBooks hand-off belong to Accounting and Admin.

## Row-level scoping: what a rep can see

Role permissions answer *"which screens?"*. They do not answer *"whose records?"*
That second question is answered by a row-level scope, and it is applied:

```ts
// backend/src/submissions/submissions.service.ts
scopeFor(user) {
  return can('submission.viewAll', user.role) ? {} : { repId: user.id };
}
```

A rep sees only submissions where they are the rep. `ACCT`/`MGR`/`ADMIN` hold
`submission.viewAll` and see everything. Three properties are worth preserving:

1. **There is one definition of "whose deals can I see."** `ContactsService`
   imports `scopeFor()` rather than restating the rule, so contacts and
   submissions cannot drift apart.
2. **Denied reads return 404, not 403.** A rep fetching another rep's submission
   gets the same response as a record that does not exist, so the API cannot be
   used to probe for the existence of other reps' deals.
3. **A rep may only edit their own record.** `update()` re-checks
   `existing.repId !== user.id` independently of the ACL.

Contacts are scoped transitively: a rep sees a brand they have sold to *or*
entered themselves, and viewing a shared brand shows only their own deals for it.

The Leaderboard is deliberately **not** scoped — showing everyone's numbers to
everyone is the point of a leaderboard.

## Payment plans: read is scope, write is permission

A submission's instalment schedule (`installment.plan`, `installment.mark`) is
the clearest example of the split above, so it is worth stating explicitly:

- **Reading a plan carries no permission at all.** `GET
  /api/submissions/:id/installments` is guarded only by the row scope, which it
  gets by going through `SubmissionsService.findOne`. The schedule also rides on
  the submission payload itself. That is deliberate: a rep should be able to see
  whether their designer is up to date without asking Accounting.
- **Writing is split in two**, because the two acts differ in kind.
  `installment.plan` reschedules expectations and moves no money.
  `installment.mark` posts a real `Payment` to the ledger and moves the sale's
  balance. Both are now held by **every role that can work a sale** (`SALES`,
  `INTERN`, `ACCT`, `MGR`, `ADMIN`): a rep arranges the terms with their designer
  and records the money as it lands, instead of routing each step through
  Accounting. Widening *who* may write does not widen *what* a write does — a
  mark still posts a `Payment` and lets the ledger derive the balance, and an
  undo still reverses it with a visible negative entry, so the money story stays
  auditable no matter who touched it. A rep can also seed the schedule at intake,
  straight from the New Submission form.

## Attendance: one permission for yours, another for everyone else's

Attendance splits the same way payment plans do, but along a different seam.

- **`attendance.mark` is held by every role**, and every route on
  `/api/attendance` carries it — including the reads. That is not a mistake: the
  base case of reading a timesheet is reading your own, and an intern who could
  not see their own hours would have no reason to record them.
- **Whose timesheet is not a route-level question.** The subject arrives in the
  request (`?userId=` on a read, `userId` in the body on a write), and every
  handler resolves it through one private method, `AttendanceService.subject()`.
  Your own id always passes; anything else demands `attendance.viewTeam` before
  the row is even looked up, so a rep probing for ids cannot tell an account that
  exists from one that does not.
- **`attendance.viewTeam` is `ACCT`, `MGR`, `ADMIN`** — and it is the one thing on
  the whole matrix that is genuinely about running a team rather than running the
  books. `MGR` holds it while holding no accounting permission at all.
- **A correction is distinguishable from a claim.** `updatedById` records whoever
  last wrote the row; when that is not the subject, the API returns it as
  `correctedBy` and the screen names them. A write to somebody else's sheet also
  appends to `AuditEntry` (`ATTENDANCE_CORRECTED`) — a self-report does not,
  because the trail is for changes the person it describes did not make.
- **The export inherits all of this for free.** `attendance.dataset.ts` loads
  through the same service rather than the database, so a file can never contain
  a month the caller could not have opened. Only the team roll-up carries a
  dataset `permission`, because it has no subject to scope.

## Payroll: derived, never stored

Payroll holds no table of its own. A month is computed on every read from three
sources that each move independently:

| Source | Contributes | Where it comes from |
| --- | --- | --- |
| `User.payType` + `User.baseRate` | base pay | Administration → Users & roles |
| `User.earnsCommission` | whether there is commission at all | Administration → Users & roles |
| `AttendanceEntry.hours` | the multiplier, for HOURLY only | the Attendance module |
| `Submission.commissionAmount` | commission | struck at sale creation, at 0% if the rep is not on commission |

Four rules make the number defensible:

1. **Commission is earned on approval**, and a sale counts in the month of its
   `approvedAt`. That matches Reports → *Sales representative performance*, so the
   two screens cannot disagree about what a rep earned. Note this is a *different*
   date from the one the reports filter on — they date a sale by `submittedAt`,
   because they answer how the pipeline is moving, and a sale submitted in March
   and approved in April belongs to March's activity but to April's pay.
2. **The cost of rule 1 is stated, not hidden.** `commissionUnpaid` reports how
   much of the month's commission sits against invoices the client has not
   settled, and the screen shows it beside the total.
3. **A salary does not move with the timesheet.** Only `HOURLY` multiplies by
   hours; making a salary do so would turn every unrecorded day into a pay cut for
   someone who is not paid by the hour. Hours still appear on a salaried
   statement — they are just not what the pay is derived from.
4. **A missing FX rate throws.** Commission is stored in the sale's currency and
   consolidated to CAD through `Settings.fxRates` — the same table Reports uses.
   Defaulting a missing rate to 1 would value a JPY sale as though yen were
   dollars, overstate somebody's commission by two orders of magnitude, and look
   entirely plausible on screen.

Because nothing is stored, correcting a timesheet or amending a sale is reflected
the next time the month is opened. **This is a view of a period, not an approved
run** — the moment payroll needs to be signed off and frozen, it becomes a table
with its own lifecycle. The screen says so rather than implying otherwise.

## Editing a sale, and its invoice number

Both of these changed hands at approval, and they changed hands the same way.

**The invoice number** (`PUT /api/submissions/:id/invoice-no`) carries no `@Can()`
at all, on purpose: who may set it depends on the sale's *status*, not only on the
caller's role, and a route-level grant can only see the role.

- Before approval — draft, pending, returned — it is whoever may edit the sale.
  The number is not yet on a document anyone has seen, so it is data entry.
- After approval — approved, exported — it is `invoice.generate` only, so
  Accounting and Admin. By then it is on a PDF that may be in a client's inbox and
  in their ledger.
- Rejected or voided is refused outright: numbering a sale that is not billed puts
  a gap in the sequence for nothing.

Two supporting details are load-bearing. `Submission.invoiceNo` is now **unique** —
while the only way to get a number was a row-locked increment, uniqueness was a
property of how it was produced; once a person can type one, the database has to
be the thing that says no. And a hand-typed number that matches one of the two
prefixes **pushes that sequence past itself**, so a later automatic allocation
cannot collide. A gap in the sequence is a question; a duplicate is a liability.

**The sale itself** (`PUT /api/submissions/:id`) follows the same seam:

| Status | Who may edit | What happens |
| --- | --- | --- |
| `DRAFT`, `RETURNED` | owner, or `submission.editAny` | re-priced, sent to `PENDING`, `submittedAt` re-stamped |
| `PENDING` | owner, or `submission.editAny` | re-priced, **stays** pending, `submittedAt` **kept** |
| `APPROVED`, `EXPORTED` | `submission.editAny` only | re-priced, **keeps its approval**, audited as `AMENDED` |
| `REJECTED`, `VOIDED` | nobody | return or unvoid it first |

The `submittedAt` rule in row two is the subtle one: the approval queue is ordered
by that column, so re-stamping it would send a rep to the back of the line for
fixing their own typo — and hand anyone who noticed a way to jump the queue by
editing something trivial.

Amending an `EXPORTED` sale is allowed but genuinely lossy: those figures are
already in QuickBooks and this system cannot reach in and change them. The audit
entry names the QuickBooks document and says it must be re-synced by hand, and the
edit screen warns before you save.

## Self-service: the profile is not an ACL question

`/api/profile` has **no `@Can()` on any route and no `:id` on any route**. Every
handler acts on `@CurrentUser()`, so "may I edit this profile?" is not a question
the code can ask, let alone answer wrongly. That is the whole authorization story
for name, phone, department, job title, avatar colour, profile picture and
password.

Two consequences worth stating:

- **What is absent from `UpdateProfileDto` is the security boundary.** `role`,
  `status`, `commissionPct` and `target` are grants other people make about you;
  `email` is the login identity and where every one-time code is sent. The global
  pipe runs `forbidNonWhitelisted`, so posting any of them to the profile form is
  a 400 rather than a silent no-op — a rep cannot raise their own commission
  through the screen that changes their phone number. Changing another account
  stays in `AdminService` behind `admin.manage`.
- **Changing your own password bumps `tokenVersion`**, exactly as a reset does, and
  the controller re-issues the caller's cookie from the token minted *after* the
  bump. Every other browser is signed out; the one doing the changing is not.
- **An avatar key is checked against `avatars/<yourId>/` on commit.** Without that
  check the endpoint would be a general-purpose read of the shared bucket: the API
  signs a download for whatever key an account names, so "set my avatar to
  `submissions/<id>/contract.pdf`" would hand back a signed link to someone else's
  contract.

## Where the boundary actually is

**The server is the boundary. The frontend ACL is cosmetic.** `frontend/src/lib/acl.ts`
exists only to decide what to *render* — hiding a button the user cannot use. Every
permission is re-checked server-side by the global `AuthGuard`, which verifies the
session cookie and then the route's `@Can(...)` permission. An endpoint is locked
down unless explicitly marked `@Public()`.

If the two copies ever disagree, **the server wins**. Never "fix" a permissions bug
by editing the frontend copy alone.

The matrix is covered by `backend/src/submissions/acl.spec.ts`, which drives real
HTTP requests through the real guard — one case per role per guarded endpoint,
plus the named negatives (no session → 401, rep A reading rep B's record → 404).

## Sessions are revocable

A session JWT is a claim about who signed in, **not a standing grant**. The token
lives 30 days, so trusting its `role` field would mean a demoted admin stays an
admin for a month and a disabled account keeps working for a month. Instead
`verifySession()` re-reads the user on every request (HTTP and the WebSocket
handshake alike) and:

- refuses anyone whose status is not `ACTIVE` — disabled, rejected, deleted, or
  still awaiting email verification;
- refuses a token whose `tv` claim has fallen behind `User.tokenVersion`;
- takes `role` from the **database row**, not the token, so a role change applies
  on the very next request.

`tokenVersion` is the "sign out everywhere" lever. A password reset bumps it, so a
stolen session cookie dies with the password that leaked it — otherwise a reset
only locks a door the intruder is already through.

The cost is one indexed primary-key lookup per request. That is the price of being
able to revoke, and it is worth paying.

## Hardening notes

Things that look like details but are load-bearing:

- **Submission refs are allocated, not counted.** `nextRef()` increments
  `Settings.nextSubmissionSeq` inside the creating transaction, which takes a row
  lock — the same pattern as `allocateInvoice()`. Deriving the ref from
  `submission.count()` would read the same count in two concurrent creates and
  hand both the same ref, which `ref @unique` then rejects. The seed re-derives
  the high-water mark from existing refs, because a database stood up with
  `prisma db push` (the test harness, a scratch dev box) never runs the migration
  that backfills it.
- **The contact write path is scoped like the read path.** Submitting against a
  brand links to its existing contact but does **not** overwrite the contact's
  details unless the caller is allowed to see it. Without that check, `upsert` on
  a unique brand is a blind cross-rep write: any rep could replace the email and
  phone of a customer they cannot read, just by guessing the brand name.
- **`submission.editAny` is real.** ACCT/ADMIN may edit anyone's submission, which
  is what lets Accounting correct a rep's mistake instead of bouncing it back.
  Crucially, an edit prices the sale against the rep who **owns** it, not whoever
  is editing — pricing it against the editor would recompute the deal at
  Accounting's 0% commission and quietly zero the rep's commission.
