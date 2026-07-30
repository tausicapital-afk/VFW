import { Role } from '@prisma/client';
import { AdminService } from '../../admin/admin.service';
import { ExportDataset } from '../export.types';

type InvitationRow = Awaited<ReturnType<AdminService['listInvitations']>>['invitations'][number];

/** The wording the screen uses, so an export never disagrees with the table it came from. */
const ROLE_LABEL: Record<Role, string> = {
  SALES: 'Sales Representative',
  INTERN: 'Intern',
  ACCT: 'Accounting',
  MGR: 'Sales Manager',
  ADMIN: 'Administrator',
};

/**
 * Invitation codes, as the Invitations card lists them — `listInvitations` already
 * drops deleted rows and derives the status (ACTIVE / USED / REVOKED / EXPIRED),
 * so the file holds exactly the rows on screen.
 *
 * The code itself is in here because the whole point of the row is that a code
 * was issued, and an admin chasing an unredeemed one needs it. It is not a
 * secret this export widens: a revoked or expired code is already dead, and a
 * live one is only useful to someone who could have read it off this tab anyway.
 */
export function invitationsDataset(admin: AdminService): ExportDataset<InvitationRow> {
  return {
    key: 'invitations',
    title: 'Invitations',
    filename: 'invitations',
    permission: 'admin.manage',
    load: async () => (await admin.listInvitations()).invitations,
    columns: [
      { header: 'Code', value: (i) => i.code, width: 12 },
      { header: 'Role', value: (i) => ROLE_LABEL[i.role], width: 20 },
      // The table prints "Open code" where there is no address, and the file says
      // the same — a blank cell reads as missing data rather than as a decision.
      { header: 'Email', value: (i) => i.email ?? 'Open code', width: 28 },
      { header: 'Department', value: (i) => i.department, width: 16, spreadsheetOnly: true },
      { header: 'Status', value: (i) => i.status, width: 10 },
      { header: 'Expires', value: (i) => i.expiresAt, width: 13 },
      { header: 'Issued', value: (i) => i.createdAt, width: 13, spreadsheetOnly: true },
      { header: 'Issued by', value: (i) => i.createdBy, width: 20, spreadsheetOnly: true },
      { header: 'Redeemed', value: (i) => i.usedAt, width: 13, spreadsheetOnly: true },
    ],
  };
}
