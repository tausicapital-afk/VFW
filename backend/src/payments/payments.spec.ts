import type { INestApplication } from '@nestjs/common';
import type { Currency } from '@prisma/client';
import { randomBytes } from 'crypto';
import Stripe from 'stripe';
import { createTestApp, http, loginCookie } from '../../test/app';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Online payment collection (Stripe) — the real HTTP surface, same style as
 * portal.spec.ts: everything here runs through createTestApp against a real
 * database, because the guarantee that matters is what the server actually
 * does, not what a mocked layer believes.
 *
 * What is NOT exercised here: an actual call to Stripe's API. Creating a
 * Checkout Session for real would need network access this suite never has
 * (and should not depend on) — so every test below either stays on a
 * rejection path that returns before PaymentsService ever calls Stripe
 * (unowned submission, zero balance, not configured), or drives the webhook
 * directly, inserting the StripeCheckoutSession row the real create path
 * would have written — the same "insert the row the real path would have
 * produced" trick portal.spec.ts's mintToken() uses for a link that would
 * otherwise need a live mail transport.
 *
 * The webhook signature itself IS real: `stripe.webhooks.constructEvent` is
 * pure HMAC-SHA256 over the raw body, no network involved, so this suite
 * signs its own test payloads with a real Stripe client and the exact
 * webhook secret configured below — proving the actual verification code
 * path, not a stand-in for it.
 */
