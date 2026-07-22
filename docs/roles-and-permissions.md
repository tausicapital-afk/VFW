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

**Common to everyone:** Dashboard, Submissions, Messages, Leaderboard.

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
  balance. Both are `ACCT`/`ADMIN` today, but only the first is a candidate for
  ever widening — a schedule is a promise, a mark is a receipt.

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
