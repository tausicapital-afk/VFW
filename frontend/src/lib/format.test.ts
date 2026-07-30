import {
  fmtAgo, fmtDate, fmtDateTime, fmtDuration, money, PAY_LABEL, shortMoney, STATUS_LABEL,
} from './format';

describe('money', () => {
  it('formats a Decimal string to 2dp with the currency code and symbol', () => {
    expect(money('1234.5', 'USD')).toBe('$1,234.50 USD');
  });

  it('defaults to USD when no currency is given', () => {
    expect(money('10')).toBe('$10.00 USD');
  });

  it('treats null/undefined as zero rather than throwing', () => {
    expect(money(null)).toBe('$0.00 USD');
    expect(money(undefined)).toBe('$0.00 USD');
  });

  it('uses the right symbol per currency', () => {
    expect(money('1', 'GBP')).toBe('£1.00 GBP');
    expect(money('1', 'EUR')).toBe('€1.00 EUR');
    expect(money('1', 'JPY')).toBe('¥1.00 JPY');
  });

  it('accepts a plain number as well as a Decimal string', () => {
    expect(money(5, 'CAD')).toBe('$5.00 CAD');
  });
});

describe('shortMoney', () => {
  it('abbreviates millions to two decimals with an M suffix', () => {
    expect(shortMoney(2_500_000, 'USD')).toBe('$2.50M');
  });

  it('abbreviates thousands to one decimal with a k suffix', () => {
    expect(shortMoney(2_500, 'USD')).toBe('$2.5k');
  });

  it('leaves sub-thousand values as a whole number', () => {
    expect(shortMoney(250, 'USD')).toBe('$250');
  });

  it('treats null/undefined as zero', () => {
    expect(shortMoney(null, 'USD')).toBe('$0');
  });

  it('takes the absolute value into account for the threshold, but keeps sign', () => {
    expect(shortMoney(-2_500_000, 'USD')).toBe('$-2.50M');
  });
});

describe('fmtDate / fmtDateTime', () => {
  it('renders a date as "Mon DD, YYYY"', () => {
    expect(fmtDate('2026-07-17T12:00:00.000Z')).toBe('Jul 17, 2026');
  });

  it('renders a date-time including hour and minute', () => {
    expect(fmtDateTime('2026-07-17T12:00:00.000Z')).toBe('Jul 17, 03:00 p.m.');
  });

  it('falls back to an em dash for null/undefined', () => {
    expect(fmtDate(null)).toBe('—');
    expect(fmtDate(undefined)).toBe('—');
    expect(fmtDateTime(null)).toBe('—');
  });
});

describe('fmtDuration', () => {
  it('falls back to an em dash when the value is null/undefined', () => {
    expect(fmtDuration(null)).toBe('—');
    expect(fmtDuration(undefined)).toBe('—');
  });

  it('renders sub-minute durations in seconds', () => {
    expect(fmtDuration(45)).toBe('45s');
  });

  it('renders sub-hour durations in minutes', () => {
    expect(fmtDuration(24 * 60)).toBe('24m');
  });

  it('renders durations over an hour as "Xh Ym"', () => {
    expect(fmtDuration(84 * 60)).toBe('1h 24m');
  });

  it('drops the minutes when they are zero', () => {
    expect(fmtDuration(2 * 3600)).toBe('2h');
  });

  it('rounds zero seconds down to "0s" rather than treating it as missing', () => {
    // 0 is falsy but not null/undefined — must not be confused with "no value".
    expect(fmtDuration(0)).toBe('0s');
  });
});

describe('fmtAgo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "Never" for null/undefined', () => {
    expect(fmtAgo(null)).toBe('Never');
    expect(fmtAgo(undefined)).toBe('Never');
  });

  it('returns "just now" for anything under 45 seconds old', () => {
    expect(fmtAgo(new Date('2026-07-17T11:59:20.000Z').toISOString())).toBe('just now');
  });

  it('returns minutes for anything under an hour old', () => {
    expect(fmtAgo(new Date('2026-07-17T11:55:00.000Z').toISOString())).toBe('5m ago');
  });

  it('returns hours for anything under a day old', () => {
    expect(fmtAgo(new Date('2026-07-17T09:00:00.000Z').toISOString())).toBe('3h ago');
  });

  it('returns days for anything under a week old', () => {
    expect(fmtAgo(new Date('2026-07-15T12:00:00.000Z').toISOString())).toBe('2d ago');
  });

  it('falls back to fmtDate once it is a week or older', () => {
    expect(fmtAgo(new Date('2026-07-01T12:00:00.000Z').toISOString())).toBe(fmtDate('2026-07-01T12:00:00.000Z'));
  });
});

describe('STATUS_LABEL / PAY_LABEL', () => {
  it('has a label for every submission status', () => {
    expect(STATUS_LABEL.DRAFT).toBe('Draft');
    expect(STATUS_LABEL.PENDING).toBe('Pending accounting approval');
    expect(STATUS_LABEL.EXPORTED).toBe('Exported to QuickBooks');
  });

  it('has a label for every pay status', () => {
    expect(PAY_LABEL.UNPAID).toBe('Unpaid');
    expect(PAY_LABEL.PARTIAL).toBe('Part paid');
    expect(PAY_LABEL.PAID).toBe('Paid');
  });
});
