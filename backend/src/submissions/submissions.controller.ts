import { Body, Controller, Get, Module, Param, Post } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthUser, Can, CurrentUser } from '../common/auth.guard';
import { PricingService } from '../pricing/pricing.service';
import { ApproveDto, CreateSubmissionDto, RejectDto, ReturnDto } from './dto';
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
}

@Module({
  controllers: [SubmissionsController],
  providers: [SubmissionsService, PricingService],
})
export class SubmissionsModule {}
