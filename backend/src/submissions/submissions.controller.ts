import { Body, Controller, Get, Module, Param, Patch, Post, Put } from '@nestjs/common';
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
  @Can('submission.approve')
  queue(@CurrentUser() user: AuthUser) {
    return this.submissions.queue(user);
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
