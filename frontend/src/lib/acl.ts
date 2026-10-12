import type { User } from './types';

/**
 * The permission keys, mirroring the server (backend/src/common/acl.ts). What a
 * role grants is no longer fixed here: roles are edited under Administration ->
 * Roles, and the signed-in user arrives with their role's `permissions` from
 * the server. This file only decides what to *show* — the server re-checks
 * every call, and if the two ever disagree, the server wins.
 */
export const PERMISSIONS = [
  'submission.create',
  'submission.editOwn',
  'submission.editAny',
  'submission.viewAll',
  'submission.queueView',
  'submission.approve',
  'submission.reject',
  'submission.return',
  'submission.void',
  'accounting.fields',
  'quickbooks.export',
  'invoice.generate',
  'installment.plan',
  'installment.mark',
  'reports.view',
  'leaderboard.view',
  'contacts.view',
  'contacts.create',
  'feedback.view',
  'feedback.record',
  'internal.comment',
  'internal.view',
  'messaging.use',
  'email.viewOwn',
  'email.viewAll',
  'email.send',
  'attendance.mark',
  'attendance.viewTeam',
  'payroll.viewOwn',
  'payroll.viewAll',
  'payroll.submit',
  'payroll.approve',
  'payroll.manageTiers',
  'admin.manage',
  'activity.view',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function can(permission: Permission, user: Pick<User, 'permissions'> | null | undefined): boolean {
  return !!user?.permissions?.includes(permission);
}
