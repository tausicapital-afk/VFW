import { Body, Controller, Get, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { AuthUser, Can, CurrentUser } from '../common/auth.guard';
import { PayrollService } from './payroll.service';
import { EditPayrollInvoiceDto, PayrollQueryDto, RejectPayrollInvoiceDto, SubmitPayrollDto } from './dto';

/**
 * Payroll. Both routes carry `payroll.viewOwn`, which every role holds, because
 * the base case is reading your own pay — a rep checking the commission on the
 * sales they closed is the reason this module is tied to sales at all.
 *
 * Reading *somebody else's* is resolved per request in the service, which demands
 * `payroll.viewAll` the moment the subject is not the caller. `GET /run` re-checks
 * that permission itself: it has no subject to resolve, being everyone by
 * definition, and it is the one route that discloses what colleagues are paid.
 */
@Controller('api/payroll')
export class PayrollController {
  constructor(private readonly payroll: PayrollService) {}

  // Declared before any :id-shaped route so "run" is never read as a user id.
  @Get('run')
  @Can('payroll.viewOwn')
  run(@Query() query: PayrollQueryDto, @CurrentUser() user: AuthUser) {
    return this.payroll.run(query, user);
  }

  @Get()
  @Can('payroll.viewOwn')
  statement(@Query() query: PayrollQueryDto, @CurrentUser() user: AuthUser) {
    return this.payroll.statementFor(query, user);
  }

  // --- Payroll invoices ------------------------------------------------------
  // Declared before any :id-shaped route, same reason as "run" above.

  @Post('submit')
  @Can('payroll.submit')
  submit(@Body() dto: SubmitPayrollDto, @CurrentUser() user: AuthUser) {
    return this.payroll.submitMine(dto, user);
  }

  @Get('invoices/mine')
  @Can('payroll.viewOwn')
  mine(@CurrentUser() user: AuthUser) {
    return this.payroll.mine(user);
  }

  @Get('invoices/pending')
  @Can('payroll.approve')
  pending(@CurrentUser() user: AuthUser) {
    return this.payroll.pending(user);
  }

  @Patch('invoices/:id')
  @Can('payroll.approve')
  editInvoice(
    @Param('id') id: string,
    @Body() dto: EditPayrollInvoiceDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.payroll.editInvoice(id, dto, user);
  }

  @Post('invoices/:id/approve')
  @Can('payroll.approve')
  approveInvoice(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.payroll.approveInvoice(id, user);
  }

  @Post('invoices/:id/reject')
  @Can('payroll.approve')
  rejectInvoice(
    @Param('id') id: string,
    @Body() dto: RejectPayrollInvoiceDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.payroll.rejectInvoice(id, dto, user);
  }
}

@Module({
  controllers: [PayrollController],
  providers: [PayrollService],
  // Exported for the export dataset, which reads the run through the same
  // scoping rather than a second query that could disagree with the screen.
  exports: [PayrollService],
})
export class PayrollModule {}
