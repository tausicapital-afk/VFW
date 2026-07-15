import { SubmissionsService } from '../../submissions/submissions.service';
import { ExportDataset } from '../export.types';

type LedgerRow = Awaited<ReturnType<SubmissionsService['ledger']>>[number];

/**
 * The QuickBooks export ledger: what has already been posted.
 *
 * This is the reconciliation file — the question it answers is "does what we
 * think we posted match what QuickBooks holds", so it leads with the invoice
 * number and the posting date rather than the sales detail. The Submissions
 * export already covers the sales view of the same rows.
 *
 * 'quickbooks.export' matches the screen. `list`-style row scoping still applies
 * underneath (see ledger), so this is belt and braces rather than the only gate.
 */
export function qboLedgerDataset(submissions: SubmissionsService): ExportDataset<LedgerRow> {
  return {
    key: 'qbo-ledger',
    title: 'QuickBooks export ledger',
    filename: 'qbo-ledger',
    permission: 'quickbooks.export',
    load: (user) => submissions.ledger(user),
    columns: [
      { header: 'Invoice', value: (s) => s.invoiceNo, width: 13 },
      { header: 'Ref', value: (s) => s.ref, width: 12 },
      { header: 'Customer', value: (s) => s.contact.company || s.contact.brand, width: 24 },
      { header: 'Brand', value: (s) => s.contact.brand, width: 20, spreadsheetOnly: true },
      { header: 'Currency', value: (s) => s.currency, width: 9 },
      // Money next to its currency code, never a bare column: the ledger mixes
      // CAD, USD, GBP and EUR, and a summed column of those means nothing.
      { header: 'Total', value: (s) => s.total, money: true, width: 13 },
      { header: 'Tax', value: (s) => s.taxAmount, money: true, width: 12, spreadsheetOnly: true },
      { header: 'Tax code', value: (s) => s.taxCode, width: 10, spreadsheetOnly: true },
      { header: 'GL', value: (s) => s.glCode, width: 10 },
      { header: 'Exported', value: (s) => s.exportedAt, width: 13 },
      { header: 'Rep', value: (s) => s.rep.name, width: 18, spreadsheetOnly: true },
      { header: 'Event', value: (s) => s.event.name, width: 24, spreadsheetOnly: true },
    ],
  };
}
