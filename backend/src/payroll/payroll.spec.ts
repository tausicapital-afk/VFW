import type { INestApplication } from '@nestjs/common';
import { createTestApp, http, loginCookie } from '../../test/app';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Payroll.
 *
 * The arithmetic is the easy half and is still worth pinning, because it is
 * arithmetic about what people are paid. The harder half is what feeds it:
 * payroll reads three sources that each move on their own — the pay setup, the
 * timesheet, and the sales ledger — and the failure that matters is not a wrong
 * sum but a right sum over the wrong month. Hence the tests about *dating*:
 * commission belongs to the month a sale was approved, and a sale approved
 * outside the window must not appear at all.
 *
 * The disclosure boundary gets the same attention as attendance's, because it is
 * stricter: a manager may read the team's hours but not their salaries.
 */

const ADMIN = 'it@vanfashionweek.com';
const ACCT = 'accounting@vanfashionweek.com';
const MGR = 'sales.director@vanfashionweek.com';
const SALES = 'marielle@vanfashionweek.com';
const OTHER_SALES = 'diego@vanfashionweek.com';

// A month far from anything else the suite touches.
const MONTH = '2032-05';
const IN_MONTH = new Date('2032-05-14T12:00:00Z');
const NEXT_MONTH = new Date('2032-06-14T12:00:00Z');

