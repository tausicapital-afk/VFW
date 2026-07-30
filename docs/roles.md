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

> **`INTERN` is a restricted rep, not a synonym for `SALES`.** It drafts sales,
> and keeps the dashboard, leaderboard and messaging. It does **not** get the
> customer book (`contacts.view`/`contacts.create` — designer PII), designer
> feedback, or the approval queue. A trainee can draft a sale without holding a
> designer's direct line.

## Modules by role

From the nav in `frontend/src/shell/Shell.tsx`, enforced server-side by
`backend/src/common/acl.ts`.

| Module | Sales | Intern | Accounting | Sales Mgr | Admin |
| --- | :-: | :-: | :-: | :-: | :-: |
| Dashboard | ✓ | ✓ | ✓ | ✓ | ✓ |
| Submissions | ✓ | ✓ | ✓ | ✓ | ✓ |
| Contacts | ✓ | — | ✓ | ✓ | ✓ |
| Messages | ✓ | ✓ | ✓ | ✓ | ✓ |
| Leaderboard | ✓ | ✓ | ✓ | ✓ | ✓ |
| New submission | ✓ | ✓ | ✓ | ✓ | ✓ |
| Approval queue | ✓ | — | ✓ | — | ✓ |
| QuickBooks | — | — | ✓ | — | ✓ |
| Designer feedback | — | — | ✓ | ✓ | ✓ |
| Internal notes | — | — | ✓ | ✓ | ✓ |
| Reports | — | — | ✓ | ✓ | ✓ |
| Audit trail | — | — | ✓ | ✓ | ✓ |
| Administration | — | — | ✓ | — | ✓ |
| Logs | — | — | — | — | ✓ |

**Common to everyone:** Dashboard, Submissions, Messages, Leaderboard, and now
New submission — every role may file a sale. Contacts is everyone but `INTERN`.

**Reading the approval queue is not deciding on it.** A rep opens the queue to
see where their own submission sits; the buttons are not there, and the server
holds `submission.approve`/`reject`/`return` to Accounting and Admin regardless
of what the page renders. The rep's view is row-scoped like every other
submission read (see below), so a rep sees their own pending rows and no one
else's. **The maker must not be the checker:** if approve is ever widened to
`SALES`, a rep can approve their own deal straight through to QuickBooks, and
nothing else in the system would stop it.

**Administration is Accounting and Admin.** `admin.manage` has a second
keyholder so that account recovery does not depend on one admin being reachable.
Be clear about the size of that grant: Administration *is* role management, so
`ACCT` can raise its own role to `ADMIN` and thereby reach everything below —
including the Logs it does not otherwise hold. It is a trust decision, not a
partial one, and it is not enforceable as anything narrower without splitting
the permission.

**Accounting and Admin hold an identical, full set of permissions.** Everything
`ADMIN` can do, `ACCT` can do — including `activity.view` (the Logs). Logs is
user-monitoring (who signed in, what they opened, who they messaged), so it is
treated as HR/security-sensitive, but it is shared between the two keyholder
roles rather than reserved to `ADMIN`.

**The Sales Manager is oversight, plus intake.** A manager sees everything (all
submissions, Reports, Audit, Feedback, Internal notes) and may now create a
submission, but still cannot approve, reject, or export one. Approval and the
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

## Known gaps

Tracked here so they are not mistaken for design decisions. See the hardening
review for detail.

- **Sessions do not revoke.** The JWT carries `role` and lives for 30 days; the
  guard trusts the token without re-reading the user. Disabling an account or
  demoting an admin does not take effect until the token expires.
- **`submission.editAny` is declared but enforced nowhere.** A dead permission
  that reads like a capability Accounting has, and does not.
- **`ACCT` can promote itself to `ADMIN`** via Administration. Now that
  Accounting also holds `activity.view` directly, this no longer changes what it
  can read — the two roles hold the same permissions either way.
- **Contact details are writable outside the read scope.** Submitting for an
  existing brand upserts the contact, so a rep can overwrite the details of a
  contact they are not allowed to read.
