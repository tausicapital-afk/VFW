import { Body, Controller, Get, Module, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuthUser, Can, CurrentUser } from '../common/auth.guard';
import { PayrollService } from './payroll.service';
import { EditPayrollInvoiceDto, PayrollQueryDto, RejectPayrollInvoiceDto, SubmitPayrollDto } from './dto';

/**
 * Payroll. The read routes carry `payroll.viewOwn`, which every role holds, because
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

  /**
   * The same statement as `GET /` below, as a document somebody can print, file
   * or forward. Carries `payroll.viewOwn` for exactly the reason that route
   * does: the service resolves whose month this is and refuses anyone else's
   * without `payroll.viewAll`, so the guard here is about reaching the module,
   * not about who is on the page.
   *
   * Deliberately NOT a dataset under `/api/export`. That machinery renders a
   * table — rows and columns, one shape across csv/xlsx/pdf — and a payslip is
   * not a table: it is one person, one month, with the arithmetic shown beside
   * each figure. Forcing it through would produce a two-column "Item / Value"
   * spreadsheet that nobody wants and a PDF that reads like a database dump. It
   * follows `submissions/:id/invoice.pdf` instead, which is the same shape of
   * problem (one record, one client-facing artefact) and already the house
   * pattern for it — and it reuses the same pdfkit renderer, so no second PDF
   * library entered the tree.
   *
   * We take the response object directly so the binary is not run through Nest's
   * JSON serialization. A thrown error still surfaces before anything is written.
   */
  @Get('payslip.pdf')
  @Can('payroll.viewOwn')
  async payslip(
    @Query() query: PayrollQueryDto,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    const { buffer, filename } = await this.payroll.payslip(query, user);
    res
      .status(200)
      .set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(buffer.length),
        // The browser reads the filename off the header, which is only visible
        // to a cross-origin fetch if it is explicitly exposed.
        'Access-Control-Expose-Headers': 'Content-Disposition',
      })
      .end(buffer);
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
