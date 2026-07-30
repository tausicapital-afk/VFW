import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AttendanceStatus, Prisma, UserStatus } from '@prisma/client';
import { Decimal } from 'decimal.js';
import { ActivityService } from '../activity/activity.service';
import { AuditService } from '../audit/audit.service';
import { can } from '../common/acl';
import { AuthUser } from '../common/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { avatarUrl } from '../profile/avatar';
import { AttendanceQueryDto, ClockDto, DATE_RE, TeamQueryDto, UpsertAttendanceDto } from './dto';

/** The statuses that mean work happened. Everything else is a day away. */
export const WORKING_STATUSES: AttendanceStatus[] = [
  AttendanceStatus.PRESENT,
  AttendanceStatus.REMOTE,
];

/** Nobody works more than a day in a day. */
const MAX_HOURS = new Decimal(24);

const MINUTES_PER_DAY = 24 * 60;

/**
 * A calendar day as a UTC-midnight instant, which is what Postgres `DATE` round-
 * trips through Prisma as. Constructing it any other way lets the server's own
 * timezone shift the date by one on either side of midnight — the exact bug the
 * `@db.Date` column was chosen to avoid.
 */
export function parseDay(iso: string): Date {
  if (!DATE_RE.test(iso)) throw new BadRequestException('date must look like 2026-07-25');
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  // Rejects the 31st of a 30-day month, which the regex cannot see.
  if (date.getUTCMonth() !== m - 1) throw new BadRequestException(`${iso} is not a real date`);
  return date;
}

/** The inverse: a stored day back to the string the client sent. */
export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `2026-07` → the half-open range [1 July, 1 August). */
export function monthRange(month: string): { gte: Date; lt: Date } {
  const [y, m] = month.split('-').map(Number);
  return { gte: new Date(Date.UTC(y, m - 1, 1)), lt: new Date(Date.UTC(y, m, 1)) };
}

