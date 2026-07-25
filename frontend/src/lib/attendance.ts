import type { AttendanceStatus } from './types';

/**
 * Calendar-day helpers.
 *
 * Every date in this module is a "YYYY-MM-DD" string in the *user's own* zone,
 * never a Date parsed from one. `new Date('2026-07-25')` is UTC midnight, which
 * in Vancouver is the evening of the 24th — so a sheet built that way is off by
 * one for half the world. The strings are built from local getters and compared
 * as strings, which has no timezone to be wrong about.
 */

export function dayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function monthKey(d: Date): string {
  return dayKey(d).slice(0, 7);
}

/** "HH:MM" on the wall clock in front of the person, which is what we record. */
export function timeNow(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Step a "YYYY-MM" by whole months, without ever touching a Date. */
export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number);
  const total = y * 12 + (m - 1) + by;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  // Noon, not midnight: a date built at midnight can slide into the previous day
  // under a negative UTC offset, which would name the wrong month at the edges.
  return new Date(y, m - 1, 15, 12).toLocaleDateString('en-CA', {
    month: 'long',
    year: 'numeric',
  });
}

/** Every day of the month, plus the leading blanks that align it to a Monday. */
export function monthGrid(month: string): (string | null)[] {
  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const daysInMonth = new Date(y, m, 0).getDate();
  // JS weeks start on Sunday; the grid starts on Monday, which is how a work
  // week reads.
  const lead = (first.getDay() + 6) % 7;

  return [
    ...Array<string | null>(lead).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`),
  ];
}

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function isWeekend(date: string): boolean {
  const [y, m, d] = date.split('-').map(Number);
  const day = new Date(y, m - 1, d).getDay();
  return day === 0 || day === 6;
}

export const STATUS_LABEL: Record<AttendanceStatus, string> = {
  PRESENT: 'Present',
  REMOTE: 'Remote',
  LEAVE: 'Leave',
  SICK: 'Sick',
  HOLIDAY: 'Holiday',
  ABSENT: 'Absent',
};

/**
 * Reuse the submission status palette rather than inventing a second one — the
 * mockup does the same for roles and account states, and a console with two
 * unrelated colour languages is harder to read, not richer.
 */
export const STATUS_PILL: Record<AttendanceStatus, string> = {
  PRESENT: 'APPROVED',
  REMOTE: 'EXPORTED',
  LEAVE: 'PENDING',
  SICK: 'RETURNED',
  HOLIDAY: 'DRAFT',
  ABSENT: 'REJECTED',
};

export const STATUSES = Object.keys(STATUS_LABEL) as AttendanceStatus[];

/** Hours implied by a pair of times, mirroring the server so the form can preview it. */
export function hoursBetween(checkIn: string, checkOut: string): string {
  const minutes = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  const start = minutes(checkIn);
  const end = minutes(checkOut);
  // An end before the start crosses midnight, exactly as the API reads it.
  const span = end >= start ? end - start : end + 24 * 60 - start;
  return (span / 60).toFixed(2);
}
