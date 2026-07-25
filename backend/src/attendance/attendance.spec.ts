import type { INestApplication } from '@nestjs/common';
import { createTestApp, http, loginCookie } from '../../test/app';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Attendance, through the real request path.
 *
 * The property that matters here is not "the save works" — it is who a save is
 * *about*. A timesheet is the record hours are approved and eventually paid
 * from, so the two failures worth holding a test against are a rep reading a
 * colleague's hours and a rep writing their manager's. Both are one missing
 * check away, because the subject arrives in the request body.
 */

const ADMIN = 'it@vanfashionweek.com';
const MGR = 'sales.director@vanfashionweek.com';
const SALES = 'marielle@vanfashionweek.com';
const OTHER_SALES = 'diego@vanfashionweek.com';

// A month far enough from today that nothing else in the suite collides with it.
const MONTH = '2031-03';
const DAY = `${MONTH}-04`;

describe('attendance', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  let mgr: string;
  let sales: string;
  let salesId: string;
  let otherId: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginCookie(app, ADMIN);
    mgr = await loginCookie(app, MGR);
    sales = await loginCookie(app, SALES);

    salesId = (await prisma.user.findUniqueOrThrow({ where: { email: SALES } })).id;
    otherId = (await prisma.user.findUniqueOrThrow({ where: { email: OTHER_SALES } })).id;
  });

  afterEach(async () => {
    await prisma.attendanceEntry.deleteMany({
      where: { date: { gte: new Date('2031-03-01'), lt: new Date('2031-04-01') } },
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  // --- Marking your own ----------------------------------------------------

  it('records a day and totals it into the month', async () => {
    await http(app)
      .put(`/api/attendance/${DAY}`)
      .set('Cookie', sales)
      .send({ status: 'PRESENT', checkIn: '09:00', checkOut: '17:30' })
      .expect(200);

    const res = await http(app)
      .get(`/api/attendance?month=${MONTH}`)
      .set('Cookie', sales)
      .expect(200);

    expect(res.body.self).toBe(true);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].date).toBe(DAY);
    expect(res.body.entries[0].hours).toBe('8.5');
    expect(res.body.summary.daysWorked).toBe(1);
    expect(res.body.summary.hours).toBe('8.50');
  });

  it('lets the times override a stale total rather than contradicting them', async () => {
    const res = await http(app)
      .put(`/api/attendance/${DAY}`)
      .set('Cookie', sales)
      // A form that still holds yesterday's 3 hours while the times say 8.
      .send({ status: 'PRESENT', hours: '3', checkIn: '09:00', checkOut: '17:00' })
      .expect(200);

    expect(res.body.hours).toBe('8');
  });

  it('takes a typed total when there are no times to work it out from', async () => {
    const res = await http(app)
      .put(`/api/attendance/${DAY}`)
      .set('Cookie', sales)
      .send({ status: 'REMOTE', hours: '6.25' })
      .expect(200);

    expect(res.body.hours).toBe('6.25');
    expect(res.body.checkIn).toBeNull();
  });

  it('keeps one row per day — marking the same day again rewrites it', async () => {
    await http(app).put(`/api/attendance/${DAY}`).set('Cookie', sales)
      .send({ status: 'PRESENT', hours: '8' }).expect(200);
    await http(app).put(`/api/attendance/${DAY}`).set('Cookie', sales)
      .send({ status: 'SICK', hours: '0' }).expect(200);

    const res = await http(app).get(`/api/attendance?month=${MONTH}`).set('Cookie', sales).expect(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].status).toBe('SICK');
    expect(res.body.summary.daysWorked).toBe(0);
  });

  it('refuses hours outside a day', async () => {
    await http(app).put(`/api/attendance/${DAY}`).set('Cookie', sales)
      .send({ status: 'PRESENT', hours: '30' }).expect(400);
  });

  it('refuses a date that is not a date', async () => {
    await http(app).put('/api/attendance/not-a-day').set('Cookie', sales)
      .send({ status: 'PRESENT', hours: '8' }).expect(400);
  });

  // --- Clocking ------------------------------------------------------------

  it('clocks in, then out, and settles the hours from the pair', async () => {
    await http(app).post('/api/attendance/clock-in').set('Cookie', sales)
      .send({ date: DAY, time: '08:45' }).expect(201);

    // Clocking in twice must not quietly move the start time.
    await http(app).post('/api/attendance/clock-in').set('Cookie', sales)
      .send({ date: DAY, time: '10:00' }).expect(400);

    const out = await http(app).post('/api/attendance/clock-out').set('Cookie', sales)
      .send({ date: DAY, time: '17:15' }).expect(201);

    expect(out.body.checkIn).toBe('08:45');
    expect(out.body.hours).toBe('8.5');
  });

  it('will not clock out of a day that was never started', async () => {
    await http(app).post('/api/attendance/clock-out').set('Cookie', sales)
      .send({ date: DAY, time: '17:00' }).expect(400);
  });

  // --- Scoping -------------------------------------------------------------

  it("refuses a rep someone else's sheet", async () => {
    await http(app)
      .get(`/api/attendance?month=${MONTH}&userId=${otherId}`)
      .set('Cookie', sales)
      .expect(403);
  });

  it("refuses a rep a write to someone else's sheet", async () => {
    await http(app)
      .put(`/api/attendance/${DAY}`)
      .set('Cookie', sales)
      .send({ status: 'PRESENT', hours: '8', userId: otherId })
      .expect(403);

    expect(await prisma.attendanceEntry.count({ where: { userId: otherId } })).toBe(0);
  });

  it('refuses a rep the team roll-up', async () => {
    await http(app).get(`/api/attendance/team?month=${MONTH}`).set('Cookie', sales).expect(403);
  });

  it('lets a manager read and correct a rep, and says who corrected it', async () => {
    await http(app).put(`/api/attendance/${DAY}`).set('Cookie', sales)
      .send({ status: 'PRESENT', hours: '8' }).expect(200);

    const corrected = await http(app)
      .put(`/api/attendance/${DAY}`)
      .set('Cookie', mgr)
      .send({ status: 'PRESENT', hours: '6', userId: salesId })
      .expect(200);

    expect(corrected.body.hours).toBe('6');
    expect(corrected.body.correctedBy?.name).toBe('Marcus Bell');

    // And the rep sees the correction attributed on their own sheet.
    const own = await http(app).get(`/api/attendance?month=${MONTH}`).set('Cookie', sales).expect(200);
    expect(own.body.entries[0].correctedBy?.name).toBe('Marcus Bell');
  });

  it('writes a correction to the audit trail, but not a self-report', async () => {
    const since = new Date();

    await http(app).put(`/api/attendance/${DAY}`).set('Cookie', sales)
      .send({ status: 'PRESENT', hours: '8' }).expect(200);
    expect(
      await prisma.auditEntry.count({
        where: { action: 'ATTENDANCE_CORRECTED', createdAt: { gte: since } },
      }),
    ).toBe(0);

    await http(app).put(`/api/attendance/${DAY}`).set('Cookie', mgr)
      .send({ status: 'PRESENT', hours: '6', userId: salesId }).expect(200);
    expect(
      await prisma.auditEntry.count({
        where: { action: 'ATTENDANCE_CORRECTED', createdAt: { gte: since } },
      }),
    ).toBe(1);
  });

  it('rolls the month up per person, including people who recorded nothing', async () => {
    await http(app).put(`/api/attendance/${DAY}`).set('Cookie', sales)
      .send({ status: 'PRESENT', hours: '8' }).expect(200);

    const res = await http(app).get(`/api/attendance/team?month=${MONTH}`).set('Cookie', mgr).expect(200);

    const marked = res.body.rows.find((r: { user: { id: string } }) => r.user.id === salesId);
    const unmarked = res.body.rows.find((r: { user: { id: string } }) => r.user.id === otherId);

    expect(marked.summary.hours).toBe('8.00');
    // The person a manager opened the screen to find is the one with nothing on
    // it, so an absent row is worse than useless — it is invisible.
    expect(unmarked).toBeDefined();
    expect(unmarked.summary.days).toBe(0);
  });

  // --- Clearing ------------------------------------------------------------

  it('clears a day, which is not the same as marking it absent', async () => {
    await http(app).put(`/api/attendance/${DAY}`).set('Cookie', sales)
      .send({ status: 'PRESENT', hours: '8' }).expect(200);

    await http(app).delete(`/api/attendance/${DAY}`).set('Cookie', sales).expect(200);

    const res = await http(app).get(`/api/attendance?month=${MONTH}`).set('Cookie', sales).expect(200);
    expect(res.body.entries).toHaveLength(0);
  });

  it('404s a day that was never recorded', async () => {
    await http(app).delete(`/api/attendance/${DAY}`).set('Cookie', sales).expect(404);
  });

  // --- Export --------------------------------------------------------------

  it('exports the month a caller may see, and only that', async () => {
    await http(app).put(`/api/attendance/${DAY}`).set('Cookie', sales)
      .send({ status: 'PRESENT', checkIn: '09:00', checkOut: '17:00' }).expect(200);

    const own = await http(app)
      .get(`/api/export/attendance?format=csv&month=${MONTH}`)
      .set('Cookie', sales)
      .expect(200);
    expect(own.text).toContain(DAY);
    expect(own.text).toContain('Marielle Fontaine');

    // The dataset routes through the same service, so the scoping travels with it.
    await http(app)
      .get(`/api/export/attendance?format=csv&month=${MONTH}&userId=${otherId}`)
      .set('Cookie', sales)
      .expect(403);

    await http(app)
      .get(`/api/export/attendance-team?format=csv&month=${MONTH}`)
      .set('Cookie', sales)
      .expect(403);
    await http(app)
      .get(`/api/export/attendance-team?format=csv&month=${MONTH}`)
      .set('Cookie', admin)
      .expect(200);
  });
});
