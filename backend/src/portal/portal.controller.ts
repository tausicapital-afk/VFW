import { Controller, Get, Module, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../common/auth.guard';
import { SubmissionsModule } from '../submissions/submissions.controller';
import { PortalService } from './portal.service';

/**
 * The contact portal — a read-only, unauthenticated surface gated by a token
 * in the URL rather than a session. Both routes are `@Public()`: there is no
 * user to authenticate, only a link to validate. Rate-limited by the `portal`
 * throttler bucket (see common/throttler.ts) on top of the global one, since
 * "a guessable-ish token is the only gate" is exactly the shape a brute-force
 * attempt takes.
 *
 * No mutation is reachable here, ever — both handlers are GET, and
 * PortalService exposes nothing that writes.
 */
@Controller('api/portal')
export class PortalController {
  constructor(private readonly portal: PortalService) {}

  @Public()
  @Get(':token')
  get(@Param('token') token: string) {
    return this.portal.getPortalData(token);
  }

  // The customer-facing PDF, same document SubmissionsService always renders —
  // see invoicePdfForPortal, which re-scopes to this token's contact rather
  // than duplicating PDF-generation logic.
  @Public()
  @Get(':token/submissions/:submissionId/invoice.pdf')
  async invoicePdf(
    @Param('token') token: string,
    @Param('submissionId') submissionId: string,
    @Res() res: Response,
  ) {
    const { buffer, filename } = await this.portal.invoicePdf(token, submissionId);
    res
      .status(200)
      .set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(buffer.length),
      })
      .end(buffer);
  }

  // The signed contract, once DocuSign has returned one — a presigned R2 URL
  // (same shape as DocumentsService.downloadUrl for the authenticated side),
  // not a stream through this API. Still read-only: nothing here signs
  // anything, it only retrieves a result that already exists.
  @Public()
  @Get(':token/submissions/:submissionId/signed-contract')
  signedContract(@Param('token') token: string, @Param('submissionId') submissionId: string) {
    return this.portal.signedContractUrl(token, submissionId);
  }
}

@Module({
  imports: [SubmissionsModule],
  controllers: [PortalController],
  providers: [PortalService],
  exports: [PortalService],
})
export class PortalModule {}
