import PDFDocument from 'pdfkit';

/**
 * A single invoice, rendered to a PDF the customer can be sent. Deliberately
 * decoupled from Prisma: the service maps a submission onto this flat shape, so
 * the layout code never reaches back into the ORM and can be unit-tested with a
 * plain object. Uses only PDFKit's built-in Helvetica, so it needs no font files
 * on disk — important in a slim production container.
 */
export interface InvoicePdfData {
  brand: 'VFW' | 'GFC';
  companyName: string;
  invoiceNo: string;
  docType: string; // 'Invoice' | 'Sales Receipt'
  issuedAt: Date;
  currency: string;
  customer: {
    designer: string;
    brand: string;
    company?: string | null;
    email?: string | null;
    country?: string | null;
  };
  event: { name: string; city: string; showDate?: Date | null };
  packageName: string;
  packagePrice: string;
  addons: { name: string; qty: number; amount: string }[];
  subtotal: string;
  discountLabel: string | null; // e.g. "Discount (15% of package)"; null when none
  discountAmount: string;
  taxable: string;
  taxRatePct: string;
  taxAmount: string;
  total: string;
  paidAmount: string;
  balance: string;
  paymentMethod?: string | null;
  paymentTerms?: string | null;
}

const BRAND_NAME: Record<InvoicePdfData['brand'], string> = {
  VFW: 'Vancouver Fashion Week',
  GFC: 'Global Fashion Collective',
};

const INK = '#111827';
const MUTED = '#6b7280';
const LINE = '#e5e7eb';
const ACCENT = '#111827';

function money(currency: string, value: string): string {
  const n = Number(value);
  try {
    return new Intl.NumberFormat('en-CA', {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
    }).format(Number.isFinite(n) ? n : 0);
  } catch {
    // An unknown ISO code should never crash an invoice; fall back to a plain figure.
    return `${currency} ${(Number.isFinite(n) ? n : 0).toFixed(2)}`;
  }
}

const date = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: 'short', day: 'numeric' }).format(d);

