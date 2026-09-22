import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Currency, Prisma, Role, SubmissionStatus, UserStatus } from '@prisma/client';
import { randomBytes } from 'crypto';
import { Decimal } from 'decimal.js';
import Stripe from 'stripe';
import * as argon2 from 'argon2';
import { AuditService } from '../audit/audit.service';
import { ConfigService } from '../config/config.service';
import { PortalService } from '../portal/portal.service';
import { PrismaService } from '../prisma/prisma.service';
import { SubmissionsService } from '../submissions/submissions.service';

/** Money rounds to 2dp, half-up — same convention as PricingService / InstallmentsService. */
const r2 = (v: Decimal.Value): Decimal => new Decimal(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/**
 * Stripe currencies for which the "amount" a Checkout Session/PaymentIntent
 * takes is a count of the currency's own whole unit, not its hundredths — see
 * https://docs.stripe.com/currencies#zero-decimal. Of the five currencies
 * this app prices in (schema.prisma `Currency`), only JPY is zero-decimal;
 * everything else here is multiplied by 100 the ordinary way.
 */
const ZERO_DECIMAL_CURRENCIES: ReadonlySet<Currency> = new Set([Currency.JPY]);

/** A sale's balance (a Decimal(14,2)) to the integer minor-unit amount Stripe wants. */
function toStripeMinorUnits(amount: Decimal.Value, currency: Currency): number {
  const rounded = r2(amount);
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) {
    return rounded.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
  }
  return rounded.times(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
}

/**
 * The service user every webhook-posted payment is recorded under.
 *
 * `Payment.recordedById` is a required, non-null FK to User — there is no
 * "system" actor concept in this schema — and a Stripe webhook has no signed-in
 * user to attribute the payment to (Stripe's server called us, not a person).
 * Rather than loosen that FK, this is a real User row: `hidden: true` keeps it
 * off the admin Users tab exactly like a demo/test login (see the doc comment
 * on User.hidden), with an unguessable random password hashed through the same
 * argon2 AuthService itself uses — nothing ever hands this password to anyone,
 * so there is no code path that can sign in as it, but the column is never a
 * fake or reused credential either.
 *
 * The `.internal` suffix is not decorative: it is an IETF-reserved special-use
 * domain (RFC 9476) that a real registrar will never issue and Google will
 * never verify a Workspace/Gmail address against. That is what keeps this row
 * unreachable through Google SSO's "link an existing account by verified
 * email" flow (AuthService.loginWithGoogle) — an attacker cannot present a
 * Google-verified `@system.internal` address. Do not repoint this at a real,
 * registrable domain.
 */
const SYSTEM_USER_EMAIL = 'stripe@system.internal';

@Injectable()
export class PaymentsService {
  private readonly log = new Logger(PaymentsService.name);

  // The Stripe client is cheap to construct but memoised anyway, and rebuilt
  // only when the configured key actually changes — the same "rebuild on
  // credential change" shape EmailService's transport and StorageService's S3
  // client use, keyed here on the secret key itself rather than
  // ConfigService.version since that bumps on ANY config write, not just this
  // group's.
  private stripeClient: Stripe | null = null;
  private stripeClientKey: string | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly portal: PortalService,
    private readonly submissions: SubmissionsService,
  ) {}

  // ---------------------------------------------------------------------
  // Credentials (ConfigService — Administration → Configuration), same
  // fail-gracefully-with-a-BadRequestException shape as
  // QboConnectionService.credentials().
  // ---------------------------------------------------------------------

  private credentials(): { secretKey: string; webhookSecret: string } {
    const secretKey = this.config.get('STRIPE_SECRET_KEY');
    const webhookSecret = this.config.get('STRIPE_WEBHOOK_SECRET');
    if (!secretKey || !webhookSecret) {
      throw new BadRequestException(
        'Set the Stripe secret key and webhook signing secret under Administration → Configuration first.',
      );
    }
    return { secretKey, webhookSecret };
  }

  private stripe(secretKey: string): Stripe {
    if (!this.stripeClient || this.stripeClientKey !== secretKey) {
      this.stripeClient = new Stripe(secretKey);
      this.stripeClientKey = secretKey;
    }
    return this.stripeClient;
  }

  private appUrl(): string {
    const appUrl = this.config.get('APP_URL');
    if (!appUrl) {
      throw new BadRequestException(
        'Set the app web address (APP_URL) under Administration → Configuration first — Stripe needs it to know where to send the contact back.',
      );
    }
    return appUrl.replace(/\/+$/, '');
  }

  // ---------------------------------------------------------------------
  // Checkout session — portal-token-scoped
  // ---------------------------------------------------------------------

  /**
   * Start a Stripe Checkout Session for one submission's outstanding balance.
   *
   * The token is resolved to a contactId exactly the way every other portal
   * read is (PortalService.contactIdForToken -> resolveContactId), and the
   * submissionId is then re-verified as belonging to THAT contact — never
   * trusted from the client — the same discipline
   * SubmissionsService.invoicePdfForPortal uses for the PDF download. A
   * submission that does not exist, belongs to someone else, or is voided all
   * get the identical 404 a guess would get for a submission that was never
   * real, so a caller can never use this to probe which ids exist.
   */
  async createCheckoutSession(token: string, submissionId: string): Promise<{ url: string }> {
    const contactId = await this.portal.contactIdForToken(token);

    const submission = await this.prisma.submission.findUnique({
      where: { id: submissionId },
      select: {
        id: true,
        contactId: true,
        status: true,
        ref: true,
        invoiceNo: true,
        currency: true,
        balance: true,
      },
    });
    if (
      !submission ||
      submission.contactId !== contactId ||
      submission.status === SubmissionStatus.VOIDED
    ) {
      throw new NotFoundException('Submission not found');
    }

    const balance = new Decimal(submission.balance.toString());
    if (balance.lte(0)) {
      throw new BadRequestException('This sale is already settled — there is nothing left to pay.');
    }

    const { secretKey } = this.credentials();
    const appUrl = this.appUrl();
    const stripe = this.stripe(secretKey);

    const label = submission.invoiceNo ?? submission.ref;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: submission.currency.toLowerCase(),
            unit_amount: toStripeMinorUnits(balance, submission.currency),
            product_data: {
              name: `VFW ${label}`,
              description: `Outstanding balance for ${submission.ref}`,
            },
          },
          quantity: 1,
        },
      ],
      success_url: `${appUrl}/portal/${token}?payment=success`,
      cancel_url: `${appUrl}/portal/${token}?payment=cancelled`,
      // Not load-bearing for reconciliation — the row created below, keyed by
      // Stripe's own session id, is what the webhook actually looks up — but
      // useful context when reading a session in the Stripe Dashboard.
      metadata: { submissionId: submission.id, ref: submission.ref },
    });

    if (!session.url) {
      throw new BadRequestException('Stripe did not return a checkout page — try again.');
    }

    await this.prisma.stripeCheckoutSession.create({
      data: {
        stripeSessionId: session.id,
        submissionId: submission.id,
        // Frozen now, same reasoning as the model comment: this is the figure
        // Checkout actually put in front of the contact's card, whatever the
        // balance does afterwards.
        amount: balance.toFixed(2),
        currency: submission.currency,
      },
    });

    return { url: session.url };
  }

  // ---------------------------------------------------------------------
  // Webhook
  // ---------------------------------------------------------------------

  /**
   * Verify and act on a Stripe webhook delivery.
   *
   * The signature check happens BEFORE any database read or write — an
   * attacker who can POST arbitrary JSON here but does not hold the webhook
   * signing secret never gets past `constructEvent`, which throws on a
   * missing, malformed or wrong-secret signature. Nothing downstream of that
   * throw executes.
   */
  async handleWebhook(rawBody: Buffer | undefined, signature: string | undefined) {
    const { secretKey, webhookSecret } = this.credentials();

    if (!rawBody || !signature) {
      throw new BadRequestException('Missing Stripe signature.');
    }

    const stripe = this.stripe(secretKey);
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (e) {
      this.log.warn(
        `Stripe webhook signature verification failed: ${e instanceof Error ? e.message : e}`,
      );
      throw new BadRequestException('Invalid Stripe signature.');
    }

    if (event.type !== 'checkout.session.completed') {
      // Accepted, not acted on. Stripe expects a 2xx for anything it sends —
      // refusing an event type this handler does not care about would just
      // make Stripe retry it forever.
      return { received: true };
    }

    await this.postPayment(event.data.object as Stripe.Checkout.Session);
    return { received: true };
  }

  /**
   * Post the Payment a completed Checkout Session represents, exactly once.
   *
   * Idempotency is the `updateMany({ where: { status: 'PENDING' } })` claim
   * below — the same "claim atomically before any money is written" idiom
   * InstallmentsService.mark uses against two people clicking "mark done" at
   * once. Here the race is Stripe redelivering the same event (it retries
   * until it gets a 2xx): the first delivery claims the row and posts the
   * Payment inside one transaction; a second, third, Nth delivery of the same
   * event finds the row already COMPLETED, claims nothing, and returns
   * without writing a second Payment.
   */
  private async postPayment(session: Stripe.Checkout.Session): Promise<void> {
    const recordedById = await this.systemUserId();

    // Read-before-claim, deliberately outside the transaction below: this
    // Checkout Session is created with a fixed, non-adjustable quantity and
    // no promotion codes or automatic tax, so `amount_total` can only ever
    // equal what we asked Stripe to charge — but the ledger must never trust
    // that invariant blindly. If a mismatch ever shows up (a future change to
    // session creation, or a Stripe-side surprise), fail loud and post
    // nothing rather than record a figure nobody actually confirmed. The row
    // is left PENDING (not claimed), so a corrected redelivery can still post
    // it once the mismatch is understood.
    const preCheck = await this.prisma.stripeCheckoutSession.findUnique({
      where: { stripeSessionId: session.id },
    });
    if (preCheck && preCheck.status === 'PENDING') {
      const expected = toStripeMinorUnits(preCheck.amount, preCheck.currency);
      if (session.amount_total !== expected) {
        this.log.error(
          `Stripe checkout session ${session.id} confirmed amount_total=${session.amount_total} ` +
            `but this app expected ${expected} minor units (${preCheck.amount} ${preCheck.currency}) — ` +
            `refusing to post a Payment for an unconfirmed amount.`,
        );
        return;
      }
    }

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.stripeCheckoutSession.updateMany({
        where: { stripeSessionId: session.id, status: 'PENDING' },
        data: { status: 'COMPLETED' },
      });
      if (claimed.count === 0) {
        // Already processed (a genuine replay of an event we've handled), or
        // a session id this database never created. Either way there is
        // nothing left to claim, and claiming nothing means posting nothing.
        return;
      }

      const row = await tx.stripeCheckoutSession.findUniqueOrThrow({
        where: { stripeSessionId: session.id },
      });

      const submission = await tx.submission.findUnique({ where: { id: row.submissionId } });
      if (!submission) {
        // Should not happen — submissions are never deleted, only voided —
        // but a webhook must never throw on something Stripe cannot fix by
        // retrying. The session stays COMPLETED; nowhere to post the money.
        this.log.error(
          `Stripe checkout session ${session.id} completed for submission ${row.submissionId}, which no longer exists`,
        );
        return;
      }

      const payment = await tx.payment.create({
        data: {
          submissionId: row.submissionId,
          date: new Date(),
          amount: row.amount,
          currency: row.currency,
          method: 'Stripe',
          reference:
            typeof session.payment_intent === 'string' ? session.payment_intent : session.id,
          recordedById,
          // Same rule as every other payment path (SubmissionsService.addPayment,
          // InstallmentsService.mark): a payment inherits the sale it settles.
          isTestData: submission.isTestData || this.config.testDataMode,
        },
      });

      await tx.stripeCheckoutSession.update({
        where: { id: row.id },
        data: { paymentId: payment.id },
      });

      const { priced } = await this.submissions.recomputeMoney(tx, row.submissionId);

      await this.audit.log(
        {
          submissionId: row.submissionId,
          actorId: recordedById,
          action: 'PAYMENT',
          detail: `${row.amount.toFixed(2)} ${row.currency} by Stripe (session ${session.id})`,
          payload: {
            amount: row.amount.toFixed(2),
            currency: row.currency,
            paidAmount: priced.paidAmount.toFixed(2),
            balance: priced.balance.toFixed(2),
            payStatus: priced.payStatus,
            stripeSessionId: session.id,
          },
        },
        tx,
      );
    });
  }

  /**
   * Find-or-lazily-create the hidden "Stripe" service user described above.
   * Two webhook deliveries racing to create it for the first time is handled
   * the same way MessagingService handles two people racing to open the same
   * DM: let the loser's unique-constraint violation (P2002) tell it the row
   * now exists, then read what the winner created.
   */
  private async systemUserId(): Promise<string> {
    const existing = await this.prisma.user.findUnique({
      where: { email: SYSTEM_USER_EMAIL },
      select: { id: true },
    });
    if (existing) return existing.id;

    try {
      const passwordHash = await argon2.hash(randomBytes(32).toString('hex'));
      const created = await this.prisma.user.create({
        data: {
          name: 'Stripe',
          email: SYSTEM_USER_EMAIL,
          passwordHash,
          role: Role.ACCT,
          status: UserStatus.ACTIVE,
          hidden: true,
        },
        select: { id: true },
      });
      return created.id;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const row = await this.prisma.user.findUniqueOrThrow({
          where: { email: SYSTEM_USER_EMAIL },
          select: { id: true },
        });
        return row.id;
      }
      throw e;
    }
  }
}
