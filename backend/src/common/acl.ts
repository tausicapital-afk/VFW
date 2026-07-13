import { Role } from '@prisma/client';

/**
 * The permission matrix, ported verbatim from vfw-console.html (line 481).
 *
 * This is the single source of truth for authorization. The frontend has a copy
 * for deciding what to *render*; this copy decides what is *allowed*. Never
 * trust the frontend's answer.
 */
export const ACL = {
  'submission.create': ['SALES', 'INTERN', 'ADMIN'],
  'submission.editOwn': ['SALES', 'INTERN', 'ADMIN'],
  'submission.editAny': ['ACCT', 'ADMIN'],
  'submission.viewAll': ['ACCT', 'MGR', 'ADMIN'],
  'submission.approve': ['ACCT', 'ADMIN'],
  'submission.reject': ['ACCT', 'ADMIN'],
  'submission.return': ['ACCT', 'ADMIN'],
  'accounting.fields': ['ACCT', 'ADMIN'],
  'quickbooks.export': ['ACCT', 'ADMIN'],
  'invoice.generate': ['ACCT', 'ADMIN'],
  'reports.view': ['ACCT', 'MGR', 'ADMIN'],
  'leaderboard.view': ['SALES', 'INTERN', 'ACCT', 'MGR', 'ADMIN'],
  'feedback.view': ['MGR', 'ADMIN', 'ACCT'],
  'feedback.record': ['MGR', 'ADMIN', 'ACCT', 'SALES', 'INTERN'],
  'internal.comment': ['ACCT', 'MGR', 'ADMIN'],
  'internal.view': ['ACCT', 'MGR', 'ADMIN'],
  'admin.manage': ['ADMIN'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof ACL;

export function can(permission: Permission, role: Role): boolean {
  return (ACL[permission] as readonly string[]).includes(role);
}
