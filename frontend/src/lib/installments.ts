/**
 * Payment-plan maths, shared by the two places a schedule is built: the
 * InstallmentsCard on a live sale, and the New Submission form where a rep can
 * seed a plan at intake. Everything here is pure and works in integer cents —
 * the server is still the only thing that decides what a sale costs, but a plan
 * builder has to add rows up as the user types, and cents keeps the equality
 * check against the balance exact (three parts of 8,624.00 land on
 * 2,874.66 / 2,874.67 / 2,874.67, not on 8,623.99).
 */

export const PAYMENT_METHODS = [
  'Bank Transfer / Wire', 'Credit Card', 'Stripe', 'PayPal',
  'Cheque', 'Cash', 'Sponsored — No Charge',
] as const;

export const INTERVALS = [
  { key: 'monthly', label: 'Monthly', months: 1, days: 0 },
  { key: 'fortnightly', label: 'Every 2 weeks', months: 0, days: 14 },
  { key: 'weekly', label: 'Weekly', months: 0, days: 7 },
] as const;

export type Cadence = (typeof INTERVALS)[number]['key'];

/** One line of a draft schedule, before it is sent to the server. */
export interface DraftLine {
  label: string;
  dueDate: string;
  amount: string;
  method: string;
}

export const toCents = (v: string | number): number => Math.round(Number(v || 0) * 100);
export const fromCents = (c: number): string => (c / 100).toFixed(2);

/** Split `cents` into `n` parts; the last absorbs the rounding remainder. */
export function splitEvenly(cents: number, n: number): number[] {
  const each = Math.floor(cents / n);
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? cents - each * (n - 1) : each));
}

/** Step a yyyy-mm-dd date forward, clamping to the end of a short month. */
export function step(date: string, months: number, days: number): string {
  const d = new Date(date + 'T00:00:00');
  if (months) {
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + months);
    // "The 31st, monthly" means the 30th in a 30-day month, not the 1st of the next.
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, lastDay));
  }
  if (days) d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export const today = (): string => new Date().toISOString().slice(0, 10);

/**
 * Generate an even schedule: `n` instalments of `cents`, the first due on
 * `from` and each next one stepped by `cadence`. This is the fast path; callers
 * that let the user hand-edit rows keep the result editable afterwards.
 */
export function generateSchedule(
  n: number,
  from: string,
  cadence: Cadence,
  cents: number,
  method: string,
): DraftLine[] {
  const spec = INTERVALS.find((i) => i.key === cadence) ?? INTERVALS[0];
  const amounts = splitEvenly(cents, n);
  let due = from;
  return amounts.map((a, idx) => {
    if (idx > 0) due = step(due, spec.months, spec.days);
    return {
      label: `Instalment ${idx + 1} of ${n}`,
      dueDate: due,
      amount: fromCents(a),
      method,
    };
  });
}
