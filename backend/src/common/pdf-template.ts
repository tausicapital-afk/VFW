import PDFDocument from 'pdfkit';
import { VFW_LOGO } from './brand-logo';

/**
 * The layout kit shared by every PDF this system produces — currently the
 * invoice (`submissions/invoice-pdf.ts`) and the payslip
 * (`payroll/payslip-pdf.ts`). One place for the ink/rule colours, the
 * money/date formatting, the page boilerplate and the brand mark, so the two
 * documents read as one system: change a colour or swap the logo here and
 * both move together, instead of two files quietly drifting apart the way
 * `money()` and `date()` already had before this existed.
 *
 * What this deliberately does NOT do is impose one fixed header layout. An
 * invoice's letterhead (brand code, doc type, invoice number) and a
 * payslip's (company name, period, "PAYSLIP") show different information for
 * good reason, so each file still lays out its own header — it just does so
 * with these shared primitives, and starts its left column past
 * {@link drawLogo}'s return value instead of at the page margin.
 */

export const INK = '#111827';
export const MUTED = '#6b7280';
export const LINE = '#e5e7eb';

export function formatMoney(currency: string, value: string): string {
  const n = Number(value);
  try {
    return new Intl.NumberFormat('en-CA', {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
    }).format(Number.isFinite(n) ? n : 0);
  } catch {
    // An unknown ISO code should never crash a document; fall back to a plain figure.
    return `${currency} ${(Number.isFinite(n) ? n : 0).toFixed(2)}`;
  }
}

export function formatDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: 'short', day: 'numeric' }).format(d);
}

/** A fresh A4 document plus the buffered-bytes promise every builder needs. */
export function newPdfDoc(options: PDFKit.PDFDocumentOptions = {}): {
  doc: PDFKit.PDFDocument;
  done: Promise<Buffer>;
} {
  const doc = new PDFDocument({ size: 'A4', margin: 48, ...options });
  const done = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  return { doc, done };
}

export function rule(doc: PDFKit.PDFDocument, left: number, right: number, y: number, colour = LINE): void {
  doc.moveTo(left, y).lineTo(right, y).strokeColor(colour).lineWidth(1).stroke();
}

/**
 * Draw the mark at `(x, y)`, sized `size` square, if one was shipped with
 * this deploy (see `brand-logo.ts`) — the caller decides whether it applies
 * (the invoice only draws it for a VFW-branded document, never a GFC one; the
 * payslip is company-wide and always draws it).
 *
 * Returns how much horizontal space it took, so the caller can shift the
 * heading that follows it: `0` when there is no logo, so callers don't need
 * an `if` of their own — `const textLeft = left + drawLogo(doc, left, top)`
 * works whether or not the asset is present.
 */
export function drawLogo(doc: PDFKit.PDFDocument, x: number, y: number, size = 36): number {
  if (!VFW_LOGO) return 0;
  doc.image(VFW_LOGO, x, y, { width: size, height: size });
  return size + 12;
}
