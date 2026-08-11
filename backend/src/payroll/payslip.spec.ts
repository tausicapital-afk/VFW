import type { INestApplication } from '@nestjs/common';
import type { Test } from 'supertest';
import { createTestApp, http, loginCookie } from '../../test/app';
import { PrismaService } from '../prisma/prisma.service';
import { PayrollService } from './payroll.service';
import type { AuthUser } from '../common/auth.guard';
import { buildPayslipPdf, type PayslipPdfData } from './payslip-pdf';

/**
 * The payslip.
 *
 * Two things are being defended here, and they are not the same thing.
 *
 * The first is the **disclosure boundary**, which matters more on this route
 * than on the statement it is built from: a screen is read and forgotten, a file
 * is kept and forwarded. The route deliberately owns no permission check of its
 * own — it goes through `statementFor`, which resolves the subject through
 * `subject()` — so what is tested is that the inheritance actually holds, not
 * that a second copy of the rule was written correctly. Hence the manager case:
 * MGR may read the team's *hours* and is refused their *pay*, and a payslip that
 * quietly forgot that would be the leak.
 *
 * The second is that the document **agrees with the screen**. Every figure on it
 * comes off the same statement the browser renders, so the test compares the two
 * field by field rather than asserting hard-coded totals: a payslip that is
 * internally consistent but disagrees with `GET /api/payroll` is the failure
 * that ends in somebody arguing from a printout.
 *
 * Text cannot be read back out of a rendered PDF without decompressing its
 * streams, so the figures are asserted against `payslip()`'s returned `data` —
 * the exact object handed to the renderer — while the HTTP tests prove the bytes
 * really are a PDF and the headers name a file. The renderer itself is pure and
 * is exercised directly on the shapes that are tedious to arrange in a database.
 */

const ADMIN = 'it@vanfashionweek.com';
const ACCT = 'accounting@vanfashionweek.com';
const MGR = 'sales.director@vanfashionweek.com';
const SALES = 'marielle@vanfashionweek.com';
const OTHER_SALES = 'diego@vanfashionweek.com';

// A month of its own, far from anything the rest of the suite touches — and in
// the *past*, because one of these tests submits the month as a payroll invoice
// and `submitMine` rightly refuses a month that has not happened yet.
const MONTH = '2019-03';
const IN_MONTH = new Date('2019-03-11T12:00:00Z');

const isPdf = (b: Buffer) => b.length > 800 && b.subarray(0, 5).toString('latin1') === '%PDF-';

/**
 * superagent registers no parser for `application/pdf` and would otherwise
 * decode the response as UTF-8 text — which mangles the bytes while leaving a
 * leading '%PDF-' perfectly intact, so the assertion would pass on a corrupted
 * body. Collect the raw chunks instead: the claim being tested is that real PDF
 * bytes reached the client, not that a string beginning '%PDF-' did.
 */
const rawBody = (test: Test): Test =>
  test.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
    res.on('error', (e) => cb(e, null));
  });

