import { Body, Controller, Get, Module, Param, Patch, Post, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuthUser, Can, CurrentUser } from '../common/auth.guard';
import { PricingService } from '../pricing/pricing.service';
import {
  ApproveDto,
  CreateSubmissionDto,
  ExportDto,
  PatchSubmissionDto,
  PaymentDto,
  RejectDto,
  ReturnDto,
  VoidDto,
} from './dto';
import { SubmissionsService } from './submissions.service';

@Controller('api/submissions')
export class SubmissionsController {
  constructor(
    private readonly submissions: SubmissionsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.submissions.list(user);
  }

  // Declared before :id so "queue" is not swallowed as an id.
  @Get('queue')
  @Can('submission.queueView')
  queue(@CurrentUser() user: AuthUser) {
    return this.submissions.queue(user);
  }

  // Also before :id — the soft-deleted sales, for the roles that can restore them.
  @Get('voided')
  @Can('submission.void')
  voided(@CurrentUser() user: AuthUser) {
    return this.submissions.listVoided(user);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.submissions.findOne(id, user);
  }

  @Get(':id/audit')
  audits(@Param('id') id: string) {
    return this.audit.forSubmission(id);
  }

  @Post()
  @Can('submission.create')
  create(@Body() dto: CreateSubmissionDto, @CurrentUser() user: AuthUser) {
    return this.submissions.create(dto, user);
  }

  @Post(':id/approve')
  @Can('submission.approve')
  approve(@Param('id') id: string, @Body() dto: ApproveDto, @CurrentUser() user: AuthUser) {
    return this.submissions.approve(id, dto, user);
  }

  @Post(':id/reject')
  @Can('submission.reject')
  reject(@Param('id') id: string, @Body() dto: RejectDto, @CurrentUser() user: AuthUser) {
    return this.submissions.reject(id, dto, user);
  }

  @Post(':id/return')
  @Can('submission.return')
  returnToSales(@Param('id') id: string, @Body() dto: ReturnDto, @CurrentUser() user: AuthUser) {
    return this.submissions.returnToSales(id, dto.note, user);
  }

  @Post(':id/payments')
  @Can('accounting.fields')
  addPayment(@Param('id') id: string, @Body() dto: PaymentDto, @CurrentUser() user: AuthUser) {
    return this.submissions.addPayment(id, dto, user);
  }

  @Patch(':id')
  @Can('accounting.fields')
  patch(@Param('id') id: string, @Body() dto: PatchSubmissionDto, @CurrentUser() user: AuthUser) {
    return this.submissions.patch(id, dto, user);
  }

  @Post(':id/invoice')
  @Can('invoice.generate')
  invoice(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.submissions.generateInvoice(id, user);
  }

  // The customer-facing document. Streams a PDF built from the stored figures;
  // the invoice number must already exist (POST :id/invoice allocates it). We
  // take the response object directly so the binary is not run through Nest's
  // JSON serialization. A thrown error still surfaces before anything is written.
  @Get(':id/invoice.pdf')
  @Can('invoice.generate')
  async invoicePdf(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    const { buffer, filename } = await this.submissions.invoicePdf(id, user);
    res
      .status(200)
      .set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(buffer.length),
      })
      .end(buffer);
  }

  @Post(':id/void')
  @Can('submission.void')
  void(@Param('id') id: string, @Body() dto: VoidDto, @CurrentUser() user: AuthUser) {
    return this.submissions.void(id, dto.reason, user);
  }

  @Post(':id/unvoid')
  @Can('submission.void')
  unvoid(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.submissions.unvoid(id, user);
  }

  @Post(':id/export')
  @Can('quickbooks.export')
  export(@Param('id') id: string, @Body() dto: ExportDto, @CurrentUser() user: AuthUser) {
    return this.submissions.export(id, dto, user);
  }

  // Rep edits and resubmits their own DRAFT/RETURNED record; ownership is
  // enforced in the service, which 404s (not 403s) another rep's id.
  @Put(':id')
  @Can('submission.editOwn')
  update(@Param('id') id: string, @Body() dto: CreateSubmissionDto, @CurrentUser() user: AuthUser) {
    return this.submissions.update(id, dto, user);
  }
}

@Module({
  controllers: [SubmissionsController],
  providers: [SubmissionsService, PricingService],
  // Exported so ContactsService can reuse scopeFor() rather than reinventing it.
  exports: [SubmissionsService],
})
export class SubmissionsModule {}
