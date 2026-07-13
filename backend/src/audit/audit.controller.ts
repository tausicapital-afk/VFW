import { Controller, Get, Global, Module, Query } from '@nestjs/common';
import { Can } from '../common/auth.guard';
import { AuditQueryDto } from '../reports/dto';
import { AuditService } from './audit.service';

/**
 * The global audit trail. Read-only, forever: there is no POST, no PATCH and no
 * DELETE on this controller, and no admin override that would add one. Entries
 * are written only as a side effect of the change they describe, inside its
 * transaction.
 *
 * Guarded with 'reports.view' (ACCT/MGR/ADMIN) — the same role set the mockup's
 * navigation shows the audit screen to. A sales rep sees their own record's
 * history on the submission itself; the company-wide trail is not theirs.
 */
@Controller('api/audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Can('reports.view')
  @Get()
  search(@Query() q: AuditQueryDto) {
    return this.audit.search(q);
  }

  @Can('reports.view')
  @Get('actions')
  actions() {
    return this.audit.actions();
  }
}

@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
