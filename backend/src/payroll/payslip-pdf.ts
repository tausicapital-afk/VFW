import PDFDocument from 'pdfkit';

/**
 * One person's pay period, rendered as a payslip they can print, keep or forward.
 *
 * Deliberately decoupled from Prisma and from PayrollService, exactly as
 * `submissions/invoice-pdf.ts` is: the service maps a statement onto this flat
 * shape, so the layout code never reaches back into the ORM and can be
 * exercised with a plain object — including the awkward shapes (no sales, no
 * timesheet, no submitted invoice) that are tedious to arrange in a database.
 * Uses only PDFKit's built-in Helvetica, so it needs no font files on disk.
 *
 * Every figure arrives here as an already-normalised two-decimal string. That is
 * not laziness about types — it is the point. The pay arithmetic happens once,
 * in Decimal, in PayrollService.statement(); a renderer that accepted numbers
 * would be a second place where money could be rounded, and the second place is
 * always the one that ends up disagreeing with the screen.
 */

/**
 * The enums, restated as local unions rather than imported from `@prisma/client`.
 * The generated values are assignable to these, so the service passes them
 * straight through, and this file stays a pure layout module with no ORM in its
 * import graph — the same trade `InvoicePdfData.brand` makes.
 */
export type PayslipPayType = 'SALARY' | 'HOURLY' | 'COMMISSION_ONLY';
export type PayslipRole = 'SALES' | 'INTERN' | 'ACCT' | 'MGR' | 'ADMIN';
export type PayslipInvoiceStatus = 'SUBMITTED' | 'APPROVED' | 'REJECTED';

export interface PayslipPdfData {
  companyName: string;
  /** The inclusive date range this document is for, and the only one on it. */
  period: { from: string; to: string };
  issuedAt: Date;
  /** The reporting currency. Payroll consolidates to one; there is no per-person currency. */
  currency: string;

  person: {
    name: string;
    employeeId: string | null;
    role: PayslipRole;
    title: string | null;
    department: string | null;
    email: string;
  };

  /**
   * How this person is paid, which is two independent facts — see the schema
   * comment on `User.earnsCommission`. Both are printed, because "commission
   * $0.00" means two entirely different things depending on the second one.
   */
  basis: {
    payType: PayslipPayType;
    earnsCommission: boolean;
    /** Monthly under SALARY, hourly under HOURLY, ignored when commission-only. */
    baseRate: string;
    commissionPct: string;
  };

  attendance: { days: number; daysWorked: number; hours: string; avgHours: string };

  sales: { count: number; revenue: string; invoiced: string };

  pay: {
    base: string;
    /** The hours the base was multiplied by, or null when it was not hourly. */
    baseHours: string | null;
    commission: string;
    commissionUnpaid: string;
    gross: string;
  };

  /** This period's payroll invoice, if one has been submitted. */
  invoice: {
    status: PayslipInvoiceStatus;
    submittedAt: Date;
    reviewedAt: Date | null;
    reviewedBy: string | null;
    note: string | null;
    /** The frozen gross, which can differ from the live one above. */
    gross: string;
  } | null;

  /** Who pulled the document. Provenance travels with a figure that gets forwarded. */
  preparedBy: string;
}

/** The wording the Payroll screen and the run export use, so the three agree. */
const ROLE_LABEL: Record<PayslipRole, string> = {
  SALES: 'Sales Representative',
  INTERN: 'Intern',
  ACCT: 'Accounting',
  MGR: 'Sales Manager',
  ADMIN: 'Administrator',
};

const PAY_TYPE_LABEL: Record<PayslipPayType, string> = {
  SALARY: 'Salary',
  HOURLY: 'Hourly',
  COMMISSION_ONLY: 'Commission only',
};

const INVOICE_LABEL: Record<PayslipInvoiceStatus, string> = {
  SUBMITTED: 'Submitted — awaiting approval',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

const INK = '#111827';
const MUTED = '#6b7280';
const LINE = '#e5e7eb';

function money(currency: string, value: string): string {
  const n = Number(value);
  try {
    return new Intl.NumberFormat('en-CA', {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
    }).format(Number.isFinite(n) ? n : 0);
  } catch {
    // An unknown ISO code should never crash a payslip; fall back to a plain figure.
    return `${currency} ${(Number.isFinite(n) ? n : 0).toFixed(2)}`;
  }
}

const date = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: 'short', day: 'numeric' }).format(d);

