import { Type } from 'class-transformer';
import {
  IsNumber, IsOptional, IsString, Matches, MaxLength, Min, MinLength,
} from 'class-validator';

/** Same month shape the attendance screen uses — payroll runs on its hours. */
export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export class PayrollQueryDto {
  @IsOptional() @Matches(MONTH_RE, { message: 'month must look like 2026-07' })
  month?: string;

  /**
   * Whose pay. Omitted means your own — the only value a caller without
   * `payroll.viewAll` may effectively use, since the service refuses to resolve
   * anyone else's for them.
   */
  @IsOptional() @IsString() @MaxLength(60)
  userId?: string;
}

/** Submitting your own month's statement as a payroll invoice. Always yourself
 *  — there is no userId here, the same rule attendance's ClockDto/mark path
 *  follows for a self-report. */
export class SubmitPayrollDto {
  @Matches(MONTH_RE, { message: 'month must look like 2026-07' })
  month: string;
}

/**
 * An admin correcting the frozen figures before approving — e.g. a manual
 * bonus or a correction the person's own statement could not know about.
 * `note` is required: an edit to someone's pay must always say why.
 */
export class EditPayrollInvoiceDto {
  @IsOptional() @IsNumber() @Min(0) @Type(() => Number)
  base?: number;

  @IsOptional() @IsNumber() @Min(0) @Type(() => Number)
  commission?: number;

  @IsString() @MinLength(1) @MaxLength(2000)
  note: string;
}

export class RejectPayrollInvoiceDto {
  @IsString() @MinLength(1) @MaxLength(2000)
  reason: string;
}
