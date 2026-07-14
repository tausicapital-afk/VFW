import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { EXPORT_FORMATS, ExportFormat } from './export.types';

export class ExportQueryDto {
  @IsIn(EXPORT_FORMATS)
  format: ExportFormat;

  /**
   * The caller's IANA timezone ("America/Vancouver"), sent by the browser.
   *
   * Dates are timestamps, and the screen renders them in the *user's* zone while
   * the server runs in UTC. Without this a sale submitted the evening of Jul 13
   * in Vancouver exports as Jul 12 — a day earlier than the table it was pulled
   * from, and on the wrong side of a month or fiscal-year boundary. Defaults to
   * UTC, and an unknown zone falls back to it rather than failing the download.
   */
  @IsOptional() @IsString() @MaxLength(64)
  tz?: string;
}
