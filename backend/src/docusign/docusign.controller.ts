import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Module,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthUser, Can, CurrentUser, Public } from '../common/auth.guard';
import { SubmissionsModule } from '../submissions/submissions.controller';
import { DocuSignConnectionService } from './docusign-connection.service';
import { DocuSignWebhookService } from './docusign-webhook.service';
import { DocuSignApiService } from './docusign.service';
import { DocuSignCallbackQueryDto, DocuSignConnectPayload } from './dto';

/**
 * Everything an administrator needs to connect this console to DocuSign.
 * Same shape as QboAdminController — see that file for the fuller reasoning —
 * `admin.manage` throughout, spelled out per handler rather than at the class
 * level, because this hands out and revokes a live DocuSign credential.
 */
@Controller('api/admin/docusign')
export class DocuSignAdminController {
  constructor(private readonly connection: DocuSignConnectionService) {}

  @Get('status')
  @Can('admin.manage')
  status() {
    return this.connection.status();
  }

  /** Top-level navigation to DocuSign's consent screen — see QboAdminController.connect. */
  @Get('connect')
  @Can('admin.manage')
  connect(@CurrentUser() user: AuthUser, @Res() res: Response) {
    res.redirect(this.connection.authorizeUrl(user));
  }

  /** Where DocuSign sends the browser back to — see QboAdminController.callback. */
  @Get('callback')
  @Can('admin.manage')
  async callback(@Query() query: DocuSignCallbackQueryDto, @CurrentUser() user: AuthUser, @Res() res: Response) {
    const back = (params: Record<string, string>) => {
      const base = this.connection.redirectUri().replace(/\/api\/admin\/docusign\/callback$/, '/admin');
      const url = new URL(base);
      url.searchParams.set('tab', 'config');
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      res.redirect(url.toString());
    };
    try {
      await this.connection.handleCallback(query, user);
      back({ docusign: 'connected' });
    } catch (e) {
      back({ docusign: 'error', docusignMessage: e instanceof Error ? e.message : 'Could not connect to DocuSign' });
    }
  }

  @Post('disconnect')
  @Can('admin.manage')
  async disconnect(@CurrentUser() user: AuthUser) {
    await this.connection.disconnect(user);
    return this.connection.status();
  }
}

/**
 * Per-submission signature requests. Reading is scoped exactly like Documents
 * (whoever may see the submission may see its signature requests — no extra
 * permission on top, same as DocumentsController.list). Sending one out is
 * `email.send`: handing a document to the contact for signature is the same
 * kind of act as sending an invoice or a portal link — see the comment on
 * `email.send` in common/acl.ts.
 */
@Controller('api/submissions/:id')
export class DocuSignController {
  constructor(private readonly docusign: DocuSignApiService) {}

  @Get('signature-requests')
  list(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.docusign.list(id, user);
  }

  @Post('documents/:docId/send-for-signature')
  @Can('email.send')
  sendForSignature(@Param('id') id: string, @Param('docId') docId: string, @CurrentUser() user: AuthUser) {
    return this.docusign.sendForSignature(id, docId, user);
  }
}

/**
 * DocuSign Connect status notifications. `@Public()` — there is no user
 * here, only DocuSign's own callback — and the ONLY thing this trusts from
 * the caller is an envelope id that is then looked up against a
 * SignatureRequest this console itself created (see
 * DocuSignWebhookService.handleNotification); nothing about which submission
 * or document the notification claims to concern is taken at face value.
 *
 * HMAC verification (when DOCUSIGN_HMAC_KEY is configured) needs the raw
 * request bytes, not the JSON-reparsed body — see
 * DocuSignWebhookService.verifySignature for why, and main.ts /
 * test/app.ts for where `rawBody: true` is enabled to expose them. A bad
 * signature is refused outright (401) — a misconfigured shared secret should
 * be loud, not a webhook that quietly does nothing.
 *
 * Otherwise always answers 200 once the payload has been read, even for an
 * envelope this app does not recognise — DocuSign Connect redelivers on a
 * non-2xx, and an unknown envelope id is not going to become known by
 * retrying.
 */
@Controller('api/docusign')
export class DocuSignWebhookController {
  constructor(private readonly webhook: DocuSignWebhookService) {}

  @Public()
  @Post('webhook')
  @HttpCode(200)
  async receive(
    @Body() body: DocuSignConnectPayload,
    @Headers('x-docusign-signature-1') signature: string | string[] | undefined,
    @Req() req: RawBodyRequest<Request>,
  ) {
    if (!this.webhook.verifySignature(req.rawBody, signature)) {
      throw new UnauthorizedException('Signature verification failed');
    }

    const { envelopeId, status } = this.webhook.extractEnvelope(body);
    if (!envelopeId || !status) {
      return { ok: true, ignored: true };
    }
    await this.webhook.handleNotification(envelopeId, status);
    return { ok: true };
  }
}

@Module({
  // StorageService (StorageModule) and AuditService (AuditModule) are both
  // @Global() — already available app-wide via AppModule — so, like
  // DocumentsModule, only the one module this domain actually depends on for
  // its own scoping needs to be imported here.
  imports: [SubmissionsModule],
  controllers: [DocuSignAdminController, DocuSignController, DocuSignWebhookController],
  providers: [DocuSignConnectionService, DocuSignApiService, DocuSignWebhookService],
  exports: [DocuSignConnectionService],
})
export class DocuSignModule {}
