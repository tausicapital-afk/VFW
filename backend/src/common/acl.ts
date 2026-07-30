import { Role } from '@prisma/client';

/**
 * The permission matrix, originally ported from vfw-console.html (line 481) and
 * since tightened where the mockup was silent:
 *
 * - `contacts.view` / `contacts.create` are ours. The mockup left contact
 *   endpoints ungoverned, which meant any signed-in user could hand-enter a
 *   customer, and an INTERN had the full CRM.
 * - INTERN is no longer a synonym for SALES. It keeps submissions, the
 *   dashboard, the leaderboard and messaging, but not the customer book and not
 *   feedback — a trainee who can draft a sale without holding designer PII.
 *
 * This is the single source of truth for authorization. The frontend has a copy
 * for deciding what to *render*; this copy decides what is *allowed*. Never
 * trust the frontend's answer.
 */
export const ACL = {
  'submission.create': ['SALES', 'INTERN', 'ACCT', 'MGR', 'ADMIN'],
  'submission.editOwn': ['SALES', 'INTERN', 'ACCT', 'MGR', 'ADMIN'],
  'submission.editAny': ['ACCT', 'ADMIN'],
  'submission.viewAll': ['ACCT', 'MGR', 'ADMIN'],
  // Reading the queue is not deciding on it. SALES holds this so a rep can see
  // where their own submission sits in the review pipeline; the queue read is
  // row-scoped like every other submission read, so a rep sees their rows only.
  // Acting on a submission stays with the approve/reject/return trio below —
  // the maker and the checker must not be the same person.
  'submission.queueView': ['SALES', 'ACCT', 'ADMIN'],
  'submission.approve': ['ACCT', 'ADMIN'],
  'submission.reject': ['ACCT', 'ADMIN'],
  'submission.return': ['ACCT', 'ADMIN'],
  // Void is a soft delete: it hides a sale from lists and reports but keeps it
  // for audit and can be reversed. Held by the same two roles that carry the
  // rest of the accounting authority, so "delete from the system" is theirs.
  'submission.void': ['ACCT', 'ADMIN'],
  'accounting.fields': ['ACCT', 'ADMIN'],
  'quickbooks.export': ['ACCT', 'ADMIN'],
  'invoice.generate': ['ACCT', 'ADMIN'],
  // Payment plans. Reading one carries no permission of its own: the plan rides
  // on the submission payload, so whoever may see the sale sees how it is being
  // paid — which is the point, a rep should not have to ask Accounting whether
  // their designer is up to date. Writing is split in two because the two acts
  // differ in kind: `plan` reschedules expectations and moves no money, while
  // `mark` posts a real Payment to the ledger. Both are now open to every role
  // that can work a sale — a rep arranges the terms with their designer and
  // records the money as it lands, rather than routing each step through
  // Accounting. The ledger stays the source of truth either way: a mark posts a
  // Payment and the balance follows, and an undo reverses it with a visible
  // negative entry, so widening who may write does not widen what a write can
  // quietly do.
  'installment.plan': ['SALES', 'INTERN', 'ACCT', 'MGR', 'ADMIN'],
  'installment.mark': ['SALES', 'INTERN', 'ACCT', 'MGR', 'ADMIN'],
  'reports.view': ['ACCT', 'MGR', 'ADMIN'],
  'leaderboard.view': ['SALES', 'INTERN', 'ACCT', 'MGR', 'ADMIN'],
  // The customer book is PII — designers' direct emails and phone numbers. An
  // intern is a supervised trainee who drafts sales; they do not get the CRM.
  'contacts.view': ['SALES', 'ACCT', 'MGR', 'ADMIN'],
  // Hand-entering a customer is an intake job. It mirrors submission.create
  // (plus Accounting) — a manager who cannot create a submission has no reason
  // to create a contact either.
  'contacts.create': ['SALES', 'ACCT', 'ADMIN'],
  'feedback.view': ['MGR', 'ADMIN', 'ACCT'],
  'feedback.record': ['MGR', 'ADMIN', 'ACCT', 'SALES'],
  'internal.comment': ['ACCT', 'MGR', 'ADMIN'],
  'internal.view': ['ACCT', 'MGR', 'ADMIN'],
  'messaging.use': ['SALES', 'INTERN', 'ACCT', 'MGR', 'ADMIN'],
  // The Emails module. Reading is split like submissions: everyone may open the
  // module (viewOwn), but the list is row-scoped — a rep sees only mail they
  // triggered, while viewAll roles see the whole log. Sending an invoice is an
  // accounting action, held by the same roles that can generate one.
  'email.viewOwn': ['SALES', 'INTERN', 'ACCT', 'MGR', 'ADMIN'],
  'email.viewAll': ['ACCT', 'MGR', 'ADMIN'],
  'email.send': ['ACCT', 'ADMIN'],
  // Administration is user and role management: create an account, disable one,
  // change anyone's role. ACCT holds it as a second keyholder so account
  // recovery does not depend on a single admin being reachable. Note the
  // consequence — a role that can edit roles can raise its own to ADMIN, so
  // this grant is effectively a grant of everything below it.
  'admin.manage': ['ACCT', 'ADMIN'],
  // Attendance. Everyone marks their own days — an intern has a timesheet for
  // the same reason a manager does — and the write path has no user parameter,
  // so `mark` is only ever a claim about yourself.
  'attendance.mark': ['SALES', 'INTERN', 'ACCT', 'MGR', 'ADMIN'],
  // Reading, and correcting, someone else's timesheet. This is the supervisory
  // half and is why it is a separate grant: a timesheet is how hours are
  // approved and, eventually, paid, so seeing everyone's is a management act.
  // MGR holds it where MGR holds no accounting permission at all — this is the
  // one thing on this list that is genuinely about running a team rather than
  // running the books.
  'attendance.viewTeam': ['ACCT', 'MGR', 'ADMIN'],
  // Payroll. Split like attendance, and for a sharper version of the same
  // reason: what you are paid is yours to see, and what everyone else is paid is
  // not. `viewOwn` is every role — a rep opens it to check their commission
  // against the sales they closed, which is the whole point of tying the two
  // together — and it can only ever resolve to the caller. `viewAll` is the pay
  // of the entire company, including the people who hold it, so it stops at
  // Accounting and Admin. Note MGR is NOT here: a sales manager reads the team's
  // hours and their numbers, not their salaries.
  'payroll.viewOwn': ['SALES', 'INTERN', 'ACCT', 'MGR', 'ADMIN'],
  'payroll.viewAll': ['ACCT', 'ADMIN'],
  // Submitting your monthly figure for approval. Mirrors payroll.viewOwn — the
  // same "yours to see" reasoning applies to "yours to submit" — and, like
  // viewOwn, can only ever resolve to the caller.
  'payroll.submit': ['SALES', 'INTERN', 'ACCT', 'MGR', 'ADMIN'],
  // Reviewing everyone's submitted invoices: editing figures before sign-off,
  // approving, rejecting. Mirrors submission.approve — the maker (submit) and
  // the checker (approve) must not be the same permission.
  'payroll.approve': ['ACCT', 'ADMIN'],
  // The activity/logs screen is user-monitoring — who signed in, what they
  // opened, who they messaged. HR/security-sensitive, and long held by ADMIN
  // alone; ACCT now holds it too, so Accounting and Admin carry an identical,
  // full set of permissions.
  'activity.view': ['ACCT', 'ADMIN'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof ACL;

export function can(permission: Permission, role: Role): boolean {
  return (ACL[permission] as readonly string[]).includes(role);
}
