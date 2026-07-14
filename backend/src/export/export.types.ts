import type { Decimal } from '@prisma/client/runtime/library';
import { Permission } from '../common/acl';
import { AuthUser } from '../common/auth.guard';

export const EXPORT_FORMATS = ['csv', 'xlsx', 'pdf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

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

/**
 * One exportable resource. Registering a dataset is the whole job of making
 * something exportable — every format, the download endpoint, and the frontend
 * menu then work for it with no further code.
 */
export interface ExportDataset<T = unknown> {
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
  columns: ExportColumn<T>[];
  load: (user: AuthUser) => Promise<T[]>;
}

export interface RenderedFile {
  buffer: Buffer;
  filename: string;
  contentType: string;
}