describe('payroll', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  let acct: string;
  let mgr: string;
  let sales: string;
  let salesId: string;
  let otherId: string;
  const litter: string[] = [];

  /**
   * An approved sale for Marielle, stamped with an explicit `approvedAt` so the
   * test controls which payroll month it lands in. Written directly rather than
   * driven through the endpoints: the lifecycle is covered elsewhere, and what
   * matters here is only the shape payroll reads.
   */
  const sale = async (over: {
    approvedAt: Date;
    taxable: string;
    commissionAmount: string;
    payStatus?: 'PAID' | 'PARTIAL' | 'UNPAID';
    repId?: string;
  }) => {
    const row = await prisma.submission.create({
      data: {
        ref: `PAY-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        status: 'APPROVED',
        repId: over.repId ?? salesId,
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
        approvedAt: over.approvedAt,
        submittedAt: over.approvedAt,
      },
    });
    litter.push(row.id);
    return row.id;
  };

  const day = (date: string, hours: string) =>
    prisma.attendanceEntry.create({
      data: { userId: salesId, date: new Date(`${date}T00:00:00Z`), status: 'PRESENT', hours },
    });

  const setPay = (payType: 'SALARY' | 'HOURLY' | 'COMMISSION_ONLY', baseRate: string) =>
    prisma.user.update({ where: { id: salesId }, data: { payType, baseRate } });

  const statement = async (cookie: string, userId?: string) => {
    const res = await http(app)
      .get(`/api/payroll?month=${MONTH}` + (userId ? `&userId=${userId}` : ''))
      .set('Cookie', cookie)
      .expect(200);
    return res.body;
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginCookie(app, ADMIN);
    acct = await loginCookie(app, ACCT);
    mgr = await loginCookie(app, MGR);
    sales = await loginCookie(app, SALES);
    salesId = (await prisma.user.findUniqueOrThrow({ where: { email: SALES } })).id;
    otherId = (await prisma.user.findUniqueOrThrow({ where: { email: OTHER_SALES } })).id;
  });

  afterEach(async () => {
    if (litter.length) {
      await prisma.submission.deleteMany({ where: { id: { in: litter.splice(0) } } });
    }
    await prisma.attendanceEntry.deleteMany({
      where: { date: { gte: new Date('2032-05-01'), lt: new Date('2032-06-01') } },
    });
    await setPay('COMMISSION_ONLY', '0');
  });

  afterAll(async () => {
    await app?.close();
  });

  // --- Base pay ------------------------------------------------------------

  it('pays an hourly account its rate times the hours on the timesheet', async () => {
    await setPay('HOURLY', '32.00');
    await day('2032-05-03', '8');
    await day('2032-05-04', '7.5');

    const body = await statement(sales);

    expect(body.attendance.hours).toBe('15.50');
    expect(body.pay.baseHours).toBe('15.50');
    expect(body.pay.base).toBe('496.00'); // 32 × 15.5
    expect(body.pay.gross).toBe('496.00');
  });

  it('pays a salary in full regardless of what the timesheet says', async () => {
    await setPay('SALARY', '5000.00');
    await day('2032-05-03', '3');

    const body = await statement(sales);

    // Three hours in a month does not reduce a salary — it is not paid by the hour.
    expect(body.pay.base).toBe('5000.00');
    // The hours are still reported, because a salaried person's attendance is
    // worth seeing; it is just not what they are paid on.
    expect(body.attendance.hours).toBe('3.00');
    expect(body.pay.baseHours).toBeNull();
  });

  it('pays a commission-only account no base at all', async () => {
    await setPay('COMMISSION_ONLY', '9999.00');
    await day('2032-05-03', '8');

    const body = await statement(sales);

    // The rate is deliberately left on the row — an admin who parks someone on
    // commission for a season should get their rate back on the way out.
    expect(body.pay.base).toBe('0.00');
    expect(body.user.baseRate).toBe('9999.00');
  });

  // --- Commission ----------------------------------------------------------

  it('counts commission in the month the sale was approved', async () => {
    await sale({ approvedAt: IN_MONTH, taxable: '10000', commissionAmount: '800' });
    await sale({ approvedAt: NEXT_MONTH, taxable: '50000', commissionAmount: '4000' });

    const body = await statement(sales);

    expect(body.sales.count).toBe(1);
    expect(body.sales.revenue).toBe('10000.00');
    expect(body.pay.commission).toBe('800.00');
  });

  it('adds commission on top of base pay', async () => {
    await setPay('SALARY', '4000.00');
    await sale({ approvedAt: IN_MONTH, taxable: '10000', commissionAmount: '800' });

    const body = await statement(sales);
    expect(body.pay.gross).toBe('4800.00');
  });

  it('declares how much of the commission is on invoices the client has not settled', async () => {
    await sale({ approvedAt: IN_MONTH, taxable: '10000', commissionAmount: '800', payStatus: 'PAID' });
    await sale({ approvedAt: IN_MONTH, taxable: '5000', commissionAmount: '400', payStatus: 'UNPAID' });

    const body = await statement(sales);

    // Both are earned — commission is struck on approval — but the exposure is
    // stated rather than buried, because it is the cost of that choice.
    expect(body.pay.commission).toBe('1200.00');
    expect(body.pay.commissionUnpaid).toBe('400.00');
  });

  it('does not attribute one rep’s sale to another', async () => {
    await sale({ approvedAt: IN_MONTH, taxable: '10000', commissionAmount: '800', repId: otherId });

    const mine = await statement(sales);
    expect(mine.sales.count).toBe(0);
    expect(mine.pay.commission).toBe('0.00');
  });

  it('converts a foreign-currency sale into CAD before totalling it', async () => {
    const settings = await prisma.settings.findUniqueOrThrow({ where: { id: 1 } });
    const rate = Number((settings.fxRates as Record<string, number>).USD);

    const row = await prisma.submission.create({
      data: {
        ref: `PAYFX-${Date.now()}`,
        status: 'APPROVED',
        repId: salesId,
        contactId: (await prisma.contact.findFirstOrThrow()).id,
        eventId: 'VFW-FW26',
        cityId: (await prisma.event.findUniqueOrThrow({ where: { id: 'VFW-FW26' } })).cityId,
        packageId: 'VFW-BRONZE',
        currency: 'USD',
        packagePrice: '10000', subtotal: '10000', taxable: '10000',
        taxRate: '0', taxAmount: '0', total: '10000', balance: '0',
        payStatus: 'PAID',
        taxCode: (await prisma.taxProfile.findFirstOrThrow()).code,
        commissionPct: '8', commissionAmount: '800',
        approvedAt: IN_MONTH, submittedAt: IN_MONTH,
      },
    });
    litter.push(row.id);

    const body = await statement(sales);
    expect(Number(body.pay.commission)).toBeCloseTo(800 * rate, 2);
  });

  // --- Who may see what ----------------------------------------------------

  it('gives every role their own statement', async () => {
    for (const cookie of [sales, mgr, acct, admin]) {
      await http(app).get(`/api/payroll?month=${MONTH}`).set('Cookie', cookie).expect(200);
    }
  });

  it("refuses a rep someone else's pay", async () => {
    await http(app)
      .get(`/api/payroll?month=${MONTH}&userId=${otherId}`)
      .set('Cookie', sales)
      .expect(403);
  });

  it('refuses a sales manager the run, and the team’s individual pay', async () => {
    // A manager reads the team's hours (attendance.viewTeam) but not their
    // salaries — the one place the two modules deliberately diverge.
    await http(app).get(`/api/payroll/run?month=${MONTH}`).set('Cookie', mgr).expect(403);
    await http(app)
      .get(`/api/payroll?month=${MONTH}&userId=${salesId}`)
      .set('Cookie', mgr)
      .expect(403);
    // But the same manager can still see the team's attendance.
    await http(app).get(`/api/attendance/team?month=${MONTH}`).set('Cookie', mgr).expect(200);
  });

  it('gives Accounting and Admin the whole run', async () => {
    for (const cookie of [acct, admin]) {
      await http(app).get(`/api/payroll/run?month=${MONTH}`).set('Cookie', cookie).expect(200);
    }
  });

  // --- The run -------------------------------------------------------------

  it('totals the run and includes people who earned nothing', async () => {
    await setPay('SALARY', '4000.00');
    await sale({ approvedAt: IN_MONTH, taxable: '10000', commissionAmount: '800' });

    const res = await http(app)
      .get(`/api/payroll/run?month=${MONTH}`)
      .set('Cookie', acct)
      .expect(200);

    const mine = res.body.rows.find((r: { user: { id: string } }) => r.user.id === salesId);
    expect(mine.pay.gross).toBe('4800.00');

    // The person nobody paid is the one who has to be on the list.
    const other = res.body.rows.find((r: { user: { id: string } }) => r.user.id === otherId);
    expect(other).toBeDefined();
    expect(other.pay.gross).toBe('0.00');

    // And the totals really are the sum of the rows, not a second query.
    const summed = res.body.rows.reduce(
      (t: number, r: { pay: { gross: string } }) => t + Number(r.pay.gross),
      0,
    );
    expect(Number(res.body.totals.gross)).toBeCloseTo(summed, 2);
    expect(res.body.totals.people).toBe(res.body.rows.length);
  });

  it('carries the full profile, which is the other half of what the screen is for', async () => {
    const body = await statement(sales);

    expect(body.user.name).toBe('Marielle Fontaine');
    expect(body.user.employeeId).toBe('VFW-1001');
    expect(body.user.department).toBe('Sales');
    expect(body.user.commissionPct).toBe('8.00');
    // Never the hash, and never the raw storage key.
    expect(body.user.passwordHash).toBeUndefined();
    expect(body.user.avatarKey).toBeUndefined();
  });

  // --- Export --------------------------------------------------------------

  it('exports the run to Accounting and refuses everyone else', async () => {
    await setPay('SALARY', '4000.00');

    const file = await http(app)
      .get(`/api/export/payroll?format=csv&month=${MONTH}`)
      .set('Cookie', acct)
      .expect(200);
    expect(file.text).toContain('Marielle Fontaine');
    expect(file.text).toContain('Gross (CAD)');

    await http(app)
      .get(`/api/export/payroll?format=csv&month=${MONTH}`)
      .set('Cookie', sales)
      .expect(403);
    await http(app)
      .get(`/api/export/payroll?format=csv&month=${MONTH}`)
      .set('Cookie', mgr)
      .expect(403);
  });
});
