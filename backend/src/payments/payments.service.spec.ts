import { BadRequestException, NotFoundException } from '@nestjs/common';

/**
 * Unit-level coverage for PaymentsService — same split as PortalService's own
 * spec (portal.service.spec.ts): what does not need a real database or a
 * real Stripe account is mocked here and tested fast; the token-lifecycle,
 * real-signature-verification and double-post-safety behaviour that DOES
 * need a real database lives in payments.spec.ts, driven through the real
 * HTTP surface.
 *
 * The Stripe SDK itself is mocked at the module level: PaymentsService
 * constructs `new Stripe(secretKey)` internally, so `checkout.sessions.create`
 * and `webhooks.constructEvent` are replaced with jest mocks this file
 * controls directly, rather than this suite ever reaching stripe.com.
 */

const mockSessionsCreate = jest.fn();
const mockConstructEvent = jest.fn();

jest.mock('stripe', () => {
  const ctor = jest.fn().mockImplementation(() => ({
    checkout: { sessions: { create: mockSessionsCreate } },
    webhooks: { constructEvent: mockConstructEvent },
  }));
  return { __esModule: true, default: ctor };
});

// eslint-disable-next-line import/first
import { PaymentsService } from './payments.service';

const STRIPE_SECRET_KEY = 'sk_test_mock';
const STRIPE_WEBHOOK_SECRET = 'whsec_test_mock';

