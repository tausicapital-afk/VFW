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
/** Wall-clock time, 24-hour. */
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

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
 * closed statement ("worked from nine to five, six hours, remote"), and half of
 * it arriving without the other half is how a row ends up saying someone worked
 * remotely for zero hours between times that no longer agree with the total.
 * Omitted optional fields are therefore cleared, not preserved.
 */
export class UpsertAttendanceDto {
  @IsOptional() @IsEnum(AttendanceStatus)
  status?: AttendanceStatus;

  /**
   * Hours worked, as a decimal string — the same convention money uses here, and
   * for the same reason: it is a number that gets totalled and compared, and a
   * float that has been through JSON is not the number that was typed.
   *
   * Optional because the times below can imply it. When both are supplied the
   * times win, so the row can never disagree with itself.
   */
  @IsOptional() @Matches(/^\d{1,2}(\.\d{1,2})?$/, {
    message: 'hours must be a number like 7.5',
  })
  hours?: string;

  @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(TIME_RE, {
    message: 'checkIn must look like 09:00',
  })
  checkIn?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(TIME_RE, {
    message: 'checkOut must look like 17:30',
  })
  checkOut?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(500)
  note?: string | null;

  /** Whose day. Omitted means your own; anything else needs `attendance.viewTeam`. */
  @IsOptional() @IsString() @MaxLength(60)
  userId?: string;
}

/**
 * Punching the clock.
 *
 * The date and time come from the client, which is unusual here and deliberate:
 * this API runs in UTC and has no idea what time it is where the person is
 * standing. Asking the server would mean a rep in Vancouver clocking in at 09:00
 * and the row saying 16:00 on, half the year, the wrong day. The browser is the
 * only participant that knows the wall clock, so it is the one that says.
 *
 * Nothing is trusted about it beyond shape. A dishonest client could post any
 * time — but it could equally post any hours to the endpoint above, because a
 * self-reported timesheet is self-reported. What keeps it honest is that a
 * manager reads it, which is what `attendance.viewTeam` is for.
 */
export class ClockDto {
  @Matches(DATE_RE, { message: 'date must look like 2026-07-25' })
  date: string;

  @Matches(TIME_RE, { message: 'time must look like 09:00' })
  time: string;

  @IsOptional() @IsString() @MaxLength(60)
  userId?: string;
}
