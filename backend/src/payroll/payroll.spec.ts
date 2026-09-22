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
const FROM = '2032-05-01';
const TO = '2032-05-31';
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
    /** Whose sale it was. Only the per-client breakdown cares which. */
    contactId?: string;
  }) => {
    const row = await prisma.submission.create({
      data: {
        ref: `PAY-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        status: 'APPROVED',
        repId: over.repId ?? salesId,
        contactId: over.contactId ?? (await prisma.contact.findFirstOrThrow()).id,
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
      .get(`/api/payroll?from=${FROM}&to=${TO}` + (userId ? `&userId=${userId}` : ''))
      .set('Cookie', cookie)
      .expect(200);
    return res.body;
  };

  /** Replaces the whole commission-tier table for one test. Restored to the
   *  seeded placeholder in `afterEach`. */
  const setTiers = async (rows: { thresholdRevenue: string; bonusPct: string }[]) => {
    await prisma.commissionTier.deleteMany({});
    for (const row of rows) {
      await prisma.commissionTier.create({ data: row });
    }
  };
  let seededTiers: { thresholdRevenue: string; bonusPct: string }[];

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginCookie(app, ADMIN);
    acct = await loginCookie(app, ACCT);
    mgr = await loginCookie(app, MGR);
    sales = await loginCookie(app, SALES);
    salesId = (await prisma.user.findUniqueOrThrow({ where: { email: SALES } })).id;
    otherId = (await prisma.user.findUniqueOrThrow({ where: { email: OTHER_SALES } })).id;

    const tiers = await prisma.commissionTier.findMany();
    seededTiers = tiers.map((t) => ({
      thresholdRevenue: t.thresholdRevenue.toFixed(2),
      bonusPct: t.bonusPct.toFixed(2),
    }));
  });

  afterEach(async () => {
    if (litter.length) {
      await prisma.submission.deleteMany({ where: { id: { in: litter.splice(0) } } });
    }
    await prisma.attendanceEntry.deleteMany({
      where: { date: { gte: new Date('2032-05-01'), lt: new Date('2032-06-01') } },
    });
    await setPay('COMMISSION_ONLY', '0');
    await setTiers(seededTiers);
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

  // --- Commission tiers ------------------------------------------------------
  //
  // The bonus layer on top of the commission above — see the schema comment on
  // CommissionTier. Computed fresh at aggregation time from the same
  // `sales.revenue` commission itself is struck on; never by touching a sale's
  // stamped `commissionPct`/`commissionAmount`.
  describe('commission tiers', () => {
    // `submitMine` refuses a period that has not finished yet, and this file's
    // shared 2032-05 is deliberately in the future (for isolation from every
    // other suite) — so the two tests below that actually submit a period use
    // a month of their own, safely in the past, rather than the shared one.
    const FROZEN_FROM = '2020-02-01';
    const FROZEN_TO = '2020-02-29';
    const FROZEN_IN_MONTH = new Date('2020-02-14T12:00:00Z');

    beforeEach(() =>
      setTiers([
        { thresholdRevenue: '0', bonusPct: '0' },
        { thresholdRevenue: '50000', bonusPct: '2' },
      ]),
    );

    afterEach(() =>
      prisma.payrollInvoice.deleteMany({
        where: {
          userId: salesId,
          periodStart: new Date(`${FROZEN_FROM}T00:00:00Z`),
          periodEnd: new Date(`${FROZEN_TO}T00:00:00Z`),
        },
      }),
    );

    it('gives no tier bonus to a rep whose revenue never crosses a threshold', async () => {
      await sale({ approvedAt: IN_MONTH, taxable: '10000', commissionAmount: '800' });

      const body = await statement(sales);

      expect(body.pay.tierBonus).toBe('0.00');
      // Nothing to show, not a bracket that earned $0.00 — this is what lets
      // the screens omit the whole line rather than printing a stray zero.
      expect(body.pay.tierBonusBreakdown).toEqual([]);
      expect(body.pay.gross).toBe('800.00'); // base 0 + commission 800 + tier bonus 0
    });

    it('gives the right progressive bonus to a rep who crosses a threshold', async () => {
      // 60,000 net revenue: the first 50,000 earns nothing, the 10,000 above it
      // earns +2% — a $200 bonus, not 2% of the whole 60,000.
      await sale({ approvedAt: IN_MONTH, taxable: '60000', commissionAmount: '4800' });

      const body = await statement(sales);

      expect(body.sales.revenue).toBe('60000.00');
      expect(body.pay.tierBonus).toBe('200.00');
      expect(body.pay.tierBonusBreakdown).toEqual([
        { thresholdRevenue: '50000.00', bonusPct: '2.00', portion: '10000.00', amount: '200.00' },
      ]);
      // Additive, on top of the ordinary commission — never folded into it.
      expect(body.pay.commission).toBe('4800.00');
      expect(body.pay.gross).toBe('5000.00'); // 0 base + 4800 commission + 200 tier bonus
    });

    it('never rewrites the per-sale commission — only the aggregate bonus moves', async () => {
      const id = await sale({ approvedAt: IN_MONTH, taxable: '60000', commissionAmount: '4800' });

      await statement(sales);

      const row = await prisma.submission.findUniqueOrThrow({ where: { id } });
      expect(row.commissionPct.toFixed(2)).toBe('8.00');
      expect(row.commissionAmount.toFixed(2)).toBe('4800.00');
    });

    it("does not let one rep's revenue push another rep into a tier", async () => {
      await sale({ approvedAt: IN_MONTH, taxable: '60000', commissionAmount: '4800', repId: otherId });

      const mine = await statement(sales);
      expect(mine.pay.tierBonus).toBe('0.00');
    });

    it('adds the run\'s tier bonuses into the run total, alongside everyone else\'s', async () => {
      await sale({ approvedAt: IN_MONTH, taxable: '60000', commissionAmount: '4800' });

      const res = await http(app)
        .get(`/api/payroll/run?from=${FROM}&to=${TO}`)
        .set('Cookie', acct)
        .expect(200);

      const mine = res.body.rows.find((r: { user: { id: string } }) => r.user.id === salesId);
      expect(mine.pay.tierBonus).toBe('200.00');
      expect(Number(res.body.totals.tierBonus)).toBeCloseTo(200, 2);
      // The run's own gross total already includes it — not a figure sitting
      // outside the sum the run signs off from.
      const summedGross = res.body.rows.reduce(
        (t: number, r: { pay: { gross: string } }) => t + Number(r.pay.gross),
        0,
      );
      expect(Number(res.body.totals.gross)).toBeCloseTo(summedGross, 2);
    });

    it("freezes a submitted invoice's tier bonus — editing the tier table afterwards does not move it", async () => {
      await sale({ approvedAt: FROZEN_IN_MONTH, taxable: '60000', commissionAmount: '4800' });

      const submitted = await http(app)
        .post('/api/payroll/submit')
        .set('Cookie', sales)
        .send({ from: FROZEN_FROM, to: FROZEN_TO })
        .expect(201);
      // The invoice comes back as the raw Prisma row (see main.ts's Decimal
      // toJSON), which drops trailing zeros — Number() sidesteps that rather
      // than asserting an exact string shape unrelated to what this test cares
      // about.
      expect(Number(submitted.body.tierBonus)).toBeCloseTo(200, 2);
      expect(Number(submitted.body.gross)).toBeCloseTo(5000, 2);

      // Administration tunes the table after the period was already claimed —
      // a much richer bonus, the way tuning a placeholder for real numbers
      // would look.
      await setTiers([
        { thresholdRevenue: '0', bonusPct: '0' },
        { thresholdRevenue: '50000', bonusPct: '10' },
      ]);

      // The frozen invoice is untouched...
      const mine = await http(app).get('/api/payroll/invoices/mine').set('Cookie', sales).expect(200);
      const invoice = mine.body.find((i: { id: string }) => i.id === submitted.body.id);
      expect(Number(invoice.tierBonus)).toBeCloseTo(200, 2);
      expect(Number(invoice.gross)).toBeCloseTo(5000, 2);

      // ...while the live statement now reflects the new table, the same way
      // an edited rate moves the next sale and not one already booked. Read
      // directly rather than through the shared `statement()` helper, which
      // is pinned to this file's 2032 period, not this test's own.
      const liveRes = await http(app)
        .get(`/api/payroll?from=${FROZEN_FROM}&to=${FROZEN_TO}`)
        .set('Cookie', sales)
        .expect(200);
      // `pay.*` is formatted server-side (`.toFixed(2)`), so this one is an
      // exact string; `invoice.*` is the same raw row as above.
      expect(liveRes.body.pay.tierBonus).toBe('1000.00'); // 10% of the 10,000 above 50,000
      expect(Number(liveRes.body.invoice.tierBonus)).toBeCloseTo(200, 2); // the frozen snapshot, unchanged
    });

    it("an admin correction to base/commission re-sums gross without moving the frozen tier bonus", async () => {
      await sale({ approvedAt: FROZEN_IN_MONTH, taxable: '60000', commissionAmount: '4800' });

      const submitted = await http(app)
        .post('/api/payroll/submit')
        .set('Cookie', sales)
        .send({ from: FROZEN_FROM, to: FROZEN_TO })
        .expect(201);
      expect(Number(submitted.body.tierBonus)).toBeCloseTo(200, 2);

      const edited = await http(app)
        .patch(`/api/payroll/invoices/${submitted.body.id}`)
        .set('Cookie', acct)
        .send({ base: 100, commission: 4800, note: 'Manual base correction' })
        .expect(200);

      expect(Number(edited.body.tierBonus)).toBeCloseTo(200, 2); // untouched by the edit
      expect(Number(edited.body.gross)).toBeCloseTo(5100, 2); // 100 + 4800 + 200
    });
  });

  // --- Who may see what ----------------------------------------------------

  it('gives every role their own statement', async () => {
    for (const cookie of [sales, mgr, acct, admin]) {
      await http(app).get(`/api/payroll?from=${FROM}&to=${TO}`).set('Cookie', cookie).expect(200);
    }
  });

  it("refuses a rep someone else's pay", async () => {
    await http(app)
      .get(`/api/payroll?from=${FROM}&to=${TO}&userId=${otherId}`)
      .set('Cookie', sales)
      .expect(403);
  });

  it('refuses a sales manager the run, and the team’s individual pay', async () => {
    // A manager reads the team's hours (attendance.viewTeam) but not their
    // salaries — the one place the two modules deliberately diverge.
    await http(app).get(`/api/payroll/run?from=${FROM}&to=${TO}`).set('Cookie', mgr).expect(403);
    await http(app)
      .get(`/api/payroll?from=${FROM}&to=${TO}&userId=${salesId}`)
      .set('Cookie', mgr)
      .expect(403);
    // But the same manager can still see the team's attendance.
    await http(app).get(`/api/attendance/team?month=${MONTH}`).set('Cookie', mgr).expect(200);
  });

  it('gives Accounting and Admin the whole run', async () => {
    for (const cookie of [acct, admin]) {
      await http(app).get(`/api/payroll/run?from=${FROM}&to=${TO}`).set('Cookie', cookie).expect(200);
    }
  });

  // --- The run -------------------------------------------------------------

  it('totals the run and includes people who earned nothing', async () => {
    await setPay('SALARY', '4000.00');
    await sale({ approvedAt: IN_MONTH, taxable: '10000', commissionAmount: '800' });

    const res = await http(app)
      .get(`/api/payroll/run?from=${FROM}&to=${TO}`)
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

  // --- Sales behind the commission -----------------------------------------

  /**
   * `GET /api/payroll/sales` — the panel under a statement, and the same panel
   * under a user's details in Administration. One endpoint for both, so the two
   * screens cannot disagree; these tests are what holds it to the *statement's*
   * definition of the period rather than growing its own.
   */
  describe('the sales behind a period', () => {
    const salesPanel = async (cookie: string, q: string, code = 200) => {
      const res = await http(app).get(`/api/payroll/sales?${q}`).set('Cookie', cookie).expect(code);
      return res.body;
    };

    it('breaks the period down by client, biggest first', async () => {
      const [first, second] = await prisma.contact.findMany({ take: 2, orderBy: { brand: 'asc' } });

      await sale({ approvedAt: IN_MONTH, taxable: '4000', commissionAmount: '320', contactId: first.id });
      await sale({ approvedAt: IN_MONTH, taxable: '1000', commissionAmount: '80', contactId: first.id });
      await sale({ approvedAt: IN_MONTH, taxable: '9000', commissionAmount: '720', contactId: second.id });

      const body = await salesPanel(sales, `from=${FROM}&to=${TO}`);

      expect(body.count).toBe(3);
      expect(body.revenue).toBe('14000.00');
      expect(body.commission).toBe('1120.00');

      // Two clients, not three rows: the two sales to the same contact are one
      // customer who bought twice, which is the whole point of the breakdown.
      expect(body.clients).toHaveLength(2);
      expect(body.clients[0]).toMatchObject({ brand: second.brand, deals: 1, revenue: '9000.00' });
      expect(body.clients[1]).toMatchObject({ brand: first.brand, deals: 2, revenue: '5000.00' });
    });

    it('agrees with the statement it sits under, period for period', async () => {
      await sale({ approvedAt: IN_MONTH, taxable: '10000', commissionAmount: '800' });
      await sale({ approvedAt: NEXT_MONTH, taxable: '50000', commissionAmount: '4000' });

      const sheet = await statement(sales);
      const panel = await salesPanel(sales, `from=${FROM}&to=${TO}`);

      expect(panel.count).toBe(sheet.sales.count);
      expect(panel.revenue).toBe(sheet.sales.revenue);
      expect(panel.commission).toBe(sheet.pay.commission);

      // And the month next door is genuinely reachable, with its own figures —
      // this is what lets the screens step back through a full history.
      const next = await salesPanel(sales, 'from=2032-06-01&to=2032-06-30');
      expect(next.from).toBe('2032-06-01');
      expect(next.to).toBe('2032-06-30');
      expect(next.revenue).toBe('50000.00');
    });

    it('reports an empty period rather than refusing it', async () => {
      const body = await salesPanel(sales, 'from=2032-11-01&to=2032-11-30');

      expect(body).toMatchObject({
        from: '2032-11-01', to: '2032-11-30', count: 0, revenue: '0.00', clients: [],
      });
      // The rate on the account still comes back — the panel shows what the next
      // sale would earn even when the period itself is empty.
      expect(body.commissionPct).toBe('8.00');
    });

    it('refuses a period whose bounds are not real dates', async () => {
      await salesPanel(sales, 'from=May&to=2032-05-31', 400);
    });

    it('refuses a lone `from` with no `to`', async () => {
      await salesPanel(sales, `from=${FROM}`, 400);
    });

    it("is your own by default, and somebody else's only with payroll.viewAll", async () => {
      await sale({ approvedAt: IN_MONTH, taxable: '10000', commissionAmount: '800' });

      // Marielle, asking for nobody in particular, gets herself.
      const own = await salesPanel(sales, `from=${FROM}&to=${TO}`);
      expect(own.user.id).toBe(salesId);

      // A manager may read the team's hours but not what they sold for.
      await salesPanel(mgr, `from=${FROM}&to=${TO}&userId=${salesId}`, 403);
      await salesPanel(sales, `from=${FROM}&to=${TO}&userId=${otherId}`, 403);

      for (const cookie of [acct, admin]) {
        const body = await salesPanel(cookie, `from=${FROM}&to=${TO}&userId=${salesId}`);
        expect(body.user.id).toBe(salesId);
        expect(body.revenue).toBe('10000.00');
      }
    });

    it('404s on an account that is not there', async () => {
      await salesPanel(admin, `from=${FROM}&to=${TO}&userId=not-a-real-id`, 404);
    });
  });

  // --- Export --------------------------------------------------------------

  it('exports one period of sales by client, under the same scoping as the screen', async () => {
    const contact = await prisma.contact.findFirstOrThrow();
    await sale({ approvedAt: IN_MONTH, taxable: '10000', commissionAmount: '800', contactId: contact.id });

    // Your own needs no extra permission — it is the panel you were already reading.
    const file = await http(app)
      .get(`/api/export/user-sales?format=csv&from=${FROM}&to=${TO}`)
      .set('Cookie', sales)
      .expect(200);
    expect(file.text).toContain('Net revenue (CAD)');
    expect(file.text).toContain(contact.brand);
    // Every row says whose period and which one, so several can be stacked.
    expect(file.text).toContain(FROM);
    expect(file.text).toContain('Marielle Fontaine');

    // Somebody else's is refused exactly where the screen would refuse it.
    await http(app)
      .get(`/api/export/user-sales?format=csv&from=${FROM}&to=${TO}&userId=${otherId}`)
      .set('Cookie', sales)
      .expect(403);
    await http(app)
      .get(`/api/export/user-sales?format=csv&from=${FROM}&to=${TO}&userId=${salesId}`)
      .set('Cookie', acct)
      .expect(200);
  });

  it('exports the run to Accounting and refuses everyone else', async () => {
    await setPay('SALARY', '4000.00');

    const file = await http(app)
      .get(`/api/export/payroll?format=csv&from=${FROM}&to=${TO}`)
      .set('Cookie', acct)
      .expect(200);
    expect(file.text).toContain('Marielle Fontaine');
    expect(file.text).toContain('Gross (CAD)');

    await http(app)
      .get(`/api/export/payroll?format=csv&from=${FROM}&to=${TO}`)
      .set('Cookie', sales)
      .expect(403);
    await http(app)
      .get(`/api/export/payroll?format=csv&from=${FROM}&to=${TO}`)
      .set('Cookie', mgr)
      .expect(403);
  });
});
