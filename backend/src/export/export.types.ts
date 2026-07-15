import type { Decimal } from '@prisma/client/runtime/library';
import { Permission } from '../common/acl';
import { AuthUser } from '../common/auth.guard';

export const EXPORT_FORMATS = ['csv', 'xlsx', 'pdf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * The most rows an export may contain.
 *
 * Not a performance guess — a correctness one. Every alternative to a limit is
 * worse: paging an export means handing someone a file that is quietly a
 * fragment, and no limit at all means one click can pull the whole audit trail
 * into memory and render it. Exceeding this fails loudly and says how to narrow
 * it, because a truncated export is indistinguishable from a complete one once
 * it is in a spreadsheet, and that is exactly the file someone reconciles or
 * signs off against.
 */
export const MAX_EXPORT_ROWS = 10_000;

/**
 * The screen's filters, forwarded to `load`. See ExportQueryDto for why this is
 * one flat shape for every dataset. A dataset reads the fields it understands
 * and ignores the rest; none of them may widen what the caller can see.
 */
export interface ExportFilters {
  q?: string;
  action?: string;
  state?: 'open' | 'closed';
  from?: string;
  to?: string;
  eventId?: string;
  cityId?: string;
}

/**
 * What a cell may hold. Decimal is in here so a money column can hand over the
 * value Prisma gave it, unconverted — the renderer, which knows what format it
 * is writing, decides whether that becomes a number or a string.
 */
export type CellValue = string | number | Decimal | Date | null | undefined;

export interface ExportColumn<T> {
  header: string;
  value: (row: T) => CellValue;
  /**
   * A money column. In csv/xlsx the value stays a real number so a spreadsheet
   * can sum it; the format is applied to the cell, not baked into a string.
   */
  money?: boolean;
  /**
   * Keep this column out of the PDF. The PDF is a readable report on a page of
   * finite width; csv/xlsx are the full dump. Detail columns set this so the
   * printed table stays legible instead of shrinking to nothing.
   */
  spreadsheetOnly?: boolean;
  /** Relative width hint (characters). Used for xlsx column widths and PDF layout. */
  width?: number;
}

/** What a dataset shares whichever way it declares its columns. */
interface ExportDatasetBase {
  /** URL segment: GET /api/export/<key>?format=… */
  key: string;
  /** Printed as the PDF heading and used as the xlsx sheet name. */
  title: string;
  /** Base filename; the renderer appends the date and extension. */
  filename: string;
  /**
   * An extra permission required to export at all. Usually undefined: `load`
   * is expected to scope rows to what this user may already see, so the export
   * can never reveal more than the screen it sits on.
   */
  permission?: Permission;
}

/** Rows and the columns that describe them, when only `load` knows the shape. */
export interface ExportPage<T> {
  rows: T[];
  columns: ExportColumn<T>[];
}

/**
 * The common case: one fixed shape, whatever was asked for. The columns are a
 * property of the resource, so they are declared once, next to it.
 */
interface StaticDataset<T> extends ExportDatasetBase {
  columns: ExportColumn<T>[];
  /**
   * The rows, already scoped to what this user may see. `filters` carries the
   * screen's own filters; a dataset whose screen has none simply ignores it.
   */
  load: (user: AuthUser, filters: ExportFilters) => Promise<T[]>;
}

/**
 * A dataset whose shape depends on what was asked for. Reports are the reason
 * this exists: each report key is its own table, and *Sales by event* and *Sales
 * by city* do not even share a first column label — the shape is a property of
 * the answer, not of the resource, so it can only arrive with the rows.
 */
interface DynamicDataset<T> extends ExportDatasetBase {
  columns?: never;
  load: (user: AuthUser, filters: ExportFilters) => Promise<ExportPage<T>>;
}

/**
 * One exportable resource. Registering a dataset is the whole job of making
 * something exportable — every format, the download endpoint, and the frontend
 * menu then work for it with no further code.
 *
 * The union is what stops the two ways of declaring columns from becoming two
 * ways of getting it wrong: a static dataset must supply `columns` and return an
 * array, a dynamic one must supply neither and return a page. There is no shape
 * that satisfies both and none that satisfies neither.
 */
export type ExportDataset<T = unknown> = StaticDataset<T> | DynamicDataset<T>;

export interface RenderedFile {
  buffer: Buffer;
  filename: string;
  contentType: string;
}