describe('Online payment collection (Stripe)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sales: string;
  let acct: string;

  const STRIPE_SECRET_KEY = 'sk_test_not_real_51ABCDEF';
  const STRIPE_WEBHOOK_SECRET = 'whsec_test_not_real_51ABCDEF';

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    sales = await loginCookie(app, 'marielle@vanfashionweek.com');
    acct = await loginCookie(app, 'accounting@vanfashionweek.com');
  });

  afterAll(async () => {
    await app?.close();
  });

  /** A fresh, approved, invoiced sale against a brand-new contact with an email. */
  async function newInvoicedSubmission(email: string) {
    const created = await http(app)
      .post('/api/submissions')
      .set('Cookie', sales)
      .send({
        designer: 'Stripe Test',
        brand: `Stripe ${Date.now()}-${Math.random()}`,
        email,
        eventId: 'VFW-FW26',
        packageId: 'VFW-BRONZE',
      });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const contactId = created.body.contact.id as string;

    const approved = await http(app).post(`/api/submissions/${id}/approve`).set('Cookie', acct).send();
    expect(approved.status).toBe(201);

    const invoiced = await http(app).post(`/api/submissions/${id}/invoice`).set('Cookie', acct).send();
    expect(invoiced.status).toBe(201);

    const submission = await prisma.submission.findUniqueOrThrow({ where: { id } });
    return { submissionId: id, contactId, total: submission.total.toString(), currency: submission.currency };
  }

  /** Same trick portal.spec.ts's mintToken uses — insert the row directly rather than going through a live send. */
  async function mintToken(contactId: string) {
    const token = randomBytes(32).toString('hex');
    await prisma.contactPortalToken.create({
      data: { token, contactId, expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60_000) },
    });
    return token;
  }

  // -------------------------------------------------------------------
  // Checkout-session creation — every case here returns before
  // PaymentsService would ever call Stripe, so none of it needs Stripe
  // configured or reachable.
  // -------------------------------------------------------------------
  describe('creating a Checkout Session', () => {
    it('rejects with the not-configured error when Stripe has not been set up', async () => {
      const a = await newInvoicedSubmission('stripe-unconfigured@example.com');
      const token = await mintToken(a.contactId);

      const res = await http(app)
        .post(`/api/payments/portal/${token}/submissions/${a.submissionId}/checkout-session`)
        .send();

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Stripe secret key/i);
    });

    it("404s a submission that belongs to a different contact than the token's", async () => {
      const a = await newInvoicedSubmission('stripe-owner@example.com');
      const b = await newInvoicedSubmission('stripe-victim@example.com');
      const token = await mintToken(a.contactId);

      const res = await http(app)
        .post(`/api/payments/portal/${token}/submissions/${b.submissionId}/checkout-session`)
        .send();

      expect(res.status).toBe(404);
    });

    it('404s a submission id that does not exist at all, the same way', async () => {
      const a = await newInvoicedSubmission('stripe-owner-2@example.com');
      const token = await mintToken(a.contactId);

      const res = await http(app)
        .post(`/api/payments/portal/${token}/submissions/does-not-exist/checkout-session`)
        .send();

      expect(res.status).toBe(404);
    });

    it('rejects a sale whose balance is already zero', async () => {
      const a = await newInvoicedSubmission('stripe-settled@example.com');
      const paid = await http(app)
        .post(`/api/submissions/${a.submissionId}/payments`)
        .set('Cookie', acct)
        .send({ date: '2026-01-01', amount: Number(a.total), method: 'Bank Transfer / Wire' });
      expect(paid.status).toBe(201);
      // Pre-existing behaviour, not a Stripe-feature concern: the response's
      // Decimal.toJSON (main.ts) serialises via .toString(), which — like
      // every Decimal field in this API — drops a value's trailing zeros
      // (Decimal('0.00').toString() === '0'), not just for zero.
      expect(paid.body.balance).toBe('0');

      const token = await mintToken(a.contactId);
      const res = await http(app)
        .post(`/api/payments/portal/${token}/submissions/${a.submissionId}/checkout-session`)
        .send();

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/already settled/i);
    });

    it('an invalid/expired token gets the same generic error the rest of the portal gives', async () => {
      const a = await newInvoicedSubmission('stripe-badtoken@example.com');
      const bogusToken = randomBytes(32).toString('hex');

      const res = await http(app)
        .post(`/api/payments/portal/${bogusToken}/submissions/${a.submissionId}/checkout-session`)
        .send();

      expect(res.status).toBe(404);
      expect(res.body.message).toBe('This link is invalid or has expired.');
    });
  });

  // -------------------------------------------------------------------
  // Webhook — configure Stripe once for the whole block, then drive the
  // real signature-verification and payment-posting code with a real
  // (offline) Stripe client.
  // -------------------------------------------------------------------
  describe('the Stripe webhook', () => {
    let stripe: Stripe;

    beforeAll(async () => {
      const configured = await http(app)
        .patch('/api/admin/config')
        .set('Cookie', acct)
        .send({ entries: { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET } });
      expect(configured.status).toBe(200);
      stripe = new Stripe(STRIPE_SECRET_KEY);
    });

    // Stripe's real payload always carries the confirmed amount_total, which
    // PaymentsService cross-checks against the StripeCheckoutSession row
    // before posting anything (see payments.service.ts's postPayment) — so a
    // realistic fixture has to include it too, computed the same way the app
    // itself derives minor units (JPY is the one zero-decimal currency this
    // app prices in; none of these test fixtures use it, but this stays
    // correct if that ever changes).
    function minorUnits(amount: string, currency: Currency): number {
      return currency === 'JPY' ? Math.round(Number(amount)) : Math.round(Number(amount) * 100);
    }

    function completedEventPayload(
      stripeSessionId: string,
      amountTotal: number,
      paymentIntentId = 'pi_test_1',
    ) {
      return JSON.stringify({
        id: `evt_${randomBytes(8).toString('hex')}`,
        object: 'event',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: stripeSessionId,
            object: 'checkout.session',
            payment_intent: paymentIntentId,
            amount_total: amountTotal,
          },
        },
      });
    }

    function sign(payload: string) {
      return stripe.webhooks.generateTestHeaderString({ payload, secret: STRIPE_WEBHOOK_SECRET });
    }

    async function pendingSession(a: { submissionId: string; total: string; currency: Currency }) {
      const stripeSessionId = `cs_test_${randomBytes(12).toString('hex')}`;
      await prisma.stripeCheckoutSession.create({
        data: {
          stripeSessionId,
          submissionId: a.submissionId,
          amount: a.total,
          currency: a.currency,
        },
      });
      return stripeSessionId;
    }

    it('refuses a request with no signature at all, before writing anything', async () => {
      const a = await newInvoicedSubmission('stripe-nosig@example.com');
      const sessionId = await pendingSession(a);
      const payload = completedEventPayload(sessionId, minorUnits(a.total, a.currency));

      const res = await http(app)
        .post('/api/payments/stripe/webhook')
        .set('Content-Type', 'application/json')
        .send(payload);

      expect(res.status).toBe(400);

      const row = await prisma.stripeCheckoutSession.findUniqueOrThrow({
        where: { stripeSessionId: sessionId },
      });
      expect(row.status).toBe('PENDING');
      expect(row.paymentId).toBeNull();
      const payments = await prisma.payment.count({ where: { submissionId: a.submissionId } });
      expect(payments).toBe(0);
    });

    it('refuses a forged/garbage signature, before writing anything', async () => {
      const a = await newInvoicedSubmission('stripe-badsig@example.com');
      const sessionId = await pendingSession(a);
      const payload = completedEventPayload(sessionId, minorUnits(a.total, a.currency));

      const res = await http(app)
        .post('/api/payments/stripe/webhook')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', 't=1700000000,v1=' + 'f'.repeat(64))
        .send(payload);

      expect(res.status).toBe(400);

      const row = await prisma.stripeCheckoutSession.findUniqueOrThrow({
        where: { stripeSessionId: sessionId },
      });
      expect(row.status).toBe('PENDING');
      const payments = await prisma.payment.count({ where: { submissionId: a.submissionId } });
      expect(payments).toBe(0);
    });

    it('a validly signed checkout.session.completed posts exactly one Payment and settles the balance', async () => {
      const a = await newInvoicedSubmission('stripe-valid@example.com');
      const sessionId = await pendingSession(a);
      const payload = completedEventPayload(sessionId, minorUnits(a.total, a.currency), 'pi_test_valid_1');
      const signature = sign(payload);

      const res = await http(app)
        .post('/api/payments/stripe/webhook')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', signature)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });

      const submission = await prisma.submission.findUniqueOrThrow({ where: { id: a.submissionId } });
      expect(submission.balance.toString()).toBe('0.00');
      expect(submission.paidAmount.toString()).toBe(Number(a.total).toFixed(2));
      expect(submission.payStatus).toBe('PAID');

      const payments = await prisma.payment.findMany({ where: { submissionId: a.submissionId } });
      expect(payments).toHaveLength(1);
      expect(payments[0].method).toBe('Stripe');
      expect(payments[0].reference).toBe('pi_test_valid_1');
      expect(payments[0].amount.toString()).toBe(Number(a.total).toFixed(2));

      // Attributed to the hidden system user, never to a real staff account.
      const recordedBy = await prisma.user.findUniqueOrThrow({ where: { id: payments[0].recordedById } });
      expect(recordedBy.email).toBe('stripe@system.internal');
      expect(recordedBy.hidden).toBe(true);

      const row = await prisma.stripeCheckoutSession.findUniqueOrThrow({ where: { stripeSessionId: sessionId } });
      expect(row.status).toBe('COMPLETED');
      expect(row.paymentId).toBe(payments[0].id);

      const audit = await prisma.auditEntry.findFirst({
        where: { submissionId: a.submissionId, action: 'PAYMENT' },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit).not.toBeNull();
      expect(audit?.detail).toContain('Stripe');
    });

    it('does not double-post when the same event is redelivered (Stripe retry)', async () => {
      const a = await newInvoicedSubmission('stripe-replay@example.com');
      const sessionId = await pendingSession(a);
      const payload = completedEventPayload(sessionId, minorUnits(a.total, a.currency), 'pi_test_replay_1');
      const signature = sign(payload);

      const first = await http(app)
        .post('/api/payments/stripe/webhook')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', signature)
        .send(payload);
      expect(first.status).toBe(200);

      // Same exact delivery, replayed — the same signed payload and header,
      // exactly as Stripe would resend on a retry.
      const second = await http(app)
        .post('/api/payments/stripe/webhook')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', signature)
        .send(payload);
      expect(second.status).toBe(200);
      expect(second.body).toEqual({ received: true });

      const payments = await prisma.payment.findMany({ where: { submissionId: a.submissionId } });
      expect(payments).toHaveLength(1);

      const submission = await prisma.submission.findUniqueOrThrow({ where: { id: a.submissionId } });
      expect(submission.balance.toString()).toBe('0.00');
    });

    it('accepts, but takes no action on, an event type it does not handle', async () => {
      const payload = JSON.stringify({
        id: `evt_${randomBytes(8).toString('hex')}`,
        object: 'event',
        type: 'payment_intent.created',
        data: { object: { id: 'pi_irrelevant' } },
      });
      const signature = sign(payload);

      const res = await http(app)
        .post('/api/payments/stripe/webhook')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', signature)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });
    });
  });
});