/** The month a client that said nothing almost certainly meant. */
export function currentMonth(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/**
 * Hours between two wall-clock times, to the minute.
 *
 * An end before the start is read as crossing midnight rather than as an error:
 * a shift that runs 22:00–06:00 is a real shift, and the alternative — refusing
 * it — would push night work into being recorded as two days it did not span.
 */
export function hoursBetween(checkIn: string, checkOut: string): Decimal {
  const minutes = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  const start = minutes(checkIn);
  const end = minutes(checkOut);
  const span = end >= start ? end - start : end + MINUTES_PER_DAY - start;
  return new Decimal(span).div(60).toDecimalPlaces(2);
}

type EntryRow = Prisma.AttendanceEntryGetPayload<{
  include: { updatedBy: { select: { id: true; name: true } } };
}>;

const ENTRY_INCLUDE = {
  updatedBy: { select: { id: true, name: true } },
} satisfies Prisma.AttendanceEntryInclude;

/** What the screen and the export both read a day as. */
function shape(entry: EntryRow, subjectId: string) {
  return {
    id: entry.id,
    userId: entry.userId,
    date: dayKey(entry.date),
    status: entry.status,
    hours: entry.hours.toString(),
    checkIn: entry.checkIn,
    checkOut: entry.checkOut,
    note: entry.note,
    // Surfaced rather than left to the client to work out, because "your manager
    // changed this" is the one thing about a timesheet row you cannot infer from
    // the row: the values look identical either way.
    correctedBy:
      entry.updatedById && entry.updatedById !== subjectId ? entry.updatedBy : null,
    updatedAt: entry.updatedAt,
  };
}

export type AttendanceRow = ReturnType<typeof shape>;

/**
 * Days and hours, totalled the way the screen shows them.
 *
 * `days` counts rows, `daysWorked` counts only the working statuses, and the two
 * are separate on purpose: a month with twenty entries of which four are leave is
 * not a sixteen-day month or a twenty-day one, it is both, and a single number
 * would have to quietly pick one.
 */
export function summarise(entries: { status: AttendanceStatus; hours: string }[]) {
  const byStatus = Object.fromEntries(
    Object.values(AttendanceStatus).map((s) => [s, 0]),
  ) as Record<AttendanceStatus, number>;

  let hours = new Decimal(0);
  let daysWorked = 0;

  for (const e of entries) {
    byStatus[e.status] += 1;
    hours = hours.plus(e.hours);
    if (WORKING_STATUSES.includes(e.status)) daysWorked += 1;
  }

  return {
    days: entries.length,
    daysWorked,
    hours: hours.toFixed(2),
    // The average is over days actually worked, not over rows: dividing by a
    // month that includes two weeks of leave answers a question nobody asked.
    avgHours: daysWorked ? hours.div(daysWorked).toDecimalPlaces(2).toFixed(2) : '0.00',
    byStatus,
  };
}

@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly activity: ActivityService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Whose timesheet this request is about.
   *
   * Every read and every write goes through here, which is what makes the rule
   * one rule: your own is always yours, anyone else's needs `attendance.viewTeam`,
   * and there is no third case. Note it resolves *before* the 404 check, so a rep
   * probing for ids gets the same "you cannot" for accounts that exist and
   * accounts that do not.
   */
  private async subject(userId: string | undefined, actor: AuthUser): Promise<string> {
    if (!userId || userId === actor.id) return actor.id;

    if (!can('attendance.viewTeam', actor.role)) {
      throw new ForbiddenException("Your role cannot open someone else's attendance");
    }

    const exists = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('User not found');
    return exists.id;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async list(query: AttendanceQueryDto, actor: AuthUser) {
    const userId = await this.subject(query.userId, actor);
    const month = query.month ?? currentMonth();

    const entries = await this.prisma.attendanceEntry.findMany({
      where: { userId, date: monthRange(month) },
      orderBy: { date: 'asc' },
      include: ENTRY_INCLUDE,
    });

    const rows = entries.map((e) => shape(e, userId));
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, role: true, department: true, colour: true, avatarKey: true },
    });

    return {
      month,
      user: user && {
        ...omitAvatarKey(user),
        avatarUrl: await avatarUrl(this.storage, user.avatarKey),
      },
      // Whether the caller is looking at their own sheet decides what the screen
      // may offer — you clock in on yours, you correct someone else's.
      self: userId === actor.id,
      entries: rows,
      summary: summarise(rows),
    };
  }

  /**
   * Everyone's month, one row per person.
   *
   * Includes people with no entries at all, which is the point of the screen: a
   * roll-up that listed only those who filled something in would hide exactly the
   * person a manager opened it to find.
   */
  async team(query: TeamQueryDto, actor: AuthUser) {
    if (!can('attendance.viewTeam', actor.role)) {
      throw new ForbiddenException('Your role cannot view team attendance');
    }

    const month = query.month ?? currentMonth();
    const range = monthRange(month);

    const users = await this.prisma.user.findMany({
      where: { deletedAt: null, hidden: false, status: UserStatus.ACTIVE },
      select: { id: true, name: true, role: true, department: true, colour: true, avatarKey: true },
      orderBy: { name: 'asc' },
    });

    const entries = await this.prisma.attendanceEntry.findMany({
      where: { userId: { in: users.map((u) => u.id) }, date: range },
      orderBy: { date: 'asc' },
      include: ENTRY_INCLUDE,
    });

    const byUser = new Map<string, AttendanceRow[]>();
    for (const entry of entries) {
      const list = byUser.get(entry.userId) ?? [];
      list.push(shape(entry, entry.userId));
      byUser.set(entry.userId, list);
    }

    const rows = await Promise.all(
      users.map(async (user) => {
        const days = byUser.get(user.id) ?? [];
        return {
          user: { ...omitAvatarKey(user), avatarUrl: await avatarUrl(this.storage, user.avatarKey) },
          entries: days,
          summary: summarise(days),
        };
      }),
    );

    return { month, rows };
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Record (or rewrite) one day.
   *
   * Upsert on `(userId, date)` rather than create-then-update: the unique
   * constraint already says a person has at most one answer per day, and doing it
   * in one statement means two tabs saving the same day race to a single row
   * instead of to a constraint violation.
   */
  async upsert(dateIso: string, dto: UpsertAttendanceDto, actor: AuthUser) {
    const userId = await this.subject(dto.userId, actor);
    const date = parseDay(dateIso);

    const status = dto.status ?? AttendanceStatus.PRESENT;
    const checkIn = dto.checkIn ?? null;
    const checkOut = dto.checkOut ?? null;
    const hours = this.resolveHours(dto, checkIn, checkOut);

    const data = {
      status,
      hours: new Prisma.Decimal(hours.toFixed(2)),
      checkIn,
      checkOut,
      note: dto.note?.trim() || null,
      updatedById: actor.id,
    };

    const entry = await this.prisma.attendanceEntry.upsert({
      where: { userId_date: { userId, date } },
      create: { userId, date, ...data },
      update: data,
      include: ENTRY_INCLUDE,
    });

    await this.record(userId, actor, dateIso, `marked ${status.toLowerCase()} · ${hours.toFixed(2)}h`);
    return shape(entry, userId);
  }

  /**
   * What the row's `hours` should say.
   *
   * The times win over a supplied total whenever both are present. That ordering
   * is the only one that cannot produce a row contradicting itself, and the form
   * sends both — it fills the total in as you pick the times, so a stale number
   * left in the field must not be able to override the times you just changed.
   */
  private resolveHours(
    dto: UpsertAttendanceDto,
    checkIn: string | null,
    checkOut: string | null,
  ): Decimal {
    if (checkIn && checkOut) return hoursBetween(checkIn, checkOut);

    if (dto.hours === undefined) return new Decimal(0);

    const hours = new Decimal(dto.hours);
    if (hours.isNegative() || hours.greaterThan(MAX_HOURS)) {
      throw new BadRequestException('hours must be between 0 and 24');
    }
    return hours.toDecimalPlaces(2);
  }

  /** Unmark a day entirely — different from marking it ABSENT, which is a claim. */
  async remove(dateIso: string, userId: string | undefined, actor: AuthUser) {
    const subject = await this.subject(userId, actor);
    const date = parseDay(dateIso);

    const deleted = await this.prisma.attendanceEntry.deleteMany({
      where: { userId: subject, date },
    });
    if (deleted.count === 0) throw new NotFoundException('Nothing is recorded for that day');

    await this.record(subject, actor, dateIso, 'cleared the day');
    return { ok: true };
  }

  /**
   * Start the day. Idempotent in the way that matters: clocking in twice keeps
   * the first time, because the honest answer to "when did you start?" does not
   * change because you reloaded the page.
   */
  async clockIn(dto: ClockDto, actor: AuthUser) {
    const userId = await this.subject(dto.userId, actor);
    const date = parseDay(dto.date);

    const existing = await this.prisma.attendanceEntry.findUnique({
      where: { userId_date: { userId, date } },
    });
    if (existing?.checkIn) {
      throw new BadRequestException(`Already clocked in at ${existing.checkIn}`);
    }

    const entry = await this.prisma.attendanceEntry.upsert({
      where: { userId_date: { userId, date } },
      create: {
        userId,
        date,
        status: AttendanceStatus.PRESENT,
        checkIn: dto.time,
        updatedById: actor.id,
      },
      update: { checkIn: dto.time, updatedById: actor.id },
      include: ENTRY_INCLUDE,
    });

    await this.record(userId, actor, dto.date, `clocked in at ${dto.time}`);
    return shape(entry, userId);
  }

  /**
   * End the day, and let the two times settle the hours. Clocking out again is
   * allowed and simply moves the end — staying later than you meant to is normal,
   * and the alternative is a row that permanently understates the day.
   */
  async clockOut(dto: ClockDto, actor: AuthUser) {
    const userId = await this.subject(dto.userId, actor);
    const date = parseDay(dto.date);

    const existing = await this.prisma.attendanceEntry.findUnique({
      where: { userId_date: { userId, date } },
    });
    if (!existing?.checkIn) throw new BadRequestException('Clock in first');

    const hours = hoursBetween(existing.checkIn, dto.time);
    const entry = await this.prisma.attendanceEntry.update({
      where: { userId_date: { userId, date } },
      data: {
        checkOut: dto.time,
        hours: new Prisma.Decimal(hours.toFixed(2)),
        updatedById: actor.id,
      },
      include: ENTRY_INCLUDE,
    });

    await this.record(userId, actor, dto.date, `clocked out at ${dto.time} · ${hours.toFixed(2)}h`);
    return shape(entry, userId);
  }

  /**
   * Leave a trail.
   *
   * Two of them, and not by accident. Every write gets a telemetry line, which is
   * enough for the Logs screen. A write to *somebody else's* sheet also gets an
   * audit entry, because that is the only kind of attendance change the person it
   * describes did not make — and a correction to the record of hours worked is
   * the sort of thing that has to still be visible months later, which is exactly
   * what the append-only trail is for.
   */
  private async record(userId: string, actor: AuthUser, date: string, what: string) {
    const onBehalf = userId !== actor.id;

    await this.activity
      .log({
        userId: actor.id,
        action: 'ATTENDANCE_MARKED',
        detail: onBehalf
          ? `${actor.name} corrected attendance for ${date} — ${what}`
          : `${actor.name} ${what} on ${date}`,
        meta: { date, subjectId: userId },
      })
      .catch(() => undefined);

    if (onBehalf) {
      await this.audit.log({
        actorId: actor.id,
        action: 'ATTENDANCE_CORRECTED',
        detail: `${actor.name} ${what} on ${date} on behalf of another user`,
        payload: { date, subjectId: userId },
      });
    }
  }
}

function omitAvatarKey<T extends { avatarKey: string | null }>(user: T) {
  const { avatarKey: _avatarKey, ...rest } = user;
  return rest;
}
