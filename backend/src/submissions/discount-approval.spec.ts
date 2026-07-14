import type { INestApplication } from '@nestjs/common';
import { createTestApp, http, loginCookie } from '../../test/app';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Settings.discountApprovalPct, enforced. A rep may still propose any discount
 * up to 100% — the gate is Accounting's sign-off, not the rep's keyboard — so
 * these drive the real approve endpoint through the real guard, exactly as
 * acl.spec.ts does, rather than unit-testing the service in isolation.
 *
 * The threshold itself is derived at approval time from the stored money (see
 * PricingService.discountApproval), which is what makes the last case here work
 * with no migration and no backfill.
 */
describe('discount approval threshold', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sales: string;
  let acct: string;
  let originalThreshold: string;

  /** A fresh PENDING submission discounted by `pct`% off the package price. */
  const pending = async (pct: number) => {
    const res = await http(app)
      .post('/api/submissions')
      .set('Cookie', sales)
      .send({
        designer: 'Discount Probe',
        brand: `Discount ${pct}pc ${Date.now()}-${Math.random()}`,
        eventId: 'VFW-FW26',
        packageId: 'VFW-BRONZE',
        discountType: 'PCT',
        discountValue: pct,
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING');
    return res.body.id as string;
  };

  const setThreshold = (pct: string) =>
    prisma.settings.update({ where: { id: 1 }, data: { discountApprovalPct: pct } });

  const auditFor = async (id: string) => {
    const res = await http(app).get(`/api/submissions/${id}/audit`).set('Cookie', acct);
    expect(res.status).toBe(200);
    return res.body as { action: string; detail: string; payload: Record<string, any> }[];
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    sales = await loginCookie(app, 'marielle@vanfashionweek.com');
    acct = await loginCookie(app, 'accounting@vanfashionweek.com');

    const settings = await prisma.settings.findUniqueOrThrow({ where: { id: 1 } });
    originalThreshold = settings.discountApprovalPct.toString();
    // Pin it, so the suite does not depend on whatever the seed happens to set.
    await setThreshold('15');
  });

  afterAll(async () => {
    if (prisma) await setThreshold(originalThreshold);
    await app?.close();
  });

  it('at or under the threshold: approves exactly as before, no new field required', async () => {
    const id = await pending(10);

    const res = await http(app).post(`/api/submissions/${id}/approve`).set('Cookie', acct).send();

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('APPROVED');

    // The audit row is the one it always was — no override noise on a normal sale.
    const [entry] = await auditFor(id);
    expect(entry.action).toBe('APPROVED');
    expect(entry.payload.discountOverride).toBeUndefined();
  });

  it('over the threshold, with no acknowledgment: 400', async () => {
    const id = await pending(25);

    const res = await http(app).post(`/api/submissions/${id}/approve`).set('Cookie', acct).send();

    expect(res.status).toBe(400);
    const msg = JSON.stringify(res.body.message);
    expect(msg).toMatch(/25\.00%/);
    expect(msg).toMatch(/15\.00%/);
    expect(msg).toMatch(/acknowledgeDiscountOverride/);

    // Refused, not half-applied: still pending, and nothing was audited.
    const still = await prisma.submission.findUniqueOrThrow({ where: { id } });
    expect(still.status).toBe('PENDING');
    expect((await auditFor(id)).some((e) => e.action === 'APPROVED')).toBe(false);
  });

  it('over the threshold, acknowledged: 201, and the audit says why sign-off was needed', async () => {
    const id = await pending(25);

    const refused = await http(app)
      .post(`/api/submissions/${id}/approve`)
      .set('Cookie', acct)
      .send({ glAccount: '4050' });
    expect(refused.status).toBe(400);

    // Same submission, same approver — now with the override said out loud.
    const res = await http(app)
      .post(`/api/submissions/${id}/approve`)
      .set('Cookie', acct)
      .send({ glAccount: '4050', acknowledgeDiscountOverride: true });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('APPROVED');

    const [entry] = await auditFor(id);
    expect(entry.action).toBe('APPROVED');
    // Self-explanatory on its face — an accountant reading the trail sees the
    // threshold that was in force and the discount that beat it, not "APPROVED".
    expect(entry.detail).toMatch(/discount override/i);
    expect(entry.detail).toMatch(/25\.00%/);
    expect(entry.detail).toMatch(/15\.00%/);
    expect(entry.payload.discountOverride).toMatchObject({
      thresholdPct: '15.00',
      discountPct: '25.00',
      discountType: 'PCT',
    });
  });

  it('moving the threshold re-judges the next approval — no migration, no backfill', async () => {
    const id = await pending(25);

    // Refused at 15%...
    expect(
      (await http(app).post(`/api/submissions/${id}/approve`).set('Cookie', acct).send()).status,
    ).toBe(400);

    // ...and with Accounting having raised the bar to 30%, the very same
    // submission approves with no acknowledgment at all.
    await setThreshold('30');
    const res = await http(app).post(`/api/submissions/${id}/approve`).set('Cookie', acct).send();

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('APPROVED');
    const [entry] = await auditFor(id);
    expect(entry.payload.discountOverride).toBeUndefined();

    await setThreshold('15');
  });

  it('an AMT discount is judged on its share of the subtotal, not its face value', async () => {
    // The rep keys a flat amount rather than a percentage. VFW-BRONZE is 7,700,
    // so 3,000 off is a 38.96% discount — an AMT discount must not be a way
    // around a threshold expressed in percent.
    const created = await http(app)
      .post('/api/submissions')
      .set('Cookie', sales)
      .send({
        designer: 'Discount Probe',
        brand: `Discount AMT ${Date.now()}-${Math.random()}`,
        eventId: 'VFW-FW26',
        packageId: 'VFW-BRONZE',
        discountType: 'AMT',
        discountValue: 3000,
      });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    const refused = await http(app)
      .post(`/api/submissions/${id}/approve`)
      .set('Cookie', acct)
      .send();
    expect(refused.status).toBe(400);

    const res = await http(app)
      .post(`/api/submissions/${id}/approve`)
      .set('Cookie', acct)
      .send({ acknowledgeDiscountOverride: true });
    expect(res.status).toBe(201);

    const [entry] = await auditFor(id);
    expect(entry.payload.discountOverride).toMatchObject({ discountType: 'AMT' });
  });
});
