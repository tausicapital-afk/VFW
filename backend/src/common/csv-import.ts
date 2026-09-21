import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { csvToRecords } from './csv';

/**
 * The shape multer hands a controller once a file lands in memory. Typed by
 * hand rather than as `Express.Multer.File` because `@types/multer` is not a
 * project dependency — see admin.controller.ts / contacts.controller.ts, whose
 * import routes are the only place this repo touches file upload.
 */
export interface UploadedCsvFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/** Generous for a CSV of decimal-string prices and short text fields; guards against an accidental multi-MB paste. */
export const MAX_IMPORT_FILE_BYTES = 2 * 1024 * 1024;

/** A season's worth of shows or a whole contact book, but not an unbounded batch. */
export const MAX_IMPORT_ROWS = 2000;

export interface ImportRowError {
  /** 1-based, counting the header as row 1 — the row number the file looks like it has when opened in a spreadsheet. */
  row: number;
  error: string;
}

export interface ImportResult {
  succeeded: number;
  failed: number;
  errors: ImportRowError[];
}

function flattenViolations(errors: ValidationError[], prefix = ''): string[] {
  const messages: string[] = [];
  for (const err of errors) {
    const path = prefix ? `${prefix}.${err.property}` : err.property;
    if (err.constraints) {
      messages.push(...Object.values(err.constraints).map((m) => `${path}: ${m}`));
    }
    if (err.children?.length) messages.push(...flattenViolations(err.children, path));
  }
  return messages;
}

function errorMessage(e: unknown): string {
  if (e instanceof BadRequestException) {
    const r = e.getResponse();
    if (typeof r === 'string') return r;
    if (r && typeof r === 'object' && 'message' in r) {
      const m = (r as { message: unknown }).message;
      return Array.isArray(m) ? m.join('; ') : String(m);
    }
  }
  return e instanceof Error ? e.message : 'Import failed';
}

/**
 * Turns CSV text into rows run through the exact same DTO validation and the
 * exact same create() method a single-row create would use — see the callers
 * in admin.service.ts and contacts.service.ts. A bad row fails with the same
 * message a bad single create would, because it IS that code path, one row at
 * a time; there is no second copy of the business rules here to drift out of
 * step with the real one.
 *
 * DECISION — rows are independent, not all-or-nothing. Each `create` call
 * commits (or doesn't) on its own; most of the create() methods this feeds
 * already run inside their own `$transaction`. A bad row 12 of 50 is reported
 * and skipped, not rolled back alongside the 11 that already succeeded. This is
 * a data-entry tool for onboarding a season or migrating a contact list — an
 * admin who gets 49 good rows in plus one clearly-explained failure to fix and
 * re-import is better served than a batch that discards 49 good rows because of
 * one bad one and makes them start over.
 */
export async function importCsv<Dto extends object, Created>(
  csvText: string,
  toRow: (record: Record<string, string>) => Record<string, unknown>,
  DtoClass: new () => Dto,
  create: (dto: Dto) => Promise<Created>,
): Promise<ImportResult> {
  const records = csvToRecords(csvText);
  if (!records.length) {
    throw new BadRequestException(
      'That file has no data rows — it needs a header row plus at least one more',
    );
  }
  if (records.length > MAX_IMPORT_ROWS) {
    throw new BadRequestException(
      `That is ${records.length} rows, and an import holds ${MAX_IMPORT_ROWS}. Split the file and try again.`,
    );
  }

  const errors: ImportRowError[] = [];
  let succeeded = 0;

  for (let i = 0; i < records.length; i++) {
    const row = i + 2; // row 1 is the header
    try {
      const plain = toRow(records[i]);
      const dto = plainToInstance(DtoClass, plain);
      const violations = await validate(dto as object, {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
      if (violations.length) {
        throw new BadRequestException(flattenViolations(violations).join('; ') || 'Invalid row');
      }
      await create(dto);
      succeeded++;
    } catch (e) {
      errors.push({ row, error: errorMessage(e) });
    }
  }

  return { succeeded, failed: errors.length, errors };
}
