import { IsDateString, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
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

  // -------------------------------------------------------------------------
  // The screen's filters.
  //
  // An export claims to hold what the table holds, and a screen that filters
  // server-side (Audit, Logs, Reports) breaks that claim the moment the file
  // ignores the filter. So the menu sends them and `load` receives them.
  //
  // They live on one flat DTO rather than one per dataset because the global
  // pipe runs `forbidNonWhitelisted`: a param no DTO declares is a 400, and a
  // route that serves every dataset only gets one DTO. The trade is that a
  // dataset may be handed a filter it has no use for, which is why `load` reads
  // the ones it wants rather than being passed a shape it must satisfy.
  //
  // Nothing in here may widen what a caller can see — these narrow a set the
  // dataset has already scoped, never reach past it.
  // -------------------------------------------------------------------------

  /** Free text. What it searches is the dataset's business. */
  @IsOptional() @IsString() @MaxLength(120)
  q?: string;

  @IsOptional() @IsString() @MaxLength(40)
  action?: string;

  /** Logs → Sessions: 'open' = still online, 'closed' = ended, omitted = both. */
  @IsOptional() @IsIn(['open', 'closed'])
  state?: 'open' | 'closed';

  @IsOptional() @IsDateString()
  from?: string;

  @IsOptional() @IsDateString()
  to?: string;

  @IsOptional() @IsString() @MaxLength(60)
  eventId?: string;

  @IsOptional() @IsString() @MaxLength(60)
  cityId?: string;
}
