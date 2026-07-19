import { buildInvoicePdf, type InvoicePdfData } from './invoice-pdf';

/**
 * The PDF renderer is pure (no Prisma, no DB), so it can be exercised directly.
 * We can't assert on pixels, but we can prove it produces a well-formed PDF
 * without throwing on the shapes the service hands it — including the awkward
 * ones: no add-ons, no discount, a fully paid sale.
 */
describe('buildInvoicePdf', () => {
  const base: InvoicePdfData = {
    brand: 'VFW',
    companyName: 'VFW Management Inc.',
    invoiceNo: 'VFW-2041',
    docType: 'Invoice',
    issuedAt: new Date('2026-07-19T12:00:00Z'),
    currency: 'CAD',
    customer: { designer: 'Ada Couture', brand: 'ADA', company: 'Ada Ltd', email: 'ada@x.com', country: 'Canada' },
    event: { name: 'Vancouver Fashion Week', city: 'Vancouver, Canada', showDate: new Date('2026-09-20') },
    packageName: 'Bronze Runway',
    packagePrice: '7700.00',
    addons: [{ name: 'Backstage photos', qty: 2, amount: '600.00' }],
    subtotal: '8300.00',
    discountLabel: 'Discount (15% of package)',
    discountAmount: '1155.00',
    taxable: '7145.00',
    taxRatePct: '5.00',
    taxAmount: '357.25',
    total: '7502.25',
    paidAmount: '2000.00',
    balance: '5502.25',
    paymentMethod: 'Bank Transfer / Wire',
    paymentTerms: 'Net 30',
  };

  const isPdf = (b: Buffer) => b.length > 800 && b.subarray(0, 5).toString('latin1') === '%PDF-';

  it('renders a full invoice to a valid PDF buffer', async () => {
    const buf = await buildInvoicePdf(base);
    expect(isPdf(buf)).toBe(true);
  });

  it('renders a GFC sale with no add-ons and no discount', async () => {
    const buf = await buildInvoicePdf({
      ...base,
      brand: 'GFC',
      invoiceNo: 'GFC-1001',
      addons: [],
      discountLabel: null,
      discountAmount: '0.00',
      subtotal: '7700.00',
      taxable: '7700.00',
    });
    expect(isPdf(buf)).toBe(true);
  });

  it('renders a fully-paid sales receipt', async () => {
    const buf = await buildInvoicePdf({
      ...base,
      docType: 'Sales Receipt',
      paidAmount: '7502.25',
      balance: '0.00',
    });
    expect(isPdf(buf)).toBe(true);
  });
});
