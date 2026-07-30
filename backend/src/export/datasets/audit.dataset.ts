import { AuditService } from '../../audit/audit.service';
import { ExportDataset, MAX_EXPORT_ROWS } from '../export.types';

type AuditRow = Awaited<ReturnType<AuditService['searchAll']>>[number];

/**
 * The global audit trail, filtered exactly as the screen filters it.
 *
 * This is the one export whose purpose is to leave the building — an auditor, a
 * dispute, a year-end. So it honours the screen's search and action filter
 * rather than always dumping everything: the person exporting has usually just
 * narrowed to the thing they were asked about, and a file that ignored that
 * would answer a question nobody asked.
 *
 * Guarded by 'reports.view', the same gate as the screen (see audit.controller).
 * A rep sees their own record's history on the submission itself; the
 * company-wide trail is not theirs, and neither is a file of it.
 */
export function auditDataset(audit: AuditService): ExportDataset<AuditRow> {
  return {
    key: 'audit',
    title: 'Audit trail',
    filename: 'audit-trail',
    permission: 'reports.view',
    // One past the ceiling, so an over-large trail is refused rather than
    // truncated — see MAX_EXPORT_ROWS and searchAll.
    load: (_user, f) =>
      audit.searchAll(
        { q: f.q, action: f.action, from: f.from, to: f.to },
        MAX_EXPORT_ROWS + 1,
      ),
    columns: [
      { header: 'When', value: (e) => e.createdAt, width: 13 },
      // The screen prints "SUBMISSION APPROVED", not "SUBMISSION_APPROVED".
      { header: 'Action', value: (e) => e.action.replace(/_/g, ' '), width: 22 },
      { header: 'Record', value: (e) => e.submission?.ref ?? '', width: 12 },
      { header: 'Brand', value: (e) => e.submission?.contact.brand ?? '', width: 20 },
      { header: 'Detail', value: (e) => e.detail, width: 44 },
      // An entry with no actor is the system acting on its own — a scheduled
      // job, a webhook. The screen says so rather than leaving the cell empty.
      { header: 'User', value: (e) => e.actor?.name ?? 'System', width: 20 },
      { header: 'Role', value: (e) => e.actor?.role, width: 10, spreadsheetOnly: true },
    ],
  };
}
