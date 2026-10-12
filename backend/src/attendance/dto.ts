import { AttendanceStatus } from '@prisma/client';
import {
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/** A calendar day, as the client writes it. */
export const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
/** A month, for the screen's range. */
export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Which month, and whose. */
export class AttendanceQueryDto {
  @IsOptional() @Matches(MONTH_RE, { message: 'month must look like 2026-07' })
  month?: string;

  /**
   * Whose timesheet to read. Omitted means your own — the only value a caller
   * without `attendance.viewTeam` may effectively use, since the service refuses
   * to resolve anyone else's for them.
   */
  @IsOptional() @IsString() @MaxLength(60)
  userId?: string;
}

/** The whole team's month. No userId: it is, by definition, everyone. */
export class TeamQueryDto {
  @IsOptional() @Matches(MONTH_RE, { message: 'month must look like 2026-07' })
  month?: string;
}

/**
 * One day's record, written whole.
 *
 * A PUT rather than a PATCH, and that is the right shape here: a day is a small
 * closed statement ("worked six hours, remote"), and half of it arriving
 * without the other half is how a row ends up saying someone worked remotely
 * for zero hours.
 * Omitted optional fields are therefore cleared, not preserved.
 */
export class UpsertAttendanceDto {
  @IsOptional() @IsEnum(AttendanceStatus)
  status?: AttendanceStatus;

  /**
   * Hours worked, as a decimal string — the same convention money uses here, and
   * for the same reason: it is a number that gets totalled and compared, and a
   * float that has been through JSON is not the number that was typed.
   */
  @IsOptional() @Matches(/^\d{1,2}(\.\d{1,2})?$/, {
    message: 'hours must be a number like 7.5',
  })
  hours?: string;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(500)
  note?: string | null;

  /** Whose day. Omitted means your own; anything else needs `attendance.viewTeam`. */
  @IsOptional() @IsString() @MaxLength(60)
  userId?: string;
}

