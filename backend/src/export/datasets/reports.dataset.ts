import {
  REPORTS,
  REPORT_KEYS,
  ReportCell,
  ReportKey,
  ReportsService,
} from '../../reports/reports.service';
import { ExportDataset } from '../export.types';

/**
 * One dataset per report.
 *
 * Registered per key rather than as a single `report` dataset taking a `type`
 * param, so each report brings its own title and filename — a folder of
 * `report-2026-07-15.csv` files that turn out to be different reports is not a
 * thing anyone can reconcile. It also keeps the menu generic: a screen names a
 * dataset, and this is no exception.
 *
 * Dynamic (see ExportDataset): a report's columns are a property of the answer,
 * not of the resource. *Sales by event* and *Sales by city* do not share a first
 * column label, and neither is known before the table is built.
 *
 * This replaces a client-side CSV/JSON builder that never reached the server —
 * so until now the one screen that produces consolidated revenue was the one
 * screen whose exports left no DATA_EXPORT line behind.
 */
export function reportDataset(reports: ReportsService, key: ReportKey): ExportDataset<ReportCell[]> {
  return {
    key: `report-${key}`,
    title: REPORTS[key],
    filename: `report-${key}`,
    permission: 'reports.view',
    load: async (_user, f) => {
      const table = await reports.summary(key, {
        from: f.from,
        to: f.to,
        eventId: f.eventId,
        cityId: f.cityId,
      });
      return {
        rows: table.rows,
        // The table's own columns, in its own order. `money` carries across so
        // the value stays a real number in xlsx and an accountant can sum the
        // column — the report already renders money to 2dp as a string, and
        // cellFor coerces it back.
        columns: table.cols.map((col, i) => ({
          header: col.label,
          value: (row: ReportCell[]) => row[i],
          money: col.money,
          width: col.money || col.num ? 14 : 20,
        })),
      };
    },
  };
}

/** Every report, ready to register. */
export function reportDatasets(reports: ReportsService): ExportDataset<ReportCell[]>[] {
  return REPORT_KEYS.map((key) => reportDataset(reports, key));
}
