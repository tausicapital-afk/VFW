import { Controller, Headers, HttpCode, Module, Param, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../common/auth.guard';
import { PortalModule } from '../portal/portal.controller';
import { SubmissionsModule } from '../submissions/submissions.controller';
import { PaymentsService } from './payments.service';

/**
 * Online payment collection (docs/addon-features.md: "Online payment
 * collection... decision: Stripe") — a contact pays their outstanding balance
 * from the read-only portal (see frontend/src/pages/Portal.tsx's "Pay now"),
 * via Stripe's hosted Checkout page. Neither route here carries a session:
 * the checkout-session create is gated by the same portal token everything
 * else in PortalController is, and the webhook is gated by Stripe's own
 * signature over the raw request body — see PaymentsService for both.
 */
@Controller('api/payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /**
   * Start a Checkout Session for one of the token's own submissions. Scoped
   * exactly like every other portal read — see PortalService.resolveContactId
   * and PaymentsService.createCheckoutSession, which re-verifies the
   * submission belongs to the token's contact before ever calling Stripe,
   * rather than trusting the submissionId a client sent.
   *
   * Path is `api/payments/portal/...` (not `api/portal/...`) so this stays a
   * payments-module route, but `common/throttler.ts`'s `isPortal` matches
   * this prefix too — the token here is exactly as guessable-by-brute-force
   * as the rest of the portal, so it gets the same IP-keyed, 20/min bucket.
   */
  @Public()
  @Post('portal/:token/submissions/:submissionId/checkout-session')
  createCheckoutSession(
    @Param('token') token: string,
    @Param('submissionId') submissionId: string,
  ) {
    return this.payments.createCheckoutSession(token, submissionId);
  }

  /**
   * Stripe's server-to-server webhook. There is no token and no session here
   * — the only gate is the signature Stripe computes over the exact bytes it
   * sent, which is why this reads `req.rawBody` (populated because main.ts
   * boots Nest with `rawBody: true`) rather than the JSON-parsed `@Body()`:
   * verifying a signature against a body Nest has re-serialized would pass or
   * fail by coincidence, not by proof. See PaymentsService.handleWebhook for
   * where the signature is actually checked, before any database write.
   *
   * Always answers 2xx for any event whose signature checks out, including
   * one this handler does not act on (`{ received: true }`, accepted but
   * ignored) — Stripe retries indefinitely on anything else, and a `200` is
   * the only way to tell it the delivery landed.
   */
  @Public()
  @Post('stripe/webhook')
  @HttpCode(200)
  handleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature?: string,
  ) {
    return this.payments.handleWebhook(req.rawBody, signature);
  }
}

@Module({
  imports: [PortalModule, SubmissionsModule],
  controllers: [PaymentsController],
  providers: [PaymentsService],
})
export class PaymentsModule {}
