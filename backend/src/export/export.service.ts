import { BadRequestException, Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { AuthUser } from '../common/auth.guard';
import {
  CellValue,
  ExportColumn,
  ExportDataset,
  ExportFilters,
  ExportFormat,
  MAX_EXPORT_ROWS,
  RenderedFile,
} from './export.types';

const CONTENT_TYPE: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

/** Excel reads a leading =, +, -, @ (or a lone tab/CR) as the start of a formula. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** 1,234.56 — cents always shown, thousands separated, negatives in the usual form. */
const MONEY_FORMAT = '#,##0.00';

/** ISO order, so a date column sorts correctly as text as well as reading plainly. */
const DATE_FORMAT = 'yyyy-mm-dd';

/**
 * A dataset with its columns settled for this request, which is all a renderer
 * has any business knowing — whether the shape was declared up front or arrived
 * with the rows is `render`'s problem and nobody else's.
 */
type Resolved<T> = Omit<ExportDataset<T>, 'columns' | 'load'> & { columns: ExportColumn<T>[] };

@Injectable()
export class ExportService {
  /**
   * Render a dataset the caller is already allowed to see, in one of the three
   * formats. `tz` is the caller's IANA zone — see ExportQueryDto for why a
   * server that formats dates in its own zone quietly exports the wrong day.
   */
  async render<T>(
    dataset: ExportDataset<T>,
    user: AuthUser,
    format: ExportFormat,
    tz = 'UTC',
    filters: ExportFilters = {},
  ): Promise<RenderedFile> {
    // A static dataset returns its rows and declared its columns up front; a
    // dynamic one returns both together because only the answer knows its shape.
    // Everything past this line sees one resolved thing either way.
    const loaded = await dataset.load(user, filters);
    const rows = Array.isArray(loaded) ? loaded : loaded.rows;
    const columns = Array.isArray(loaded) ? (dataset.columns ?? []) : loaded.columns;
    const resolved: Resolved<T> = { ...dataset, columns };

    // Loudly, not quietly: a file that is silently a fragment still looks
    // complete to whoever reconciles against it. See MAX_EXPORT_ROWS.
    if (rows.length > MAX_EXPORT_ROWS) {
      throw new BadRequestException(
        `That is ${rows.length.toLocaleString('en-CA')} rows, and an export holds ` +
          `${MAX_EXPORT_ROWS.toLocaleString('en-CA')}. Narrow the filter and try again.`,
      );
    }

    const day = this.dayFormatter(tz);
    const filename = `${dataset.filename}-${day.format(new Date())}.${format}`;

    const buffer =
      format === 'csv'
        ? this.csv(resolved, rows, day)
        : format === 'xlsx'
          ? await this.xlsx(resolved, rows, day)
          : await this.pdf(resolved, rows, user, day);

    return { buffer, filename, contentType: CONTENT_TYPE[format] };
  }

  /**
   * A YYYY-MM-DD formatter for the caller's zone. en-CA is what makes the output
   * ISO-ordered, so the dates sort correctly as text as well as reading plainly.
   * An unrecognised zone must not fail a download — fall back to UTC.
   */
  private dayFormatter(tz: string): Intl.DateTimeFormat {
    const opts: Intl.DateTimeFormatOptions = {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    };
    try {
      return new Intl.DateTimeFormat('en-CA', { ...opts, timeZone: tz });
    } catch {
      return new Intl.DateTimeFormat('en-CA', { ...opts, timeZone: 'UTC' });
    }
  }

  // ---------------------------------------------------------------- CSV

  /**
   * RFC 4180, with two deliberate deviations for the program that actually opens
   * these files: a UTF-8 BOM (without it Excel mangles é, £, ¥) and a guard on
   * cells that begin like a formula — a brand literally named "=CMD" must land in
   * the sheet as text, not as something Excel tries to execute.
   */
  private csv<T>(dataset: Resolved<T>, rows: T[], day: Intl.DateTimeFormat): Buffer {
    const cell = (v: CellValue): string => {
      if (v === null || v === undefined) return '';
      const s = v instanceof Date ? day.format(v) : String(v);
      const safe = FORMULA_LEAD.test(s) ? `'${s}` : s;
      return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };

    const lines = [
      dataset.columns.map((c) => cell(c.header)).join(','),
      ...rows.map((row) => dataset.columns.map((c) => cell(c.value(row))).join(',')),
    ];

    return Buffer.from('﻿' + lines.join('\r\n') + '\r\n', 'utf8');
  }

  // --------------------------------------------------------------- XLSX

  /**
   * A working spreadsheet, not a screenshot of one: money stays numeric and
   * carries a cell format, so the accountant can select a column and get a sum.
   * The header row is frozen and filterable.
   */
  private async xlsx<T>(
    dataset: Resolved<T>,
    rows: T[],
    day: Intl.DateTimeFormat,
  ): Promise<Buffer> {
    const book = new ExcelJS.Workbook();
    book.created = new Date();
    // Excel rejects : \ / ? * [ ] in a sheet name and caps it at 31 chars.
    const sheet = book.addWorksheet(dataset.title.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31));

    sheet.columns = dataset.columns.map((c) => ({
      header: c.header,
      key: c.header,
      width: c.width ?? 16,
      style: c.money ? { numFmt: MONEY_FORMAT } : undefined,
    }));

    for (const row of rows) {
      const added = sheet.addRow(dataset.columns.map((c) => this.cellFor(c, row, day)));
      // Format whatever came through as a real date, so it is not left as a
      // bare serial number. Keyed off the value, not a column flag, so a new
      // dataset cannot forget to declare it.
      added.eachCell((cell) => {
        if (cell.value instanceof Date) cell.numFmt = DATE_FORMAT;
      });
    }

    const header = sheet.getRow(1);
    header.font = { bold: true };
    header.alignment = { vertical: 'middle' };
    header.height = 20;
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: dataset.columns.length },
    };

    // exceljs declares its own structural Buffer type; at runtime on Node this
    // is a real Buffer, which is what the response has to be written from.
    return (await book.xlsx.writeBuffer()) as unknown as Buffer;
  }

  /**
   * Dates and money must reach the sheet as a Date/number, or they cannot be
   * used as one. Anything else is written as text — in particular a Decimal that
   * is not declared money, which exceljs would otherwise store as "[object]".
   */
  private cellFor<T>(
    column: ExportColumn<T>,
    row: T,
    day: Intl.DateTimeFormat,
  ): string | number | Date | null {
    const v = column.value(row);
    if (v === null || v === undefined) return null;
    if (column.money) {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    if (v instanceof Date) return this.excelDate(v, day);
    if (typeof v === 'number' || typeof v === 'string') return v;
    return String(v);
  }

  /**
   * A spreadsheet has no notion of a timezone: it stores a wall-clock instant
   * and shows it verbatim. So the caller's *local* calendar day is re-pinned to
   * midnight UTC — otherwise Excel would display the underlying UTC instant, and
   * an evening sale in Vancouver would sit in the cell as the previous day.
   */
  private excelDate(d: Date, day: Intl.DateTimeFormat): Date {
    const [y, m, dd] = day.format(d).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, dd));
  }

  // ---------------------------------------------------------------- PDF

  /**
   * A landscape table that survives a printer: repeated header on every page,
   * zebra striping, page numbers, and a footer saying who pulled it and when —
   * an exported figure that gets forwarded should carry its own provenance.
   *
   * Columns marked spreadsheetOnly are dropped: a page has a fixed width, and a
   * table that fits 20 columns onto it is not readable by anyone.
   */
  private async pdf<T>(
    dataset: Resolved<T>,
    rows: T[],
    user: AuthUser,
    day: Intl.DateTimeFormat,
  ): Promise<Buffer> {
    const columns = dataset.columns.filter((c) => !c.spreadsheetOnly);
    const margin = 36;
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin, bufferPages: true });

    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    const pageWidth = doc.page.width - margin * 2;
    const totalUnits = columns.reduce((t, c) => t + (c.width ?? 16), 0);
    const widths = columns.map((c) => ((c.width ?? 16) / totalUnits) * pageWidth);
    const bottom = doc.page.height - margin - 24; // leave room for the footer

    const drawHeader = () => {
      doc.font('Helvetica-Bold').fontSize(16).fillColor('#0E0E11');
      doc.text(dataset.title, margin, margin);
      doc.font('Helvetica').fontSize(9).fillColor('#6A7280');
      doc.text(`${rows.length} record${rows.length === 1 ? '' : 's'}`, margin, margin + 22);
      doc.y = margin + 44;
    };

    const drawColumnHeads = () => {
      const top = doc.y;
      doc.rect(margin, top, pageWidth, 18).fill('#EDEFF2');
      doc.font('Helvetica-Bold').fontSize(7).fillColor('#15161A');
      let x = margin;
      columns.forEach((c, i) => {
        doc.text(c.header.toUpperCase(), x + 4, top + 6, {
          width: widths[i] - 8,
          align: c.money ? 'right' : 'left',
          lineBreak: false,
        });
        x += widths[i];
      });
      doc.y = top + 18;
    };

    drawHeader();
    drawColumnHeads();

    doc.font('Helvetica').fontSize(8);
    rows.forEach((row, r) => {
      const cells = columns.map((c) => this.pdfText(c, row, day));
      const heights = cells.map((text, i) =>
        doc.heightOfString(text, { width: widths[i] - 8, lineBreak: true }),
      );
      const height = Math.max(16, Math.max(...heights) + 8);

      if (doc.y + height > bottom) {
        doc.addPage();
        drawHeader();
        drawColumnHeads();
        doc.font('Helvetica').fontSize(8);
      }

      const top = doc.y;
      if (r % 2 === 1) doc.rect(margin, top, pageWidth, height).fill('#FAFBFC');

      let x = margin;
      cells.forEach((text, i) => {
        doc.fillColor('#15161A').text(text, x + 4, top + 4, {
          width: widths[i] - 8,
          align: columns[i].money ? 'right' : 'left',
        });
        x += widths[i];
      });

      doc
        .moveTo(margin, top + height)
        .lineTo(margin + pageWidth, top + height)
        .strokeColor('#E8EBEF')
        .lineWidth(0.5)
        .stroke();
      doc.y = top + height;
    });

    if (!rows.length) {
      doc.font('Helvetica').fontSize(9).fillColor('#6A7280');
      doc.text('No records.', margin, doc.y + 12);
    }

    // bufferPages held every page open so the footer can number them "n of N".
    const range = doc.bufferedPageRange();
    const stamp = new Intl.DateTimeFormat('en-CA', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: day.resolvedOptions().timeZone,
    }).format(new Date());
    const pulled = `Exported by ${user.name} · ${stamp}`;
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.font('Helvetica').fontSize(7).fillColor('#6A7280');

      // The footer is written *into* the bottom margin, and pdfkit spills to a
      // new page the moment text crosses that boundary — which would hand every
      // page a blank successor carrying nothing but its own page number. Lifting
      // the margin for the width of this one write is the documented way out.
      const bottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;

      const y = doc.page.height - margin + 4;
      doc.text(pulled, margin, y, { lineBreak: false });
      doc.text(`Page ${i + 1} of ${range.count}`, margin, y, {
        width: pageWidth,
        align: 'right',
        lineBreak: false,
      });

      doc.page.margins.bottom = bottomMargin;
    }

    doc.end();
    return done;
  }

  private pdfText<T>(column: ExportColumn<T>, row: T, day: Intl.DateTimeFormat): string {
    const v = column.value(row);
    if (v === null || v === undefined) return '—';
    if (column.money) {
      const n = Number(v);
      return Number.isFinite(n)
        ? n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : String(v);
    }
    if (v instanceof Date) return day.format(v);
    return String(v);
  }
}
