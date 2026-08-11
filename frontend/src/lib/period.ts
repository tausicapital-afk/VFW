import { monthKey, monthLabel, shiftMonth } from './attendance';

/**
 * Payroll periods — an inclusive `{ from, to }` date range. A calendar month
 * is just the common case (the 1st through the last day); Payroll can run for
 * any custom window besides. These helpers let the screens keep the familiar
 * "step a month at a time" control for the common case while a custom range
 * is just two dates typed in.
 */

/** The 1st through the last day of `month` ('YYYY-MM'), as an inclusive period. */
export function monthPeriod(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, '0')}` };
}

export function currentMonthPeriod(): { from: string; to: string } {
  return monthPeriod(monthKey(new Date()));
}

/** Whether `from`/`to` is exactly the 1st through the last day of one month —
 *  the range every period was, before a custom one could be anything else. */
export function isCalendarMonth(from: string, to: string): boolean {
  return from.endsWith('-01') && monthPeriod(from.slice(0, 7)).to === to;
}

/** Step a calendar-month period by whole months. Only meaningful when the
 *  period given actually is one — see `isCalendarMonth`. */
export function shiftMonthPeriod(period: { from: string; to: string }, by: number): { from: string; to: string } {
  return monthPeriod(shiftMonth(period.from.slice(0, 7), by));
}

/**
 * 'August 2026' when the period is exactly that calendar month — the common
 * case, and every period before a custom one was possible. A genuinely custom
 * range spells out both ends: 'Aug 1 – Aug 15, 2026', or 'Dec 28, 2026 – Jan
 * 3, 2027' across a year boundary. Mirrors payslip-pdf's identical rule on the
 * backend, so a downloaded payslip and the screen it came from never describe
 * the same period two different ways.
 */
export function periodLabel(from: string, to: string): string {
  if (isCalendarMonth(from, to)) return monthLabel(from.slice(0, 7));

  const short = (iso: string, withYear: boolean): string => {
    const [y, m, d] = iso.split('-').map(Number);
    // Noon, not midnight — see dayKey's note on why this module never builds a
    // Date at midnight local time.
    return new Date(y, m - 1, d, 12).toLocaleDateString('en-CA', {
      month: 'short',
      day: 'numeric',
      ...(withYear ? { year: 'numeric' as const } : {}),
    });
  };
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  return `${short(from, !sameYear)} – ${short(to, true)}`;
}
