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
  // `mark` posts a real Payment to the ledger. Both are Accounting's today, but
  // only one of them is a candidate for ever widening.
  'installment.plan': ['ACCT', 'ADMIN'],
  'installment.mark': ['ACCT', 'ADMIN'],
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
