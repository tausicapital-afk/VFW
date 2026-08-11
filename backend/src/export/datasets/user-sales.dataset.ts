import { PayrollService } from '../../payroll/payroll.service';
import { ExportColumn, ExportDataset } from '../export.types';

type SalesPeriod = Awaited<ReturnType<PayrollService['salesFor']>>;

/**
 * One client's share of one person's period. `from`/`to` and `person` repeat
 * on every row on purpose: this is the file somebody stacks several periods of
 * into one sheet to see a rep's year, and rows that could not say which period
 * or whose they were would be useless the moment they were sorted.
 */
type ClientRow = SalesPeriod['clients'][number] & { from: string; to: string; person: string };

const columns: ExportColumn<ClientRow>[] = [
  { header: 'From', value: (r) => r.from, width: 10 },
  { header: 'To', value: (r) => r.to, width: 10 },
  { header: 'Person', value: (r) => r.person, width: 22 },
  { header: 'Client', value: (r) => r.brand, width: 24 },
  { header: 'Designer', value: (r) => r.designer, width: 22, spreadsheetOnly: true },
  { header: 'Deals', value: (r) => r.deals, width: 8 },
  { header: 'Net revenue (CAD)', value: (r) => Number(r.revenue), money: true, width: 16 },
  { header: 'Invoiced (CAD)', value: (r) => Number(r.invoiced), money: true, width: 15 },
  { header: 'Collected (CAD)', value: (r) => Number(r.collected), money: true, width: 15 },
  { header: 'Outstanding (CAD)', value: (r) => Number(r.outstanding), money: true, width: 16 },
];

/**
 * What one person sold in one period, broken down by client — the table under
 * their payroll statement and under their details in Administration.
 *
 * Every figure is CAD: the sales behind it may be in five currencies, and they
 * are converted before they are summed, never after. That is why there is no
 * currency column to choose between.
 *
 * `load` goes through `salesFor`, so the file inherits the screen's scoping
 * exactly: with no `userId` it is your own period, and with one it is
 * somebody else's only if `payroll.viewAll` would have let you open it. That
 * is also why there is no `permission` here — the rule is per-subject and
 * already enforced one layer down, and a route-level grant would be a second,
 * coarser answer to a question that already has one. (Contrast `payroll`,
 * which is every account by definition and so has nothing for a row scope to
 * narrow.)
 *
 * One period at a time, matching the screen. Exporting a whole history in one
 * file would need a range the panel cannot express yet, and a dataset that
 * answered a question no screen asks is a dataset nobody can check against
 * anything.
 */
export function userSalesDataset(payroll: PayrollService): ExportDataset<ClientRow> {
  return {
    key: 'user-sales',
    title: 'Sales by client',
    filename: 'sales-by-client',
    load: async (user, filters) => {
      const sales = await payroll.salesFor(
        { userId: filters.userId, from: filters.from, to: filters.to },
        user,
      );
      return sales.clients.map((client) => ({
        ...client,
        from: sales.from,
        to: sales.to,
        person: sales.user.name,
      }));
    },
    columns,
  };
}