export function buildInvoicePdf(d: InvoicePdfData): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  const done = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;

  // --- Header: brand block on the left, document meta on the right ---------
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(22).text(d.brand, left, 48);
  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor(MUTED)
    .text(BRAND_NAME[d.brand], left, doc.y + 2)
    .text(d.companyName, { continued: false });

  const metaTop = 48;
  doc
    .font('Helvetica-Bold')
    .fontSize(16)
    .fillColor(INK)
    .text(d.docType.toUpperCase(), left, metaTop, { width, align: 'right' });
  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor(MUTED)
    .text(`No. ${d.invoiceNo}`, { width, align: 'right' })
    .text(`Issued ${date(d.issuedAt)}`, { width, align: 'right' });

  // Divider.
  const dividerY = Math.max(doc.y, 120) + 8;
  doc.moveTo(left, dividerY).lineTo(right, dividerY).strokeColor(LINE).lineWidth(1).stroke();

  // --- Bill-to + show details, two columns --------------------------------
  const colTop = dividerY + 16;
  const colGap = 24;
  const colW = (width - colGap) / 2;

  const label = (t: string, x: number, y: number) =>
    doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text(t.toUpperCase(), x, y, { width: colW });

  label('Bill to', left, colTop);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(d.customer.designer, left, doc.y + 2, { width: colW });
  doc.font('Helvetica').fontSize(10).fillColor(INK);
  doc.text(d.customer.brand, { width: colW });
  if (d.customer.company) doc.fillColor(MUTED).text(d.customer.company, { width: colW });
  if (d.customer.email) doc.fillColor(MUTED).text(d.customer.email, { width: colW });
  if (d.customer.country) doc.fillColor(MUTED).text(d.customer.country, { width: colW });

  const rightX = left + colW + colGap;
  label('Show', rightX, colTop);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(d.event.name, rightX, colTop + 13, { width: colW });
  doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(d.event.city, rightX, doc.y, { width: colW });
  if (d.event.showDate) doc.text(`Show date: ${date(d.event.showDate)}`, rightX, doc.y, { width: colW });

  // --- Line-item table -----------------------------------------------------
  let y = Math.max(doc.y, colTop + 80) + 20;
  const cols = {
    desc: left,
    qty: right - 210,
    unit: right - 150,
    amount: right,
  };

  doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED);
  doc.text('DESCRIPTION', cols.desc, y, { width: cols.qty - cols.desc - 8 });
  doc.text('QTY', cols.qty, y, { width: 40, align: 'right' });
  doc.text('AMOUNT', cols.unit, y, { width: cols.amount - cols.unit, align: 'right' });
  y += 16;
  doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).lineWidth(1).stroke();
  y += 8;

  const row = (desc: string, qty: string, amount: string, bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor(INK);
    const descW = cols.qty - cols.desc - 8;
    const h = doc.heightOfString(desc, { width: descW });
    doc.text(desc, cols.desc, y, { width: descW });
    doc.text(qty, cols.qty, y, { width: 40, align: 'right' });
    doc.text(amount, cols.unit, y, { width: cols.amount - cols.unit, align: 'right' });
    y += Math.max(h, 14) + 6;
  };

  row(d.packageName, '1', money(d.currency, d.packagePrice));
  for (const a of d.addons) {
    row(a.name, String(a.qty), money(d.currency, a.amount));
  }

  // --- Totals block, right-aligned ----------------------------------------
  y += 4;
  doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).lineWidth(1).stroke();
  y += 12;

  const totalsX = right - 260;
  const totalRow = (labelText: string, value: string, opts: { bold?: boolean; muted?: boolean } = {}) => {
    doc
      .font(opts.bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(opts.bold ? 12 : 10)
      .fillColor(opts.muted ? MUTED : INK);
    doc.text(labelText, totalsX, y, { width: 150 });
    doc.text(value, totalsX + 150, y, { width: right - (totalsX + 150), align: 'right' });
    y += (opts.bold ? 20 : 16);
  };

  totalRow('Subtotal', money(d.currency, d.subtotal), { muted: true });
  if (d.discountLabel && Number(d.discountAmount) > 0) {
    totalRow(d.discountLabel, '− ' + money(d.currency, d.discountAmount), { muted: true });
  }
  totalRow('Net revenue', money(d.currency, d.taxable), { muted: true });
  totalRow(`Tax (${d.taxRatePct}%)`, money(d.currency, d.taxAmount), { muted: true });

  // Emphasised total.
  y += 2;
  doc.moveTo(totalsX, y).lineTo(right, y).strokeColor(ACCENT).lineWidth(1).stroke();
  y += 8;
  totalRow('Total', money(d.currency, d.total), { bold: true });

  if (Number(d.paidAmount) > 0) {
    totalRow('Paid', '− ' + money(d.currency, d.paidAmount), { muted: true });
  }
  totalRow('Balance due', money(d.currency, d.balance), { bold: true });

  // --- Footer: payment terms ----------------------------------------------
  const footY = Math.max(y + 24, doc.page.height - 120);
  doc.moveTo(left, footY).lineTo(right, footY).strokeColor(LINE).lineWidth(1).stroke();
  doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text('PAYMENT', left, footY + 10);
  doc.font('Helvetica').fontSize(10).fillColor(INK);
  if (d.paymentMethod) doc.text(`Method: ${d.paymentMethod}`, left, doc.y + 2, { width });
  if (d.paymentTerms) doc.text(`Terms: ${d.paymentTerms}`, left, doc.y, { width });
  doc
    .fillColor(MUTED)
    .fontSize(9)
    .text(
      `${d.companyName} · All amounts in ${d.currency}. Thank you for your business.`,
      left,
      doc.page.height - 60,
      { width, align: 'center' },
    );

  doc.end();
  return done;
}
