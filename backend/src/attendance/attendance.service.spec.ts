import { AttendanceStatus } from '@prisma/client';
import { currentMonth, dayKey, hoursBetween, monthRange, parseDay, summarise } from './attendance.service';

/**
 * The arithmetic and the calendar, in isolation. Everything here is the part of
 * attendance that has no database in it — which is deliberately most of it, and
 * is why these run in milliseconds while attendance.spec.ts covers the wiring.
 *
 * Two of these are here because they are the classic ways a timesheet goes
 * quietly wrong: a night shift recorded as negative hours, and a day that moves
 * because the server is in a different timezone from the person.
 */

describe('hoursBetween', () => {
  it('measures an ordinary day', () => {
    expect(hoursBetween('09:00', '17:30').toString()).toBe('8.5');
  });

  it('counts a shift across midnight forwards, not backwards', () => {
    // 22:00 → 06:00 is eight hours of work, not minus sixteen.
    expect(hoursBetween('22:00', '06:00').toString()).toBe('8');
  });

  it('resolves to the minute', () => {
    expect(hoursBetween('09:10', '09:25').toString()).toBe('0.25');
  });

  it('reads identical times as no time at all, not as a 24-hour shift', () => {
    expect(hoursBetween('08:00', '08:00').toString()).toBe('0');
  });
});

describe('parseDay / dayKey', () => {
  it('round-trips a date without moving it', () => {
    expect(dayKey(parseDay('2026-07-25'))).toBe('2026-07-25');
  });

  it('pins the day to UTC midnight, so the server timezone cannot shift it', () => {
    const d = parseDay('2026-01-01');
    expect(d.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('rejects a day the month does not have', () => {
    expect(() => parseDay('2026-02-30')).toThrow();
  });

  it('rejects anything that is not a date', () => {
    expect(() => parseDay('25-07-2026')).toThrow();
    expect(() => parseDay('2026-13-01')).toThrow();
  });
});

describe('monthRange', () => {
  it('is half-open, so the last day of the month is in and the first of the next is out', () => {
    const { gte, lt } = monthRange('2026-07');
    expect(gte.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(lt.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('rolls the year over at December', () => {
    expect(monthRange('2026-12').lt.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('currentMonth', () => {
  it('names the month of a given instant', () => {
    expect(currentMonth(new Date('2026-07-25T18:00:00Z'))).toBe('2026-07');
  });
});

describe('summarise', () => {
  const day = (status: AttendanceStatus, hours: string) => ({ status, hours });

  it('separates days recorded from days actually worked', () => {
    const s = summarise([
      day(AttendanceStatus.PRESENT, '8'),
      day(AttendanceStatus.REMOTE, '7.5'),
      day(AttendanceStatus.LEAVE, '0'),
      day(AttendanceStatus.SICK, '0'),
    ]);

    expect(s.days).toBe(4);
    expect(s.daysWorked).toBe(2);
    expect(s.hours).toBe('15.50');
  });

  it('averages over days worked, not over rows', () => {
    // Eight hours across one worked day and three days of leave is an eight-hour
    // average day, not a two-hour one.
    const s = summarise([
      day(AttendanceStatus.PRESENT, '8'),
      day(AttendanceStatus.LEAVE, '0'),
      day(AttendanceStatus.LEAVE, '0'),
      day(AttendanceStatus.HOLIDAY, '0'),
    ]);

    expect(s.avgHours).toBe('8.00');
  });

  it('does not divide by zero for a month with nothing worked', () => {
    expect(summarise([day(AttendanceStatus.LEAVE, '0')]).avgHours).toBe('0.00');
    expect(summarise([]).avgHours).toBe('0.00');
  });

  it('counts every status, including the ones nobody used', () => {
    const s = summarise([day(AttendanceStatus.PRESENT, '8')]);
    expect(s.byStatus.PRESENT).toBe(1);
    expect(s.byStatus.ABSENT).toBe(0);
  });

  it('totals hours as decimals, not floats', () => {
    // 0.1 + 0.2 in float is 0.30000000000000004; a month of these would drift.
    const s = summarise([
      day(AttendanceStatus.PRESENT, '0.1'),
      day(AttendanceStatus.PRESENT, '0.2'),
    ]);
    expect(s.hours).toBe('0.30');
  });
});