function make() {
  const prisma = {
    submission: { findUnique: jest.fn() },
    stripeCheckoutSession: {
      create: jest.fn().mockResolvedValue(undefined),
      // Unconfigured by default (resolves undefined) so existing webhook
      // tests exercise the pre-check's "no local row to compare against, fall
      // through to the transaction's own claim guard" branch — the same
      // no-op it takes for an event this database never created a session
      // for. Tests of the amount-mismatch behaviour itself configure this
      // explicitly; see below.
      findUnique: jest.fn(),
    },
    user: { findUnique: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(),
  };
  const config = {
    get: jest.fn((key: string): string | undefined => {
      if (key === 'STRIPE_SECRET_KEY') return STRIPE_SECRET_KEY;
      if (key === 'STRIPE_WEBHOOK_SECRET') return STRIPE_WEBHOOK_SECRET;
      if (key === 'APP_URL') return 'https://console.example.com';
      return undefined;
    }),
    testDataMode: false,
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const portal = { contactIdForToken: jest.fn() };
  const submissions = { recomputeMoney: jest.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new PaymentsService(prisma as any, config as any, audit as any, portal as any, submissions as any);
  return { svc, prisma, config, audit, portal, submissions };
}

beforeEach(() => {
  mockSessionsCreate.mockReset();
  mockConstructEvent.mockReset();
});

describe('PaymentsService.createCheckoutSession', () => {
  it("404s a submission that does not belong to the token's contact", async () => {
    const { svc, prisma, portal } = make();
    portal.contactIdForToken.mockResolvedValue('c1');
    prisma.submission.findUnique.mockResolvedValue({
      id: 's1', contactId: 'c-someone-else', status: 'APPROVED',
      ref: 'VFW-0001', invoiceNo: null, currency: 'USD', balance: { toString: () => '100.00' },
    });

    await expect(svc.createCheckoutSession('tok', 's1')).rejects.toBeInstanceOf(NotFoundException);
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  it('404s a voided submission, even if it otherwise belongs to this contact', async () => {
    const { svc, prisma, portal } = make();
    portal.contactIdForToken.mockResolvedValue('c1');
    prisma.submission.findUnique.mockResolvedValue({
      id: 's1', contactId: 'c1', status: 'VOIDED',
      ref: 'VFW-0001', invoiceNo: null, currency: 'USD', balance: { toString: () => '100.00' },
    });

    await expect(svc.createCheckoutSession('tok', 's1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a sale with nothing outstanding, before calling Stripe', async () => {
    const { svc, prisma, portal } = make();
    portal.contactIdForToken.mockResolvedValue('c1');
    prisma.submission.findUnique.mockResolvedValue({
      id: 's1', contactId: 'c1', status: 'APPROVED',
      ref: 'VFW-0001', invoiceNo: 'VFW-2041', currency: 'USD', balance: { toString: () => '0.00' },
    });

    await expect(svc.createCheckoutSession('tok', 's1')).rejects.toBeInstanceOf(BadRequestException);
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  it('refuses with a clear message when Stripe is not configured', async () => {
    const { svc, prisma, portal, config } = make();
    portal.contactIdForToken.mockResolvedValue('c1');
    prisma.submission.findUnique.mockResolvedValue({
      id: 's1', contactId: 'c1', status: 'APPROVED',
      ref: 'VFW-0001', invoiceNo: 'VFW-2041', currency: 'USD', balance: { toString: () => '100.00' },
    });
    config.get.mockImplementation((key: string) => (key === 'APP_URL' ? 'https://x.example.com' : undefined));

    await expect(svc.createCheckoutSession('tok', 's1')).rejects.toThrow(/Stripe secret key/i);
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  it('converts a 2-decimal currency balance to cents for Stripe', async () => {
    const { svc, prisma, portal } = make();
    portal.contactIdForToken.mockResolvedValue('c1');
    prisma.submission.findUnique.mockResolvedValue({
      id: 's1', contactId: 'c1', status: 'APPROVED',
      ref: 'VFW-0001', invoiceNo: 'VFW-2041', currency: 'USD', balance: { toString: () => '1234.56' },
    });
    mockSessionsCreate.mockResolvedValue({ id: 'cs_test_1', url: 'https://checkout.stripe.com/cs_test_1' });

    const res = await svc.createCheckoutSession('tok', 's1');

    expect(res).toEqual({ url: 'https://checkout.stripe.com/cs_test_1' });
    const arg = mockSessionsCreate.mock.calls[0][0];
    expect(arg.line_items[0].price_data.currency).toBe('usd');
    expect(arg.line_items[0].price_data.unit_amount).toBe(123456);
    expect(arg.success_url).toBe('https://console.example.com/portal/tok?payment=success');
    expect(arg.cancel_url).toBe('https://console.example.com/portal/tok?payment=cancelled');

    expect(prisma.stripeCheckoutSession.create).toHaveBeenCalledWith({
      data: {
        stripeSessionId: 'cs_test_1',
        submissionId: 's1',
        amount: '1234.56',
        currency: 'USD',
      },
    });
  });

  it('converts a zero-decimal currency (JPY) balance to whole yen, not cents', async () => {
    const { svc, prisma, portal } = make();
    portal.contactIdForToken.mockResolvedValue('c1');
    prisma.submission.findUnique.mockResolvedValue({
      id: 's1', contactId: 'c1', status: 'APPROVED',
      ref: 'VFW-0002', invoiceNo: null, currency: 'JPY', balance: { toString: () => '5000.00' },
    });
    mockSessionsCreate.mockResolvedValue({ id: 'cs_test_2', url: 'https://checkout.stripe.com/cs_test_2' });

    await svc.createCheckoutSession('tok', 's1');

    const arg = mockSessionsCreate.mock.calls[0][0];
    expect(arg.line_items[0].price_data.currency).toBe('jpy');
    expect(arg.line_items[0].price_data.unit_amount).toBe(5000);
  });
});

describe('PaymentsService.handleWebhook', () => {
  it('refuses a missing signature without touching Stripe or the database', async () => {
    const { svc, prisma } = make();
    await expect(svc.handleWebhook(Buffer.from('{}'), undefined)).rejects.toBeInstanceOf(BadRequestException);
    expect(mockConstructEvent).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a missing body without touching Stripe or the database', async () => {
    const { svc, prisma } = make();
    await expect(svc.handleWebhook(undefined, 'sig')).rejects.toBeInstanceOf(BadRequestException);
    expect(mockConstructEvent).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a signature Stripe itself rejects, before any database write', async () => {
    const { svc, prisma } = make();
    mockConstructEvent.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature for payload');
    });

    await expect(svc.handleWebhook(Buffer.from('{}'), 'bad-sig')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('accepts but ignores an event type it does not act on', async () => {
    const { svc, prisma } = make();
    mockConstructEvent.mockReturnValue({ type: 'payment_intent.created', data: { object: {} } });

    const res = await svc.handleWebhook(Buffer.from('{}'), 'sig');

    expect(res).toEqual({ received: true });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('posts a Payment for a completed session, using the hidden system user', async () => {
    const { svc, prisma, submissions, audit } = make();
    prisma.user.findUnique.mockResolvedValue({ id: 'u-stripe' });
    mockConstructEvent.mockReturnValue({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_1', payment_intent: 'pi_1' } },
    });

    const tx = {
      stripeCheckoutSession: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'row1', stripeSessionId: 'cs_1', submissionId: 's1',
          amount: { toFixed: () => '250.00' }, currency: 'USD', status: 'COMPLETED', paymentId: null,
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      submission: { findUnique: jest.fn().mockResolvedValue({ id: 's1', isTestData: false }) },
      payment: { create: jest.fn().mockResolvedValue({ id: 'pay1' }) },
    };
    prisma.$transaction.mockImplementation(async (cb: (t: typeof tx) => unknown) => cb(tx));
    submissions.recomputeMoney.mockResolvedValue({
      priced: { paidAmount: { toFixed: () => '250.00' }, balance: { toFixed: () => '0.00' }, payStatus: 'PAID' },
    });

    const res = await svc.handleWebhook(Buffer.from('{}'), 'sig');

    expect(res).toEqual({ received: true });
    expect(tx.stripeCheckoutSession.updateMany).toHaveBeenCalledWith({
      where: { stripeSessionId: 'cs_1', status: 'PENDING' },
      data: { status: 'COMPLETED' },
    });
    expect(tx.payment.create).toHaveBeenCalledTimes(1);
    const paymentArg = tx.payment.create.mock.calls[0][0].data;
    expect(paymentArg.method).toBe('Stripe');
    expect(paymentArg.reference).toBe('pi_1');
    expect(paymentArg.recordedById).toBe('u-stripe');
    expect(tx.stripeCheckoutSession.update).toHaveBeenCalledWith({
      where: { id: 'row1' },
      data: { paymentId: 'pay1' },
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ submissionId: 's1', action: 'PAYMENT', actorId: 'u-stripe' }),
      tx,
    );
  });

  it('does not post a second Payment when the claim finds the session already COMPLETED (replay)', async () => {
    const { svc, prisma, submissions } = make();
    prisma.user.findUnique.mockResolvedValue({ id: 'u-stripe' });
    mockConstructEvent.mockReturnValue({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_1', payment_intent: 'pi_1' } },
    });

    const tx = {
      stripeCheckoutSession: {
        // The guard: someone (an earlier delivery) already claimed this row.
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
      },
      submission: { findUnique: jest.fn() },
      payment: { create: jest.fn() },
    };
    prisma.$transaction.mockImplementation(async (cb: (t: typeof tx) => unknown) => cb(tx));

    const res = await svc.handleWebhook(Buffer.from('{}'), 'sig');

    expect(res).toEqual({ received: true });
    expect(tx.payment.create).not.toHaveBeenCalled();
    expect(tx.stripeCheckoutSession.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(submissions.recomputeMoney).not.toHaveBeenCalled();
  });

  it('lazily creates the hidden Stripe service user on first use, marked hidden and off the login path', async () => {
    const { svc, prisma, submissions } = make();
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({ id: 'u-new-stripe' });
    mockConstructEvent.mockReturnValue({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_1', payment_intent: 'pi_1' } },
    });
    const tx = {
      stripeCheckoutSession: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'row1', stripeSessionId: 'cs_1', submissionId: 's1',
          amount: { toFixed: () => '10.00' }, currency: 'USD', status: 'COMPLETED', paymentId: null,
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      submission: { findUnique: jest.fn().mockResolvedValue({ id: 's1', isTestData: false }) },
      payment: { create: jest.fn().mockResolvedValue({ id: 'pay1' }) },
    };
    prisma.$transaction.mockImplementation(async (cb: (t: typeof tx) => unknown) => cb(tx));
    submissions.recomputeMoney.mockResolvedValue({
      priced: { paidAmount: { toFixed: () => '10.00' }, balance: { toFixed: () => '0.00' }, payStatus: 'PAID' },
    });

    await svc.handleWebhook(Buffer.from('{}'), 'sig');

    expect(prisma.user.create).toHaveBeenCalledTimes(1);
    const created = prisma.user.create.mock.calls[0][0].data;
    expect(created.email).toBe('stripe@system.internal');
    expect(created.hidden).toBe(true);
    expect(created.status).toBe('ACTIVE');
    // A real hash, not a plaintext placeholder — argon2 hashes always start this way.
    expect(created.passwordHash).toMatch(/^\$argon2/);
    expect(tx.payment.create.mock.calls[0][0].data.recordedById).toBe('u-new-stripe');
  });

  it('refuses to post a Payment when Stripe\'s confirmed amount_total disagrees with the local record', async () => {
    const { svc, prisma, submissions } = make();
    prisma.user.findUnique.mockResolvedValue({ id: 'u-stripe' });
    mockConstructEvent.mockReturnValue({
      type: 'checkout.session.completed',
      // The session was created for 250.00 USD (25000 minor units); Stripe
      // confirms a different amount — should never happen given this app's
      // fixed-quantity, no-discount Checkout Session, but the ledger must not
      // trust an unconfirmed figure either way.
      data: { object: { id: 'cs_1', payment_intent: 'pi_1', amount_total: 1900 } },
    });
    prisma.stripeCheckoutSession.findUnique.mockResolvedValue({
      id: 'row1', stripeSessionId: 'cs_1', submissionId: 's1',
      amount: '250.00', currency: 'USD', status: 'PENDING',
    });

    const res = await svc.handleWebhook(Buffer.from('{}'), 'sig');

    expect(res).toEqual({ received: true });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(submissions.recomputeMoney).not.toHaveBeenCalled();
  });
});
