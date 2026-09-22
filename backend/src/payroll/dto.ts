import { Type } from 'class-transformer';
import {
  IsNumber, IsOptional, IsString, Matches, MaxLength, Min, MinLength,
} from 'class-validator';
import { DATE_RE } from '../attendance/dto';

export class PayrollQueryDto {
  /**
   * The period to read, as an inclusive date range — not always a calendar
   * month. Both or neither: the service defaults to the calendar month in
   * progress when both are omitted, and refuses a lone `from` or `to` as the
   * screen bug it would be.
   */
  @IsOptional() @Matches(DATE_RE, { message: 'from must look like 2026-08-01' })
  from?: string;

  @IsOptional() @Matches(DATE_RE, { message: 'to must look like 2026-08-31' })
  to?: string;

  /**
   * Whose pay. Omitted means your own — the only value a caller without
   * `payroll.viewAll` may effectively use, since the service refuses to resolve
   * anyone else's for them.
   */
  @IsOptional() @IsString() @MaxLength(60)
  userId?: string;
}

/** Submitting your own period's statement as a payroll invoice. Always
 *  yourself — there is no userId here, the same rule attendance's
 *  ClockDto/mark path follows for a self-report. Both bounds are required: a
 *  submission freezes an explicit range, never an implicit "whatever period
 *  the screen happened to be showing". */
export class SubmitPayrollDto {
  @Matches(DATE_RE, { message: 'from must look like 2026-08-01' })
  from: string;

  @Matches(DATE_RE, { message: 'to must look like 2026-08-31' })
  to: string;
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

// --- Commission tiers -------------------------------------------------------
// See the schema comment on CommissionTier for what these numbers mean and
// why there is one table for the whole company rather than one per user.

/**
 * A new bracket. Both figures arrive as strings and are parsed with Decimal in
 * the service, the same way tax rates are (`admin/dto.ts` CreateTaxDto) — a JS
 * number would round a rate typed with more precision than it can represent.
 */
export class CreateCommissionTierDto {
  @IsString()
  thresholdRevenue: string;

  @IsString()
  bonusPct: string;
}

/** Editing an existing bracket. Either figure alone is a valid edit — raising
 *  a threshold without touching its rate, or vice versa. */
export class UpdateCommissionTierDto {
  @IsOptional() @IsString()
  thresholdRevenue?: string;

  @IsOptional() @IsString()
  bonusPct?: string;
}