/** Whether `from`/`to` is exactly the 1st through the last day of one month —
 *  the range every payroll period was, before a custom one could be anything
 *  else. Restated from PayrollService's own `isCalendarMonth`: this file stays
 *  free of that module's imports, the same trade its other duplicated wording
 *  (`payBasis`) already makes. */
function isCalendarMonth(from: string, to: string): boolean {
  if (!from.endsWith('-01')) return false;
  const [y, m] = from.slice(0, 7).split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return to === `${from.slice(0, 7)}-${String(lastDay).padStart(2, '0')}`;
}

function shortDate(iso: string, withYear: boolean): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('en-CA', {
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' as const } : {}),
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * 'August 2026' when the period is exactly that calendar month — which is
 * what every payslip used to say, so a plain month still reads exactly as it
 * always did. A genuinely custom range spells out both ends: 'Aug 1 – Aug 15,
 * 2026', or 'Dec 28, 2026 – Jan 3, 2027' across a year boundary.
 */
function periodLabel(from: string, to: string): string {
  if (isCalendarMonth(from, to)) {
    const [y, m] = from.split('-').map(Number);
    return new Intl.DateTimeFormat('en-CA', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(y, m - 1, 1)));
  }
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  return `${shortDate(from, !sameYear)} – ${shortDate(to, true)}`;
}

/**
 * The pay basis as one phrase, because it is two fields and nobody reading a
 * payslip should have to cross-reference them to learn that the person on
 * $0.00 commission is on a salary and was never going to earn any. Same wording
 * as the run export's `payBasis` — a payslip and the run it came from must not
 * describe the same arrangement in two different ways.
 */
function payBasis(payType: PayslipPayType, earnsCommission: boolean): string {
  if (payType === 'COMMISSION_ONLY') return PAY_TYPE_LABEL[payType];
  return earnsCommission ? `${PAY_TYPE_LABEL[payType]} + commission` : PAY_TYPE_LABEL[payType];
}

/** One cell of the label/value grid. `span` widens it across adjacent columns. */
interface Cell {
  label: string;
  value: string;
  span?: number;
}

export function buildPayslipPdf(d: PayslipPdfData): Promise<Buffer> {
  // bufferPages so the footer can be written after the content has settled. A
  // payslip is meant to be one page and the layout below is sized for that, but
  // a long rejection reason can still push it over, and a footer stamped at a
  // fixed height on page one would then sit in the middle of the text.
  const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true });
  const done = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;
  const cash = (v: string) => money(d.currency, v);

  const rule = (at: number, colour = LINE) => {
    doc.moveTo(left, at).lineTo(right, at).strokeColor(colour).lineWidth(1).stroke();
  };

  /** A muted all-caps section heading with the rule under it. Returns the new y. */
  const section = (text: string, top: number): number => {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text(text.toUpperCase(), left, top, { width });
    const at = doc.y + 4;
    rule(at);
    return at + 9;
  };

  /**
   * A row of label-over-value cells across the page, wrapping to a new row when
   * the columns run out.
   *
   * Four narrow columns rather than two tall ones, which is not a taste
   * decision: a payslip that runs to two pages is a payslip whose second page
   * gets separated from the first, and the identity block and the derivation
   * block are exactly the parts that are read by scanning rather than by
   * reading. Anything that needs a whole line asks for a span.
   */
  const grid = (cells: Cell[], top: number): number => {
    const columns = 4;
    const gutter = 12;
    const cellW = (width - gutter * (columns - 1)) / columns;
    let col = 0;
    let rowTop = top;
    let bottom = top;

    for (const cell of cells) {
      const span = Math.min(Math.max(cell.span ?? 1, 1), columns);
      if (col + span > columns) {
        col = 0;
        rowTop = bottom + 8;
      }
      const x = left + col * (cellW + gutter);
      const w = cellW * span + gutter * (span - 1);
      doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(cell.label, x, rowTop, { width: w });
      doc.font('Helvetica').fontSize(10).fillColor(INK).text(cell.value, x, doc.y + 1, { width: w });
      bottom = Math.max(bottom, doc.y);
      col += span;
    }
    return bottom + 8;
  };

  // --- Header: company on the left, what this document is on the right ------
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(20).text(d.companyName, left, 48, { width: width * 0.6 });
  doc.font('Helvetica').fontSize(10).fillColor(MUTED).text('Payroll statement', left, doc.y + 2, { width: width * 0.6 });

  doc.font('Helvetica-Bold').fontSize(16).fillColor(INK).text('PAYSLIP', left, 48, { width, align: 'right' });
  doc.font('Helvetica').fontSize(10).fillColor(MUTED);
  doc.text(periodLabel(d.period.from, d.period.to), left, doc.y + 2, { width, align: 'right' });
  doc.text(`Issued ${date(d.issuedAt)}`, left, doc.y, { width, align: 'right' });

  let y = Math.max(doc.y, 112) + 10;
  rule(y);
  y += 16;

  // --- Who this is for, and how they are paid -------------------------------
  const half = (width - 16) / 2;
  doc.font('Helvetica-Bold').fontSize(15).fillColor(INK).text(d.person.name, left, y, { width: half });
  const nameBottom = doc.y;
  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor(MUTED)
    .text(d.person.title ?? ROLE_LABEL[d.person.role], left, nameBottom + 1, { width: half });
  const leftBottom = doc.y;

  doc
    .font('Helvetica-Bold')
    .fontSize(13)
    .fillColor(INK)
    .text(payBasis(d.basis.payType, d.basis.earnsCommission), left + half + 16, y + 2, {
      width: half,
      align: 'right',
    });
  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor(MUTED)
    .text(`Pay period ${periodLabel(d.period.from, d.period.to)}`, left + half + 16, doc.y + 1, { width: half, align: 'right' });

  y = Math.max(leftBottom, doc.y) + 12;

  y = grid(
    [
      { label: 'Employee ID', value: d.person.employeeId ?? '—' },
      { label: 'Role', value: ROLE_LABEL[d.person.role] },
      { label: 'Department', value: d.person.department ?? '—' },
      {
        label: 'Base rate',
        value:
          d.basis.payType === 'COMMISSION_ONLY'
            ? '— no base pay'
            : `${cash(d.basis.baseRate)} / ${d.basis.payType === 'HOURLY' ? 'hour' : 'month'}`,
      },
      { label: 'Email', value: d.person.email, span: 2 },
      {
        label: 'Commission rate',
        // The rate is left on the account even when somebody is off commission,
        // so an administrator gets it back on the way in. Printing it
        // unqualified would read as a promise, so say plainly it is not in force.
        value: d.basis.earnsCommission
          ? `${Number(d.basis.commissionPct).toFixed(2)}%`
          : `${Number(d.basis.commissionPct).toFixed(2)}% — not in force`,
      },
      { label: 'Hours recorded', value: `${d.attendance.hours} h` },
    ],
    y,
  );

  // --- Earnings: every line shows the arithmetic it came from ---------------
  y = section('Earnings', y + 4);

  const amountW = 110;
  const descW = width - amountW - 12;

  /**
   * One earnings line: what it is, what it was worked out from, and the figure.
   * The middle line is the whole reason this document is longer than a number —
   * a gross nobody can take apart is a gross nobody can query, and every payroll
   * question anyone actually asks is about one of the parts.
   */
  const earning = (title: string, derivation: string, amount: string, bold = false) => {
    const size = bold ? 12 : 11;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(INK);
    doc.text(title, left, y, { width: descW });
    const afterTitle = doc.y;
    doc.text(amount, right - amountW, y, { width: amountW, align: 'right' });
    let bottom = Math.max(afterTitle, doc.y);
    if (derivation) {
      doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(derivation, left, afterTitle + 1, { width: descW });
      bottom = Math.max(bottom, doc.y);
    }
    y = bottom + 8;
  };

  const baseDerivation =
    d.basis.payType === 'HOURLY'
      ? `${cash(d.basis.baseRate)} per hour × ${d.pay.baseHours ?? d.attendance.hours} hours on the timesheet`
      : d.basis.payType === 'SALARY'
        ? 'Monthly salary — not reduced by the hours recorded, because it is not paid by the hour'
        : 'This account is not paid a base';
  earning('Base pay', baseDerivation, cash(d.pay.base));

  const commissionDerivation = !d.basis.earnsCommission
    ? Number(d.pay.commission) > 0
      ? 'Not on commission — this is what was stamped onto sales closed while they were'
      : 'Not on commission'
    : `${d.sales.count} sale${d.sales.count === 1 ? '' : 's'} approved this period · ` +
      `${cash(d.sales.revenue)} net revenue, at the rate recorded on each sale`;
  earning('Commission', commissionDerivation, cash(d.pay.commission));

  if (Number(d.pay.commissionUnpaid) > 0) {
    earning(
      'Of which not yet collected',
      'Earned on approval, but sitting against invoices the client has not settled. Not deducted — declared.',
      `(${cash(d.pay.commissionUnpaid)})`,
    );
  }

  rule(y, INK);
  y += 8;
  earning('Gross pay', `Base + commission, in ${d.currency}`, cash(d.pay.gross), true);

  // --- What it was worked out from -----------------------------------------
  y = section('What it was worked out from', y + 2);
  y = grid(
    [
      { label: 'Days recorded', value: String(d.attendance.days) },
      { label: 'Days worked', value: String(d.attendance.daysWorked) },
      { label: 'Hours', value: `${d.attendance.hours} h` },
      { label: 'Average day', value: `${d.attendance.avgHours} h` },
      { label: 'Sales approved', value: String(d.sales.count) },
      { label: 'Net revenue', value: cash(d.sales.revenue) },
      { label: 'Invoiced total', value: cash(d.sales.invoiced) },
      { label: 'Commission earned', value: cash(d.pay.commission) },
    ],
    y,
  );

  // --- The payroll invoice, if this period has been claimed -----------------
  //
  // The statement above is derived on every read; the invoice is the claim made
  // against it, and it is frozen. Printing both is the point — if the two
  // disagree, a timesheet or a sale moved after the claim was made, and that is
  // precisely what somebody querying their pay has to be able to see.
  if (d.invoice) {
    y = section('Payroll invoice for this period', y + 2);
    y = grid(
      [
        { label: 'Status', value: INVOICE_LABEL[d.invoice.status] },
        { label: 'Submitted', value: date(d.invoice.submittedAt) },
        { label: 'Reviewed by', value: d.invoice.reviewedBy ?? '— not yet reviewed' },
        { label: 'Reviewed on', value: d.invoice.reviewedAt ? date(d.invoice.reviewedAt) : '—' },
        { label: 'Gross claimed', value: cash(d.invoice.gross), span: d.invoice.note ? 1 : 4 },
        ...(d.invoice.note
          ? [
              {
                label: d.invoice.status === 'REJECTED' ? 'Reason for rejection' : 'Note from the reviewer',
                value: d.invoice.note,
                span: 3,
              },
            ]
          : []),
      ],
      y,
    );

    if (d.invoice.gross !== d.pay.gross) {
      doc
        .font('Helvetica')
        .fontSize(8.5)
        .fillColor(MUTED)
        .text(
          `The claim was frozen at ${cash(d.invoice.gross)} and this period now works out at ` +
            `${cash(d.pay.gross)} — an attendance day or a sale was corrected after it was submitted.`,
          left,
          y,
          { width },
        );
      y = doc.y + 6;
    }
  }

  // --- Footer: provenance, and what this document is not --------------------
  //
  // Written onto whichever page the content actually ended on. Lifting the
  // bottom margin for the duration is the documented way to write into it
  // without pdfkit spilling to a fresh page — see the same manoeuvre in
  // ExportService.pdf.
  const range = doc.bufferedPageRange();
  doc.switchToPage(range.start + range.count - 1);
  const bottomMargin = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;

  const footY = Math.max(y + 14, doc.page.height - 104);
  rule(footY);
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor(MUTED)
    .text(
      d.invoice?.status === 'APPROVED'
        ? `This period was approved on ${d.invoice.reviewedAt ? date(d.invoice.reviewedAt) : 'record'}. ` +
            'The figures above are re-derived from the timesheet and the sales ledger each time this is ' +
            'produced and may have moved since; the approved claim is the figure that was paid.'
        : 'Not an approved payroll run. This period is worked out fresh from the pay setup, the timesheet ' +
            'and the sales ledger every time it is opened, so correcting an attendance day or amending a ' +
            'sale changes it.',
      left,
      footY + 8,
      { width },
    );
  doc
    .fontSize(8)
    .fillColor(MUTED)
    .text(
      `${d.companyName} · All amounts in ${d.currency} · Prepared by ${d.preparedBy} on ${date(d.issuedAt)}`,
      left,
      doc.y + 6,
      { width, align: 'center' },
    );

  doc.page.margins.bottom = bottomMargin;

  doc.end();
  return done;
}
