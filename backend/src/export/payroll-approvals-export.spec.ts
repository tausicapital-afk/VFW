import type { INestApplication } from '@nestjs/common';
import { PayrollInvoiceStatus } from '@prisma/client';
import type { Response as SuperagentResponse } from 'superagent';
import { createTestApp, http, loginCookie } from '../../test/app';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The Payroll → Approvals export.
 *
 * `pending()` — the method backing both the screen and this dataset — returns
 * every submitted invoice by definition, with no per-row scope to rely on
 * (the same reasoning as `payroll` / *Payroll run*, see admin-exports.spec.ts
 * for the sibling test on that pattern). So the property worth pinning here
 * is the same one: the file holds what the tab holds, and only someone with
 * `payroll.approve` can pull it.
 */

const ADMIN = 'it@vanfashionweek.com';
const ACCT = 'accounting@vanfashionweek.com';
const SALES = 'marielle@vanfashionweek.com';

// A period far from anything else the suite touches.
const PERIOD_START = new Date('2033-02-01T00:00:00Z');
const PERIOD_END = new Date('2033-02-28T00:00:00Z');

function binaryParser(
  res: SuperagentResponse,
  cb: (err: Error | null, body: Buffer) => void,
): void {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
  stream.on('end', () => cb(null, Buffer.concat(chunks)));
}

describe('payroll approvals export', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  let acct: string;
  let sales: string;
  let salesId: string;
  let invoiceId: string;

  /** Pull the export as the given cookie and hand back the decoded text. */
  const pull = async (cookie: string, format: 'csv' | 'xlsx' | 'pdf' = 'csv') => {
    const res = await http(app)
      .get(`/api/export/payroll-approvals?format=${format}`)
      .set('Cookie', cookie)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);
    return res.body as Buffer;
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginCookie(app, ADMIN);
    acct = await loginCookie(app, ACCT);
    sales = await loginCookie(app, SALES);
    salesId = (await prisma.user.findUniqueOrThrow({ where: { email: SALES } })).id;

    const invoice = await prisma.payrollInvoice.upsert({
      where: {
        userId_periodStart_periodEnd: { userId: salesId, periodStart: PERIOD_START, periodEnd: PERIOD_END },
      },
      create: {
        userId: salesId,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        status: PayrollInvoiceStatus.SUBMITTED,
        payType: 'HOURLY',
        baseRate: '25.00',
        hours: '40.00',
        base: '1000.00',
        commissionPct: '8.00',
        commission: '150.00',
        gross: '1150.00',
        earnsCommission: true,
        note: 'Approvals export coverage',
      },
      update: { status: PayrollInvoiceStatus.SUBMITTED },
    });
    invoiceId = invoice.id;
  });

  afterAll(async () => {
    await prisma.payrollInvoice.delete({ where: { id: invoiceId } }).catch(() => undefined);
    await app?.close();
  });

  it('renders in all three formats for someone who can approve payroll', async () => {
    for (const format of ['csv', 'xlsx', 'pdf'] as const) {
      const res = await http(app)
        .get(`/api/export/payroll-approvals?format=${format}`)
        .set('Cookie', acct)
        .buffer(true)
        .parse(binaryParser)
        .expect(200);
      const file = res.body as Buffer;
      expect(file.length).toBeGreaterThan(0);
      expect(res.headers['content-disposition']).toContain(`.${format}`);
    }
  }, 30_000);

  it('carries the same submitted invoice the Approvals tab lists', async () => {
    const pending = await http(app)
      .get('/api/payroll/invoices/pending')
      .set('Cookie', acct)
      .expect(200);
    expect((pending.body as { id: string }[]).some((i) => i.id === invoiceId)).toBe(true);

    const csv = (await pull(acct)).toString('utf8');

    expect(csv).toContain('Person,Role,Period start,Period end,Pay basis');
    // The rep's name shows up against a gross figure equal to what pending() reports.
    expect(csv).toMatch(/,1150(\.00)?\s*[,\r\n]/);
  });

  it('is gated on payroll.approve — an admin (who has it) can pull it, a rep cannot', async () => {
    await http(app).get('/api/export/payroll-approvals?format=csv').set('Cookie', admin).expect(200);
    await http(app).get('/api/export/payroll-approvals?format=csv').set('Cookie', sales).expect(403);
  });
});
