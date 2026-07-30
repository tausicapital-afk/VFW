import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

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
