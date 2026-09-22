import type { INestApplication } from '@nestjs/common';
import { createTestApp, http, loginCookie } from '../../test/app';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Settings.discountApprovalPct, enforced — and, on top of it, a maker/checker
 * split: a discount past the threshold cannot be approved by one person acting
 * alone. The FIRST approve() call on such a sale only *requests* a second
 * sign-off (200, still PENDING); a SECOND, genuinely different ACCT/ADMIN must
 * call approve() again to actually approve it. The same person cannot be both
 * (400) — that refusal is the core guarantee of the whole feature.
 *
 * These drive the real approve endpoint through the real guard, exactly as
 * acl.spec.ts does, rather than unit-testing the service in isolation.
 *
 * The threshold itself is derived at approval time from the stored money (see
 * PricingService.discountApproval), which is what makes the "moving the
 * threshold" case below work with no migration and no backfill.
 */
describe('discount approval threshold', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sales: string;
  let acct: string;
  let admin: string;
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
    admin = await loginCookie(app, 'it@vanfashionweek.com');

    const settings = await prisma.settings.findUniqueOrThrow({ where: { id: 1 } });
    originalThreshold = settings.discountApprovalPct.toString();
    // Pin it, so the suite does not depend on whatever the seed happens to set.
    await setThreshold('15');
  });

  afterAll(async () => {
    if (prisma) await setThreshold(originalThreshold);
    await app?.close();
  });

  it('at or under the threshold: approves exactly as before, no second sign-off required', async () => {
    const id = await pending(10);

    const res = await http(app).post(`/api/submissions/${id}/approve`).set('Cookie', acct).send();

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('APPROVED');

    // The audit row is the one it always was — no override noise on a normal sale.
    const [entry] = await auditFor(id);
    expect(entry.action).toBe('APPROVED');
    expect(entry.payload.discountOverride).toBeUndefined();
  });

  it('over the threshold: the first approve() call only requests sign-off — 200, still PENDING', async () => {
    const id = await pending(25);

    const res = await http(app)
      .post(`/api/submissions/${id}/approve`)
      .set('Cookie', acct)
      .send({ glAccount: '4050' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.discountOverrideRequestedById).toBeTruthy();
    expect(res.body.discountOverrideRequestedBy).toMatchObject({ name: 'Hannah Okafor' });
    expect(res.body.message).toMatch(/second sign-off|different ACCT\/ADMIN|second approver/i);

    // Refused-not-yet-decided, not half-applied: still pending, and nothing was
    // approved. GL account is untouched too — it is only set once actually approved.
    const still = await prisma.submission.findUniqueOrThrow({ where: { id } });
    expect(still.status).toBe('PENDING');
    expect(still.glCode).not.toBe('4050');
    expect((await auditFor(id)).some((e) => e.action === 'APPROVED')).toBe(false);

    const [entry] = await auditFor(id);
    expect(entry.action).toBe('DISCOUNT_OVERRIDE_REQUESTED');
    expect(entry.detail).toMatch(/25\.00%/);
    expect(entry.detail).toMatch(/15\.00%/);
  });

  it('the SAME user cannot confirm their own override request: 400', async () => {
    const id = await pending(25);

    const first = await http(app).post(`/api/submissions/${id}/approve`).set('Cookie', acct).send();
    expect(first.status).toBe(200);

    const second = await http(app).post(`/api/submissions/${id}/approve`).set('Cookie', acct).send();

    expect(second.status).toBe(400);
    const msg = JSON.stringify(second.body.message);
    expect(msg).toMatch(/different ACCT\/ADMIN|cannot.*confirm|maker.*checker|yourself/i);

    // Still pending, still carrying the original request untouched.
    const still = await prisma.submission.findUniqueOrThrow({ where: { id } });
    expect(still.status).toBe('PENDING');
    expect(still.discountOverrideRequestedById).toBeTruthy();
    expect((await auditFor(id)).some((e) => e.action === 'APPROVED')).toBe(false);
  });

  it('a DIFFERENT user can confirm: 201, approved, and the audit shows both identities', async () => {
    const id = await pending(25);

    const requested = await http(app)
      .post(`/api/submissions/${id}/approve`)
      .set('Cookie', acct)
      .send();
    expect(requested.status).toBe(200);

    // A different approver — admin, not accounting — confirms.
    const confirmed = await http(app)
      .post(`/api/submissions/${id}/approve`)
      .set('Cookie', admin)
      .send({ glAccount: '4050' });

    expect(confirmed.status).toBe(201);
    expect(confirmed.body.status).toBe('APPROVED');
    expect(confirmed.body.glCode).toBe('4050');
    // Resolved — the request markers are cleared once actually approved.
    expect(confirmed.body.discountOverrideRequestedById).toBeNull();

    const [entry] = await auditFor(id);
    expect(entry.action).toBe('APPROVED');
    // The audit trail names BOTH people: who asked, and who confirmed.
    expect(entry.detail).toMatch(/discount override/i);
    expect(entry.detail).toMatch(/25\.00%/);
    expect(entry.detail).toMatch(/15\.00%/);
    expect(entry.detail).toMatch(/Hannah Okafor/); // requested by
    expect(entry.detail).toMatch(/System Administrator/); // confirmed by
    expect(entry.payload.discountOverride).toMatchObject({
      thresholdPct: '15.00',
      discountPct: '25.00',
      discountType: 'PCT',
      requestedBy: { name: 'Hannah Okafor' },
      confirmedBy: { name: 'System Administrator' },
    });
  });

  it('moving the threshold re-judges the next approval — no migration, no backfill', async () => {
    const id = await pending(25);

    // At 15%, the first touch only requests sign-off...
    const requested = await http(app)
      .post(`/api/submissions/${id}/approve`)
      .set('Cookie', acct)
      .send();
    expect(requested.status).toBe(200);
    expect(requested.body.status).toBe('PENDING');

    // ...but with Accounting having raised the bar to 30% before anyone
    // confirms, the very same submission approves outright on the next call —
    // even from the very same user, since it is no longer over threshold at all.
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

    const requested = await http(app)
      .post(`/api/submissions/${id}/approve`)
      .set('Cookie', acct)
      .send();
    expect(requested.status).toBe(200);
    expect(requested.body.status).toBe('PENDING');

    const res = await http(app).post(`/api/submissions/${id}/approve`).set('Cookie', admin).send();
    expect(res.status).toBe(201);

    const [entry] = await auditFor(id);
    expect(entry.payload.discountOverride).toMatchObject({ discountType: 'AMT' });
  });

  it('rejecting a sale awaiting a second sign-off works normally, even for the requester', async () => {
    const id = await pending(25);

    const requested = await http(app)
      .post(`/api/submissions/${id}/approve`)
      .set('Cookie', acct)
      .send();
    expect(requested.status).toBe(200);

    // Rejecting undoes the sale rather than committing it — not gated behind
    // the two-person rule, and the same person who requested the override may
    // do it.
    const rejected = await http(app)
      .post(`/api/submissions/${id}/reject`)
      .set('Cookie', acct)
      .send({ reason: 'Discount exceeds authority' });

    expect(rejected.status).toBe(201);
    expect(rejected.body.status).toBe('REJECTED');
    expect(rejected.body.discountOverrideRequestedById).toBeNull();
  });

  it('returning a sale awaiting a second sign-off works normally, and clears the request', async () => {
    const id = await pending(25);

    const requested = await http(app)
      .post(`/api/submissions/${id}/approve`)
      .set('Cookie', acct)
      .send();
    expect(requested.status).toBe(200);

    const returned = await http(app)
      .post(`/api/submissions/${id}/return`)
      .set('Cookie', acct)
      .send({ note: 'Please re-check pricing with the client' });

    expect(returned.status).toBe(201);
    expect(returned.body.status).toBe('RETURNED');
    expect(returned.body.discountOverrideRequestedById).toBeNull();
  });
});
