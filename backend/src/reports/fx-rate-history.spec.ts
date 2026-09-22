import type { INestApplication } from '@nestjs/common';
import { createTestApp, http, loginCookie } from '../../test/app';
import { PrismaService } from '../prisma/prisma.service';

/**
 * FX rate history — the "Decided, not yet built" gap this closes: Settings
 * held one *live* FX snapshot that every report converted through, so an old
 * report silently re-priced itself the moment the rate moved. FxRateSnapshot
 * makes the rate a dated fact instead, and ReportsService resolves the rate
 * that was in force for the period being reported rather than always reading
 * today's Settings.fxRates.
 *
 * These tests drive the real request path — create a booked USD sale, point
 * it at a specific historical date, and prove the CAD figure a report shows
 * for that date depends on the rate that was in force then, not on whatever
 * Settings.fxRates says when the report happens to be run.
 */
describe('FX rate history', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  let sales: string;

  const EVENT = 'VFW-FW26';
  const CITY_ID = 'VAN';
  const CITY_NAME = 'Vancouver';
  const PACKAGE = 'VFW-BRONZE'; // USD 7,700 at VAN — see prisma/seed.ts
  const PACKAGE_PRICE = 7700;

  // Ids this file creates, swept in afterAll — a crashed run leaves nothing
  // behind that a later run, or another spec, could trip over.
  const submissionIds: string[] = [];
  const snapshotIds: string[] = [];
  let originalFxRates: Record<string, number>;
  let originalDiscountPct: string;

  const money = (n: number) => n.toFixed(2);

  /** A fresh APPROVED USD submission, ready to be backdated by the caller. */
  const approvedBronzeSale = async () => {
    const created = await http(app)
      .post('/api/submissions')
      .set('Cookie', sales)
      .send({
        designer: 'FX History Probe',
        brand: `FX Probe ${Date.now()}-${Math.random()}`,
        eventId: EVENT,
        packageId: PACKAGE,
      });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    submissionIds.push(id);

    const approved = await http(app)
      .post(`/api/submissions/${id}/approve`)
      .set('Cookie', admin)
      .send({ glAccount: '4010' });
    expect(approved.status).toBe(201);
    return id;
  };

  /** Point a submission's date at a specific day, so a report's from/to window
   *  finds it — COALESCE(submittedAt, createdAt) is what the report filters on. */
  const backdate = (id: string, isoDate: string) =>
    prisma.submission.update({
      where: { id },
      data: { submittedAt: new Date(`${isoDate}T12:00:00.000Z`) },
    });

  const cityReport = async (from: string, to: string) => {
    const res = await http(app)
      .get(`/api/reports/summary?type=city&from=${from}&to=${to}&eventId=${EVENT}&cityId=${CITY_ID}`)
      .set('Cookie', admin);
    expect(res.status).toBe(200);
    const cols = (res.body.cols as { label: string }[]).map((c) => c.label);
    const netIdx = cols.indexOf('Net (CAD)');
    const row = (res.body.rows as unknown[][]).find((r) => r[0] === CITY_NAME);
    return row ? (row[netIdx] as string) : undefined;
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginCookie(app, 'it@vanfashionweek.com');
    sales = await loginCookie(app, 'marielle@vanfashionweek.com');

    const settings = await prisma.settings.findUniqueOrThrow({ where: { id: 1 } });
    originalFxRates = settings.fxRates as Record<string, number>;
    originalDiscountPct = settings.discountApprovalPct.toFixed(2);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.submission.deleteMany({ where: { id: { in: submissionIds } } });
      await prisma.fxRateSnapshot.deleteMany({ where: { id: { in: snapshotIds } } });
      // Whatever the last test left in Settings, put back exactly what was
      // there before this file touched anything.
      await prisma.settings.update({
        where: { id: 1 },
        data: { fxRates: originalFxRates, discountApprovalPct: originalDiscountPct },
      });
    }
    await app?.close();
  });

  // Runs before any test here mutates Settings.fxRates, so it reads the state
  // the migration's backfill (mirrored for the test database by prisma/seed.ts
  // — see its comment) actually leaves behind, not a state some other test in
  // this file already changed.
  it("the backfill leaves a sane starting snapshot — never 'no history at all'", async () => {
    const history = await prisma.fxRateSnapshot.findMany({ orderBy: { effectiveFrom: 'asc' } });
    expect(history.length).toBeGreaterThan(0);

    const oldest = history[0];
    const rates = oldest.rates as Record<string, number>;
    // CAD is the reporting currency and is always pinned at 1, in every
    // snapshot, the same rule AdminService.updateSettings enforces going
    // forward.
    expect(Number(rates.CAD)).toBe(1);
    expect(typeof rates.USD).toBe('number');
    expect(rates.USD).toBeGreaterThan(0);
    // dated at or before today — a snapshot that claims to take effect in the
    // future could never be "the rate in force" for anything reported so far.
    expect(oldest.effectiveFrom.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('uses the snapshot in force for the period, not the live rate — even months later', async () => {
    // A deliberately old, deliberately unmistakable rate: nothing seeded or
    // written by another spec would plausibly collide with 4.2.
    const OLD_USD_RATE = 4.2;
    const snap = await prisma.fxRateSnapshot.create({
      data: { effectiveFrom: new Date('2020-01-01T00:00:00.000Z'), rates: { ...originalFxRates, USD: OLD_USD_RATE } },
    });
    snapshotIds.push(snap.id);

    // Move the LIVE rate somewhere else entirely, exactly as if Accounting
    // changed it long after March 2020 — this is the numbers-must-not-move
    // property the whole feature exists to guarantee.
    await prisma.settings.update({ where: { id: 1 }, data: { fxRates: { ...originalFxRates, USD: 99 } } });

    const id = await approvedBronzeSale();
    await backdate(id, '2020-03-15');

    const net = await cityReport('2020-03-01', '2020-03-31');
    expect(net).toBe(money(PACKAGE_PRICE * OLD_USD_RATE));
    // Not the live rate that was in Settings when the report was RUN.
    expect(net).not.toBe(money(PACKAGE_PRICE * 99));
  });

  it('falls back to the live rate when no snapshot predates the period', async () => {
    const LIVE_USD_RATE = 7.77;
    await prisma.settings.update({ where: { id: 1 }, data: { fxRates: { ...originalFxRates, USD: LIVE_USD_RATE } } });

    const id = await approvedBronzeSale();
    // 1999 predates every snapshot this file (and the backfill) could ever
    // have created — there is nothing to look up, by construction.
    await backdate(id, '1999-05-01');

    const net = await cityReport('1999-01-01', '1999-12-31');
    expect(net).toBe(money(PACKAGE_PRICE * LIVE_USD_RATE));
  });

  it('editing Settings.fxRates writes a new snapshot — it does not overwrite history', async () => {
    const before = await prisma.fxRateSnapshot.count();

    const NEW_USD_RATE = 5.55;
    const res = await http(app)
      .patch('/api/admin/settings')
      .set('Cookie', admin)
      .send({ fxRates: { ...originalFxRates, USD: NEW_USD_RATE } });
    expect(res.status).toBe(200);
    expect(Number(res.body.fxRates.USD)).toBe(NEW_USD_RATE);

    const after = await prisma.fxRateSnapshot.count();
    expect(after).toBe(before + 1);

    const history = await http(app)
      .get('/api/admin/settings/fx-history')
      .set('Cookie', admin);
    expect(history.status).toBe(200);
    const newest = (history.body as { rates: Record<string, number> }[])[0];
    expect(Number(newest.rates.USD)).toBe(NEW_USD_RATE);
    snapshotIds.push((history.body as { id: string }[])[0].id);

    // A save that never touched fxRates must not manufacture a rate change
    // that never happened. Pick a threshold guaranteed to differ from
    // whatever is currently set, so the update itself is accepted.
    const current = await prisma.settings.findUniqueOrThrow({ where: { id: 1 } });
    const otherPct = current.discountApprovalPct.toFixed(2) === '20.00' ? '25' : '20';
    const untouched = await http(app)
      .patch('/api/admin/settings')
      .set('Cookie', admin)
      .send({ discountApprovalPct: otherPct });
    expect(untouched.status).toBe(200);
    expect(await prisma.fxRateSnapshot.count()).toBe(before + 1);
  });
});
