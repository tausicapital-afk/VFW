import type { INestApplication } from '@nestjs/common';
import { createTestApp, http, loginCookie } from '../../../test/app';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Payment plans, driven through the real endpoints and the real guard — the same
 * approach acl.spec.ts and discount-approval.spec.ts take, because the two
 * things worth proving here (the plan ties out to the balance; marking one done
 * moves real money) only exist once the request has been through validation,
 * authorization and PricingService.
 */
describe('installment plans', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sales: string;
  let acct: string;

  /** A fresh PENDING submission on the 7,700 bronze package. */
  const pending = async () => {
    const res = await http(app)
      .post('/api/submissions')
      .set('Cookie', sales)
      .send({
        designer: 'Instalment Probe',
        brand: `Instalments ${Date.now()}-${Math.random()}`,
        eventId: 'VFW-FW26',
        packageId: 'VFW-BRONZE',
      });
    expect(res.status).toBe(201);
    return res.body as { id: string; balance: string; total: string; currency: string };
  };

  const sale = async (id: string, cookie = acct) => {
    const res = await http(app).get(`/api/submissions/${id}`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.body;
  };

  /** Split `balance` into n equal instalments, last one absorbing the remainder. */
  const evenLines = (balance: string, n: number) => {
    const cents = Math.round(Number(balance) * 100);
    const each = Math.floor(cents / n);
    return Array.from({ length: n }, (_, i) => ({
      label: `Instalment ${i + 1}`,
      dueDate: `2026-${String(8 + i).padStart(2, '0')}-01`,
      amount: (i === n - 1 ? cents - each * (n - 1) : each) / 100,
    }));
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    sales = await loginCookie(app, 'marielle@vanfashionweek.com');
    acct = await loginCookie(app, 'accounting@vanfashionweek.com');
  });

  afterAll(async () => {
    await app?.close();
  });

  it('refuses a plan that does not add up to the balance', async () => {
    const s = await pending();

    const short = await http(app)
      .put(`/api/submissions/${s.id}/installments`)
      .set('Cookie', acct)
      .send({ installments: [{ dueDate: '2026-08-01', amount: 100 }] });

    expect(short.status).toBe(400);
    expect(JSON.stringify(short.body.message)).toMatch(/short/);
    // Refused, not half-written.
    expect(await prisma.installment.count({ where: { submissionId: s.id } })).toBe(0);
  });

  it('accepts a plan that ties out, and numbers it from 1', async () => {
    const s = await pending();

    const res = await http(app)
      .put(`/api/submissions/${s.id}/installments`)
      .set('Cookie', acct)
      .send({ installments: evenLines(s.balance, 3) });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.body.map((i: any) => i.seq)).toEqual([1, 2, 3]);
    expect(res.body.every((i: any) => i.status === 'PENDING')).toBe(true);

    const total = res.body.reduce((t: number, i: any) => t + Number(i.amount), 0);
    expect(total.toFixed(2)).toBe(Number(s.balance).toFixed(2));
    // Currency is taken from the sale, never from the client.
    expect(res.body.every((i: any) => i.currency === s.currency)).toBe(true);
  });

  it('marking one done posts a payment and moves the balance', async () => {
    const s = await pending();
    const lines = evenLines(s.balance, 2);
    const plan = await http(app)
      .put(`/api/submissions/${s.id}/installments`)
      .set('Cookie', acct)
      .send({ installments: lines });
    expect(plan.status).toBe(200);

    const first = plan.body[0];
    const marked = await http(app)
      .post(`/api/submissions/${s.id}/installments/${first.id}/mark`)
      .set('Cookie', acct)
      .send({ reference: 'WIRE-1' });

    expect(marked.status).toBe(201);
    expect(marked.body[0].status).toBe('PAID');
    expect(marked.body[0].paidBy.name).toBeTruthy();
    expect(marked.body[1].status).toBe('PENDING');

    const after = await sale(s.id);
    expect(Number(after.paidAmount).toFixed(2)).toBe(Number(first.amount).toFixed(2));
    expect(Number(after.balance).toFixed(2)).toBe(
      (Number(s.balance) - Number(first.amount)).toFixed(2),
    );
    expect(after.payStatus).toBe('PARTIAL');
    // The money landed on the ledger, not in a private field on the instalment.
    expect(after.payments).toHaveLength(1);
    expect(after.payments[0].reference).toBe('WIRE-1');
    // ...and the remaining pending instalments still sum to the new balance.
    const stillDue = after.installments
      .filter((i: any) => i.status === 'PENDING')
      .reduce((t: number, i: any) => t + Number(i.amount), 0);
    expect(stillDue.toFixed(2)).toBe(Number(after.balance).toFixed(2));
  });

  it('marking the last one settles the sale', async () => {
    const s = await pending();
    const plan = await http(app)
      .put(`/api/submissions/${s.id}/installments`)
      .set('Cookie', acct)
      .send({ installments: evenLines(s.balance, 2) });

    for (const inst of plan.body) {
      const res = await http(app)
        .post(`/api/submissions/${s.id}/installments/${inst.id}/mark`)
        .set('Cookie', acct)
        .send();
      expect(res.status).toBe(201);
    }

    const after = await sale(s.id);
    expect(after.payStatus).toBe('PAID');
    expect(Number(after.balance)).toBe(0);
  });

  it('marking the same instalment twice is refused', async () => {
    const s = await pending();
    const plan = await http(app)
      .put(`/api/submissions/${s.id}/installments`)
      .set('Cookie', acct)
      .send({ installments: evenLines(s.balance, 2) });
    const first = plan.body[0];

    expect(
      (
        await http(app)
          .post(`/api/submissions/${s.id}/installments/${first.id}/mark`)
          .set('Cookie', acct)
          .send()
      ).status,
    ).toBe(201);

    const again = await http(app)
      .post(`/api/submissions/${s.id}/installments/${first.id}/mark`)
      .set('Cookie', acct)
      .send();
    expect(again.status).toBe(400);

    // One payment, not two.
    expect(await prisma.payment.count({ where: { submissionId: s.id } })).toBe(1);
  });

  it('undoing a mark reverses with a negative entry rather than deleting one', async () => {
    const s = await pending();
    const plan = await http(app)
      .put(`/api/submissions/${s.id}/installments`)
      .set('Cookie', acct)
      .send({ installments: evenLines(s.balance, 2) });
    const first = plan.body[0];

    await http(app)
      .post(`/api/submissions/${s.id}/installments/${first.id}/mark`)
      .set('Cookie', acct)
      .send();

    const undone = await http(app)
      .post(`/api/submissions/${s.id}/installments/${first.id}/unmark`)
      .set('Cookie', acct)
      .send();
    expect(undone.status).toBe(201);
    expect(undone.body[0].status).toBe('PENDING');
    expect(undone.body[0].paidAt).toBeNull();

    const after = await sale(s.id);
    // Both entries survive: the original and its reversal.
    expect(after.payments).toHaveLength(2);
    expect(Number(after.payments[1].amount)).toBe(-Number(first.amount));
    expect(Number(after.balance).toFixed(2)).toBe(Number(s.balance).toFixed(2));
    expect(after.payStatus).toBe('UNPAID');
  });

  it('a replacement plan keeps paid instalments and numbers the rest after them', async () => {
    const s = await pending();
    const plan = await http(app)
      .put(`/api/submissions/${s.id}/installments`)
      .set('Cookie', acct)
      .send({ installments: evenLines(s.balance, 2) });
    const first = plan.body[0];

    await http(app)
      .post(`/api/submissions/${s.id}/installments/${first.id}/mark`)
      .set('Cookie', acct)
      .send();

    const remaining = (await sale(s.id)).balance;
    const res = await http(app)
      .put(`/api/submissions/${s.id}/installments`)
      .set('Cookie', acct)
      .send({ installments: evenLines(remaining, 2) });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.body.map((i: any) => i.seq)).toEqual([1, 2, 3]);
    expect(res.body.map((i: any) => i.status)).toEqual(['PAID', 'PENDING', 'PENDING']);
    // The paid one is untouched — its amount is evidence now, not a plan.
    expect(res.body[0].id).toBe(first.id);
  });

  it('clearing drops the outstanding schedule but not the paid history', async () => {
    const s = await pending();
    const plan = await http(app)
      .put(`/api/submissions/${s.id}/installments`)
      .set('Cookie', acct)
      .send({ installments: evenLines(s.balance, 2) });

    await http(app)
      .post(`/api/submissions/${s.id}/installments/${plan.body[0].id}/mark`)
      .set('Cookie', acct)
      .send();

    const res = await http(app)
      .delete(`/api/submissions/${s.id}/installments`)
      .set('Cookie', acct);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].status).toBe('PAID');
  });

  it('a rep may read their own plan but not write one', async () => {
    const s = await pending();
    const plan = await http(app)
      .put(`/api/submissions/${s.id}/installments`)
      .set('Cookie', acct)
      .send({ installments: evenLines(s.balance, 2) });

    // Visible — that is the point of the feature.
    const read = await http(app).get(`/api/submissions/${s.id}/installments`).set('Cookie', sales);
    expect(read.status).toBe(200);
    expect(read.body).toHaveLength(2);
    // ...and it rides on the submission payload too, so the detail page needs
    // no second request.
    expect((await sale(s.id, sales)).installments).toHaveLength(2);

    // Setting and marking are Accounting's.
    expect(
      (
        await http(app)
          .put(`/api/submissions/${s.id}/installments`)
          .set('Cookie', sales)
          .send({ installments: evenLines(s.balance, 1) })
      ).status,
    ).toBe(403);
    expect(
      (
        await http(app)
          .post(`/api/submissions/${s.id}/installments/${plan.body[0].id}/mark`)
          .set('Cookie', sales)
          .send()
      ).status,
    ).toBe(403);
  });

  it('refuses to schedule a sale with nothing outstanding', async () => {
    const s = await pending();
    await http(app)
      .post(`/api/submissions/${s.id}/payments`)
      .set('Cookie', acct)
      .send({ date: '2026-07-01', amount: Number(s.balance), method: 'Cheque' });

    const res = await http(app)
      .put(`/api/submissions/${s.id}/installments`)
      .set('Cookie', acct)
      .send({ installments: evenLines(s.balance, 2) });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.message)).toMatch(/nothing left to schedule/);
  });
});
