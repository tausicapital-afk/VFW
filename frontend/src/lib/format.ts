import type { Currency, Money, PayStatus, SubmissionStatus } from './types';

const SYMBOL: Record<Currency, string> = {
  USD: '$', CAD: '$', GBP: '£', EUR: '€', JPY: '¥',
};

/** Money arrives as a Decimal string. Parse only at the edge, to display it. */
export function money(v: Money | number | null | undefined, cur: Currency = 'USD'): string {
  const n = Number(v ?? 0);
  return (
    SYMBOL[cur] +
    n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
    ' ' +
    cur
  );
}

export function shortMoney(v: Money | number | null | undefined, cur: Currency = 'USD'): string {
  const n = Number(v ?? 0);
  const s = SYMBOL[cur];
  if (Math.abs(n) >= 1e6) return `${s}${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${s}${(n / 1e3).toFixed(1)}k`;
  return `${s}${n.toFixed(0)}`;
}

export function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-CA', {
    year: 'numeric', month: 'short', day: '2-digit',
  });
}

export function fmtDateTime(d: string | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-CA', {
    month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

export const STATUS_LABEL: Record<SubmissionStatus, string> = {
  DRAFT: 'Draft',
  PENDING: 'Pending accounting approval',
  RETURNED: 'Returned to sales',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  EXPORTED: 'Exported to QuickBooks',
};

export const PAY_LABEL: Record<PayStatus, string> = {
  UNPAID: 'Unpaid',
  PARTIAL: 'Part paid',
  PAID: 'Paid',
};
