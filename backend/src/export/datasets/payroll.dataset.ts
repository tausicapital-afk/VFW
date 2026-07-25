import { PayType, Role } from '@prisma/client';
import { PayrollService } from '../../payroll/payroll.service';
import { ExportColumn, ExportDataset } from '../export.types';

/** The wording the screens use, so a file never disagrees with the table it came from. */
const ROLE_LABEL: Record<Role, string> = {
  SALES: 'Sales Representative',
  INTERN: 'Intern',
  ACCT: 'Accounting',
  MGR: 'Sales Manager',
  ADMIN: 'Administrator',
};

const PAY_TYPE_LABEL: Record<PayType, string> = {
  SALARY: 'Salary',
  HOURLY: 'Hourly',
  COMMISSION_ONLY: 'Commission only',
};

type PayrollRow = Awaited<ReturnType<PayrollService['run']>>['rows'][number];

/**
 * The columns a payroll run is actually signed off from.
 *
 * Every money column is `money: true`, which keeps it a real number in csv/xlsx
 * rather than a formatted string — this is the file somebody totals in a
 * spreadsheet before paying people, and a column that has to be retyped to be
 * summed is a column that will be retyped wrongly.
 *
 * `Commission unpaid` is on the printed PDF, not hidden behind `spreadsheetOnly`,
 * because it is the one figure that qualifies the total: commission is earned when
 * a sale is approved, so part of a month's gross can be sitting against invoices
 * the client has not settled. Whoever signs the run needs that on the same page.
 */
const columns: ExportColumn<PayrollRow>[] = [
  { header: 'Person', value: (r) => r.user.name, width: 24 },
  { header: 'Employee ID', value: (r) => r.user.employeeId, width: 12, spreadsheetOnly: true },
  { header: 'Role', value: (r) => ROLE_LABEL[r.user.role], width: 20, spreadsheetOnly: true },
  { header: 'Title', value: (r) => r.user.title, width: 22, spreadsheetOnly: true },
  { header: 'Department', value: (r) => r.user.department, width: 16 },
  { header: 'Pay type', value: (r) => PAY_TYPE_LABEL[r.pay.payType], width: 15 },
  { header: 'Rate (CAD)', value: (r) => Number(r.pay.baseRate), money: true, width: 12 },
  { header: 'Days worked', value: (r) => r.attendance.daysWorked, width: 12, spreadsheetOnly: true },
  { header: 'Hours', value: (r) => Number(r.attendance.hours), width: 10 },
  { header: 'Base (CAD)', value: (r) => Number(r.pay.base), money: true, width: 13 },
  { header: 'Sales', value: (r) => r.sales.count, width: 8, spreadsheetOnly: true },
  { header: 'Net revenue (CAD)', value: (r) => Number(r.sales.revenue), money: true, width: 16, spreadsheetOnly: true },
  { header: 'Commission %', value: (r) => Number(r.user.commissionPct), width: 12, spreadsheetOnly: true },
  { header: 'Commission (CAD)', value: (r) => Number(r.pay.commission), money: true, width: 15 },
  { header: 'Of which unpaid', value: (r) => Number(r.pay.commissionUnpaid), money: true, width: 15 },
  { header: 'Gross (CAD)', value: (r) => Number(r.pay.gross), money: true, width: 14 },
];

/**
 * The month's payroll run, as the screen shows it.
 *
 * Carries `payroll.viewAll` rather than relying on `load` to scope the rows: a
 * run is every account by definition, so there is nothing for a row scope to
 * narrow, and the permission is the only thing between a signed-in rep and what
 * their colleagues are paid.
 */
export function payrollDataset(payroll: PayrollService): ExportDataset<PayrollRow> {
  return {
    key: 'payroll',
    title: 'Payroll',
    filename: 'payroll',
    permission: 'payroll.viewAll',
    load: async (user, filters) => (await payroll.run({ month: filters.month }, user)).rows,
    columns,
  };
}
