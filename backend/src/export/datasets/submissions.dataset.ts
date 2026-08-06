import { SubmissionStatus } from '@prisma/client';
import { SubmissionsService } from '../../submissions/submissions.service';
import { ExportDataset } from '../export.types';

type SubmissionRow = Awaited<ReturnType<SubmissionsService['list']>>[number];

/** The wording the screen uses, so an export never disagrees with the table it came from. */
const STATUS_LABEL: Record<SubmissionStatus, string> = {
  DRAFT: 'Draft',
  PENDING: 'Pending accounting approval',
  RETURNED: 'Returned to sales',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  EXPORTED: 'Exported to QuickBooks',
  VOIDED: 'Voided',
};

/**
 * Submissions, exactly as the caller may already see them: `list` applies the
 * same rep-scoping as the Submissions screen, so a sales rep exports their own
 * customers and nobody else's. No extra permission is needed to download what
 * you are already looking at.
 *
 * Money is exported unformatted and next to its currency code — the rows may mix
 * currencies, and a column of bare numbers must never read as if they were one.
 */
export function submissionsDataset(submissions: SubmissionsService): ExportDataset<SubmissionRow> {
  return {
    key: 'submissions',
    title: 'Submissions',
    filename: 'submissions',
    load: (user) => submissions.list(user),
    columns: [
      { header: 'Ref', value: (s) => s.ref, width: 12 },
      // Second column, and NOT spreadsheetOnly. A downloaded file loses the row
      // tint the screen carries, so this is the only thing standing between a
      // reader and a demo sale totalled into a real figure — it has to be next
      // to the reference and on the printed page, not buried at column twenty.
      { header: 'Test data', value: (s) => (s.isTestData ? 'TEST' : ''), width: 10 },
      { header: 'Brand', value: (s) => s.contact.brand, width: 20 },
      { header: 'Designer', value: (s) => s.contact.designer, width: 20, spreadsheetOnly: true },
      { header: 'Show', value: (s) => s.event.brand, width: 8 },
      { header: 'City', value: (s) => s.event.city.name, width: 14 },
      { header: 'Event', value: (s) => s.event.name, width: 24, spreadsheetOnly: true },
      { header: 'Package', value: (s) => s.packageNameOverride ?? s.package.name, width: 18 },
      { header: 'Customized', value: (s) => (s.packageCustomized ? 'Yes' : 'No'), width: 11, spreadsheetOnly: true },
      { header: 'Rep', value: (s) => s.rep.name, width: 18 },
      { header: 'Currency', value: (s) => s.currency, width: 9 },
      { header: 'Subtotal', value: (s) => s.subtotal, money: true, width: 12, spreadsheetOnly: true },
      { header: 'Discount', value: (s) => s.discountAmount, money: true, width: 12, spreadsheetOnly: true },
      { header: 'Tax', value: (s) => s.taxAmount, money: true, width: 12, spreadsheetOnly: true },
      { header: 'Total', value: (s) => s.total, money: true, width: 13 },
      { header: 'Paid', value: (s) => s.paidAmount, money: true, width: 12, spreadsheetOnly: true },
      { header: 'Balance', value: (s) => s.balance, money: true, width: 12, spreadsheetOnly: true },
      { header: 'Payment', value: (s) => s.payStatus, width: 10, spreadsheetOnly: true },
      { header: 'Status', value: (s) => STATUS_LABEL[s.status], width: 20 },
      { header: 'Invoice', value: (s) => s.invoiceNo, width: 12, spreadsheetOnly: true },
      { header: 'Submitted', value: (s) => s.submittedAt, width: 13 },
      { header: 'Approved', value: (s) => s.approvedAt, width: 13, spreadsheetOnly: true },
    ],
  };
}
