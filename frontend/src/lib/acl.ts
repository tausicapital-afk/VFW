import type { Role } from './types';

/**
 * A mirror of the server's matrix (backend/src/common/acl.ts). This copy exists
 * only to decide what to *show* — hiding a button the user cannot use. It is
 * not a security boundary: the server re-checks every one of these, and an API
 * call made without permission fails there regardless of what this file says.
 * If the two ever disagree, the server wins.
 */
export const ACL = {
  'submission.create': ['SALES', 'INTERN', 'ACCT', 'MGR', 'ADMIN'],
  'submission.editOwn': ['SALES', 'INTERN', 'ACCT', 'MGR', 'ADMIN'],
  'submission.editAny': ['ACCT', 'ADMIN'],
  'submission.viewAll': ['ACCT', 'MGR', 'ADMIN'],
  'submission.queueView': ['SALES', 'ACCT', 'ADMIN'],
  'submission.approve': ['ACCT', 'ADMIN'],
  'submission.reject': ['ACCT', 'ADMIN'],
  'submission.return': ['ACCT', 'ADMIN'],
  'accounting.fields': ['ACCT', 'ADMIN'],
  'quickbooks.export': ['ACCT', 'ADMIN'],
  'invoice.generate': ['ACCT', 'ADMIN'],
  'reports.view': ['ACCT', 'MGR', 'ADMIN'],
  'leaderboard.view': ['SALES', 'INTERN', 'ACCT', 'MGR', 'ADMIN'],
  'contacts.view': ['SALES', 'ACCT', 'MGR', 'ADMIN'],
  'contacts.create': ['SALES', 'ACCT', 'ADMIN'],
  'feedback.view': ['MGR', 'ADMIN', 'ACCT'],
  'feedback.record': ['MGR', 'ADMIN', 'ACCT', 'SALES'],
  'internal.comment': ['ACCT', 'MGR', 'ADMIN'],
  'internal.view': ['ACCT', 'MGR', 'ADMIN'],
  'messaging.use': ['SALES', 'INTERN', 'ACCT', 'MGR', 'ADMIN'],
  'admin.manage': ['ACCT', 'ADMIN'],
  'activity.view': ['ADMIN'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof ACL;

export function can(permission: Permission, role: Role | undefined): boolean {
  if (!role) return false;
  return (ACL[permission] as readonly string[]).includes(role);
}
