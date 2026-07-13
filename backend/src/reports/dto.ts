import { IsDateString, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { REPORT_KEYS, ReportKey } from './reports.service';

/**
 * The reporting period and slice. Nothing here can change a figure — these only
 * narrow which already-priced submissions are counted.
 */
export class ReportQueryDto {
  @IsIn(REPORT_KEYS)
  type: ReportKey;

  @IsOptional() @IsDateString()
  from?: string;

  @IsOptional() @IsDateString()
  to?: string;

  @IsOptional() @IsString() @MaxLength(60)
  eventId?: string;

  @IsOptional() @IsString() @MaxLength(60)
  cityId?: string;
}

export class LeaderboardQueryDto {
  @IsOptional() @IsDateString()
  from?: string;

  @IsOptional() @IsDateString()
  to?: string;

  @IsOptional() @IsString() @MaxLength(60)
  eventId?: string;

  @IsOptional() @IsString() @MaxLength(60)
  cityId?: string;
}

export class AuditQueryDto {
  /** Free text over action, detail, actor name and the submission ref/brand. */
  @IsOptional() @IsString() @MaxLength(120)
  q?: string;

  @IsOptional() @IsString() @MaxLength(40)
  action?: string;

  @IsOptional() @IsString() @MaxLength(60)
  submissionId?: string;

  @IsOptional() @IsDateString()
  from?: string;

  @IsOptional() @IsDateString()
  to?: string;

  @IsOptional() @IsInt() @Min(1) @Max(200) @Type(() => Number)
  limit?: number;

  @IsOptional() @IsInt() @Min(0) @Type(() => Number)
  offset?: number;
}