describe('payslip', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let payroll: PayrollService;
  let admin: string;
  let acct: string;
  let mgr: string;
  let sales: string;
  let salesId: string;
  let otherId: string;
  let salesActor: AuthUser;
  let acctActor: AuthUser;
  const litter: string[] = [];

  /** An approved sale for Marielle, dated into the payroll month under test. */
  const sale = async (over: {
    taxable: string;
    commissionAmount: string;
    payStatus?: 'PAID' | 'UNPAID';
  }) => {
    const row = await prisma.submission.create({
      data: {
        ref: `SLIP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        status: 'APPROVED',
        repId: salesId,
        contactId: (await prisma.contact.findFirstOrThrow()).id,
        eventId: 'VFW-FW26',
        cityId: (await prisma.event.findUniqueOrThrow({ where: { id: 'VFW-FW26' } })).cityId,
        packageId: 'VFW-BRONZE',
        currency: 'CAD',
        packagePrice: over.taxable,
        subtotal: over.taxable,
        taxable: over.taxable,
        taxRate: '0',
        taxAmount: '0',
        total: over.taxable,
        balance: '0',
        payStatus: over.payStatus ?? 'PAID',
        taxCode: (await prisma.taxProfile.findFirstOrThrow()).code,
        commissionPct: '8',
        commissionAmount: over.commissionAmount,
        approvedAt: IN_MONTH,
        submittedAt: IN_MONTH,
      },
    });
    litter.push(row.id);
    return row.id;
  };

  const day = (date: string, hours: string) =>
    prisma.attendanceEntry.create({
      data: { userId: salesId, date: new Date(`${date}T00:00:00Z`), status: 'PRESENT', hours },
    });

  const setPay = (
    payType: 'SALARY' | 'HOURLY' | 'COMMISSION_ONLY',
    baseRate: string,
    earnsCommission = true,
  ) => prisma.user.update({ where: { id: salesId }, data: { payType, baseRate, earnsCommission } });

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    payroll = app.get(PayrollService);
    admin = await loginCookie(app, ADMIN);
    acct = await loginCookie(app, ACCT);
    mgr = await loginCookie(app, MGR);
    sales = await loginCookie(app, SALES);

    const marielle = await prisma.user.findUniqueOrThrow({ where: { email: SALES } });
    const diego = await prisma.user.findUniqueOrThrow({ where: { email: OTHER_SALES } });
    const accounting = await prisma.user.findUniqueOrThrow({ where: { email: ACCT } });
    salesId = marielle.id;
    otherId = diego.id;
    salesActor = { id: marielle.id, email: marielle.email, name: marielle.name, role: marielle.role };
    acctActor = {
      id: accounting.id,
      email: accounting.email,
      name: accounting.name,
      role: accounting.role,
    };
  });

  afterEach(async () => {
    if (litter.length) {
      await prisma.submission.deleteMany({ where: { id: { in: litter.splice(0) } } });
    }
    await prisma.attendanceEntry.deleteMany({
      where: { date: { gte: new Date('2019-03-01'), lt: new Date('2019-04-01') } },
    });
    await prisma.payrollInvoice.deleteMany({ where: { month: MONTH } });
    await prisma.auditEntry.deleteMany({ where: { action: 'PAYSLIP_GENERATED' } });
    await setPay('COMMISSION_ONLY', '0');
  });

  afterAll(async () => {
    await app?.close();
  });

  // --- Who may pull whose ---------------------------------------------------

  it('gives every role their own payslip', async () => {
    for (const cookie of [sales, mgr, acct, admin]) {
      const res = await rawBody(
        http(app).get(`/api/payroll/payslip.pdf?month=${MONTH}`).set('Cookie', cookie),
      ).expect(200);
      expect(res.headers['content-type']).toContain('application/pdf');
      expect(isPdf(res.body as Buffer)).toBe(true);
      // The length header is written off the buffer, so a mismatch would mean
      // the body was re-encoded somewhere on the way out.
      expect(Number(res.headers['content-length'])).toBe((res.body as Buffer).length);
    }
  });

  it("refuses a rep someone else's payslip", async () => {
    await http(app)
      .get(`/api/payroll/payslip.pdf?month=${MONTH}&userId=${otherId}`)
      .set('Cookie', sales)
      .expect(403);
  });

  it("refuses a sales manager the team's payslips, though they may read the same people's hours", async () => {
    await http(app)
      .get(`/api/payroll/payslip.pdf?month=${MONTH}&userId=${salesId}`)
      .set('Cookie', mgr)
      .expect(403);
    await http(app).get(`/api/attendance/team?month=${MONTH}`).set('Cookie', mgr).expect(200);
  });

  it("lets payroll.viewAll pull somebody else's", async () => {
    for (const cookie of [acct, admin]) {
      const res = await rawBody(
        http(app)
          .get(`/api/payroll/payslip.pdf?month=${MONTH}&userId=${salesId}`)
          .set('Cookie', cookie),
      ).expect(200);
      expect(isPdf(res.body as Buffer)).toBe(true);
    }
  });

  it('names the file after the person and the month, not just "payslip"', async () => {
    const res = await http(app)
      .get(`/api/payroll/payslip.pdf?month=${MONTH}&userId=${salesId}`)
      .set('Cookie', acct)
      .expect(200);
    // VFW-1001 is Marielle's employee id in the seed. A download that collided
    // with last month's is a download somebody silently overwrites.
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="payslip-vfw-1001-${MONTH}.pdf"`,
    );
  });

  it('rejects a malformed month rather than quietly returning the current one', async () => {
    await http(app).get('/api/payroll/payslip.pdf?month=April').set('Cookie', sales).expect(400);
  });

  // --- The figures ----------------------------------------------------------

  it('carries exactly the figures the statement shows', async () => {
    await setPay('HOURLY', '32.00');
    await day('2019-03-03', '8');
    await day('2019-03-04', '7.5');
    await sale({ taxable: '10000', commissionAmount: '800', payStatus: 'PAID' });
    await sale({ taxable: '5000', commissionAmount: '400', payStatus: 'UNPAID' });

    const screen = (
      await http(app).get(`/api/payroll?month=${MONTH}`).set('Cookie', sales).expect(200)
    ).body;
    const { data } = await payroll.payslip({ month: MONTH }, salesActor);

    // Not a second assertion of the arithmetic — a proof that the document and
    // the screen are the same numbers. The maths is pinned in payroll.spec.ts.
    expect(data.month).toBe(screen.month);
    expect(data.pay.base).toBe(screen.pay.base);
    expect(data.pay.baseHours).toBe(screen.pay.baseHours);
    expect(data.pay.commission).toBe(screen.pay.commission);
    expect(data.pay.commissionUnpaid).toBe(screen.pay.commissionUnpaid);
    expect(data.pay.gross).toBe(screen.pay.gross);
    expect(data.sales.count).toBe(screen.sales.count);
    expect(data.sales.revenue).toBe(screen.sales.revenue);
    expect(data.sales.invoiced).toBe(screen.sales.invoiced);
    expect(data.attendance).toEqual(screen.attendance);
    expect(data.basis.baseRate).toBe(screen.pay.baseRate);
    expect(data.basis.commissionPct).toBe(screen.user.commissionPct);
    expect(data.basis.payType).toBe(screen.pay.payType);
    expect(data.basis.earnsCommission).toBe(screen.pay.earnsCommission);

    // And the sanity check the two share: base + commission really is gross.
    expect(Number(data.pay.base) + Number(data.pay.commission)).toBeCloseTo(
      Number(data.pay.gross),
      2,
    );
    expect(data.pay.base).toBe('496.00'); // 32.00 x 15.50
    expect(data.pay.commissionUnpaid).toBe('400.00');
  });

  it('carries the whole person, which is half of what a payslip is for', async () => {
    const { data } = await payroll.payslip({ month: MONTH }, salesActor);

    expect(data.person.name).toBe('Marielle Fontaine');
    expect(data.person.employeeId).toBe('VFW-1001');
    expect(data.person.department).toBe('Sales');
    expect(data.person.role).toBe('SALES');
    expect(data.person.email).toBe(SALES);
    expect(data.preparedBy).toBe('Marielle Fontaine');
  });

  it('states the pay basis honestly when somebody is not on commission', async () => {
    await setPay('SALARY', '5000.00', false);

    const { data } = await payroll.payslip({ month: MONTH }, salesActor);

    // The rate stays on the account so an admin gets it back on the way in; a
    // payslip must not let that read as money owed.
    expect(data.basis.earnsCommission).toBe(false);
    expect(data.basis.payType).toBe('SALARY');
    expect(data.pay.commission).toBe('0.00');
    expect(data.pay.gross).toBe('5000.00');
    expect(isPdf(await buildPayslipPdf(data))).toBe(true);
  });

  // --- The payroll invoice for the month ------------------------------------

  it("reports the month's payroll invoice, its reviewer and the date", async () => {
    await setPay('SALARY', '4000.00');
    await http(app)
      .post('/api/payroll/submit')
      .set('Cookie', sales)
      .send({ month: MONTH })
      .expect(201);

    const pending = (
      await http(app).get('/api/payroll/invoices/pending').set('Cookie', acct).expect(200)
    ).body as { id: string; month: string }[];
    const mine = pending.find((i) => i.month === MONTH);
    expect(mine).toBeDefined();
    await http(app)
      .post(`/api/payroll/invoices/${mine!.id}/approve`)
      .set('Cookie', acct)
      .expect(201);

    const { data } = await payroll.payslip({ month: MONTH, userId: salesId }, acctActor);

    expect(data.invoice).not.toBeNull();
    expect(data.invoice!.status).toBe('APPROVED');
    // The reviewer's name is the one thing the statement does not carry, so this
    // is the assertion that the extra lookup actually happened.
    expect(data.invoice!.reviewedBy).toBe('Hannah Okafor');
    expect(data.invoice!.reviewedAt).toBeInstanceOf(Date);
    // Normalised to two decimals so the document can compare it against the live
    // gross without "4000" ever failing to equal "4000.00".
    expect(data.invoice!.gross).toBe('4000.00');
  });

  it('says so plainly when no invoice has been submitted for the month', async () => {
    const { data } = await payroll.payslip({ month: MONTH }, salesActor);
    expect(data.invoice).toBeNull();
  });

  // --- The trail ------------------------------------------------------------

  it('audits the generation, including when it is your own', async () => {
    await payroll.payslip({ month: MONTH }, salesActor);

    const entries = await prisma.auditEntry.findMany({ where: { action: 'PAYSLIP_GENERATED' } });
    expect(entries).toHaveLength(1);
    expect(entries[0].actorId).toBe(salesId);
    expect(entries[0].payload).toMatchObject({ month: MONTH, userId: salesId, self: true });
  });

  // --- The renderer, on its own ---------------------------------------------

  it('renders the awkward shapes without throwing', async () => {
    const base: PayslipPdfData = {
      companyName: 'VFW Management Inc.',
      month: MONTH,
      issuedAt: new Date('2019-04-01T12:00:00Z'),
      currency: 'CAD',
      person: {
        name: 'Marielle Fontaine',
        employeeId: 'VFW-1001',
        role: 'SALES',
        title: 'Senior Sales Representative',
        department: 'Sales',
        email: SALES,
      },
      basis: { payType: 'HOURLY', earnsCommission: true, baseRate: '32.00', commissionPct: '8.00' },
      attendance: { days: 20, daysWorked: 18, hours: '142.50', avgHours: '7.92' },
      sales: { count: 3, revenue: '25000.00', invoiced: '28000.00' },
      pay: {
        base: '4560.00',
        baseHours: '142.50',
        commission: '2000.00',
        commissionUnpaid: '400.00',
        gross: '6560.00',
      },
      invoice: null,
      preparedBy: 'Hannah Okafor',
    };

    expect(isPdf(await buildPayslipPdf(base))).toBe(true);

    // A commission-only rep who sold nothing and has no timesheet, no title and
    // no employee id — every optional field empty at once, which is roughly what
    // a new starter's first month looks like.
    expect(
      isPdf(
        await buildPayslipPdf({
          ...base,
          person: { ...base.person, title: null, department: null, employeeId: null },
          basis: { ...base.basis, payType: 'COMMISSION_ONLY', baseRate: '0.00' },
          attendance: { days: 0, daysWorked: 0, hours: '0.00', avgHours: '0.00' },
          sales: { count: 0, revenue: '0.00', invoiced: '0.00' },
          pay: {
            base: '0.00',
            baseHours: null,
            commission: '0.00',
            commissionUnpaid: '0.00',
            gross: '0.00',
          },
        }),
      ),
    ).toBe(true);

    // A salaried person off commission, with a rejected invoice carrying a long
    // reason — the branch that has to wrap rather than run off the page.
    expect(
      isPdf(
        await buildPayslipPdf({
          ...base,
          basis: { ...base.basis, payType: 'SALARY', earnsCommission: false, baseRate: '5000.00' },
          pay: {
            ...base.pay,
            base: '5000.00',
            baseHours: null,
            commission: '0.00',
            commissionUnpaid: '0.00',
            gross: '5000.00',
          },
          invoice: {
            status: 'REJECTED',
            submittedAt: new Date('2019-04-01T09:00:00Z'),
            reviewedAt: new Date('2019-04-02T09:00:00Z'),
            reviewedBy: 'Hannah Okafor',
            note:
              'The timesheet for the last week of the month has not been filled in, so the hours ' +
              'behind the base figure cannot be checked. Complete it and resubmit.',
            gross: '5000.00',
          },
        }),
      ),
    ).toBe(true);

    // An approved invoice whose frozen gross no longer matches the live figure —
    // the branch that prints the discrepancy rather than hiding it.
    expect(
      isPdf(
        await buildPayslipPdf({
          ...base,
          invoice: {
            status: 'APPROVED',
            submittedAt: new Date('2019-04-01T09:00:00Z'),
            reviewedAt: new Date('2019-04-02T09:00:00Z'),
            reviewedBy: 'Hannah Okafor',
            note: null,
            gross: '6100.00',
          },
        }),
      ),
    ).toBe(true);

    // An unknown ISO currency code must never crash a payslip.
    expect(isPdf(await buildPayslipPdf({ ...base, currency: 'ZZZ' }))).toBe(true);
  });
});
