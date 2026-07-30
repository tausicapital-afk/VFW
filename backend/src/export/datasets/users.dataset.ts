import { Role } from '@prisma/client';
import { AdminService } from '../../admin/admin.service';
import { ExportColumn, ExportDataset } from '../export.types';

type UserRow = Awaited<ReturnType<AdminService['listUsers']>>['users'][number];

/** The wording the screen uses, so an export never disagrees with the table it came from. */
const ROLE_LABEL: Record<Role, string> = {
  SALES: 'Sales Representative',
  INTERN: 'Intern',
  ACCT: 'Accounting',
  MGR: 'Sales Manager',
  ADMIN: 'Administrator',
};

/**
 * The columns the Users & roles table shows, in its order. Shared with the
 * approvals export below: both tables are the same people in different states,
 * and a reviewer who exports one and then the other should not have to re-learn
 * the file.
 */
const columns: ExportColumn<UserRow>[] = [
  { header: 'Name', value: (u) => u.name, width: 22 },
  { header: 'Email', value: (u) => u.email, width: 28 },
  { header: 'Role', value: (u) => ROLE_LABEL[u.role], width: 20 },
  { header: 'Department', value: (u) => u.department, width: 16 },
  { header: 'Phone', value: (u) => u.phone, width: 16, spreadsheetOnly: true },
  { header: 'Employee ID', value: (u) => u.employeeId, width: 12, spreadsheetOnly: true },
  { header: 'Commission %', value: (u) => u.commissionPct, width: 12 },
  // Targets are held in CAD, the reporting currency — there is no per-user
  // currency to disagree with, so the number stands on its own.
  { header: 'Target (CAD)', value: (u) => u.target, money: true, width: 14 },
  { header: 'Status', value: (u) => u.status, width: 10 },
  { header: 'Created', value: (u) => u.createdAt, width: 13, spreadsheetOnly: true },
];

/**
 * Staff accounts, as the Users & roles tab lists them — `listUsers` already drops
 * hidden and deleted accounts, so the file holds exactly the rows on screen.
 *
 * Unlike submissions, `load` here is not scoped to the caller: it returns every
 * account regardless of who asks. The permission below is what stands in for that
 * — the tab is admin-only and so is the file it produces.
 */
export function usersDataset(admin: AdminService): ExportDataset<UserRow> {
  return {
    key: 'users',
    title: 'Users & roles',
    filename: 'users',
    permission: 'admin.manage',
    load: async () => (await admin.listUsers()).users,
    columns,
  };
}

/**
 * The sign-ups waiting on review, as the Pending approval card lists them.
 *
 * A separate dataset rather than a filter on the one above: the card is a work
 * queue, and an export of it that quietly contained every approved user too would
 * be worse than no export at all.
 */
export function userApprovalsDataset(admin: AdminService): ExportDataset<UserRow> {
  return {
    key: 'user-approvals',
    title: 'Sign-ups pending approval',
    filename: 'pending-approvals',
    permission: 'admin.manage',
    load: async () => (await admin.pendingUsers()).users,
    // Same people, same columns — but the queue is ordered by how long someone
    // has been waiting, so the date they asked is not a spreadsheet-only detail.
    columns: columns.map((c) =>
      c.header === 'Created'
        ? { ...c, header: 'Requested', spreadsheetOnly: false }
        : c,
    ),
  };
}
