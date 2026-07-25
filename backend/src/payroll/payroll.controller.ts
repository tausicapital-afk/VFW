import { Controller, Get, Module, Query } from '@nestjs/common';
import { AuthUser, Can, CurrentUser } from '../common/auth.guard';
import { PayrollService } from './payroll.service';
import { PayrollQueryDto } from './dto';

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
}

@Module({
  controllers: [PayrollController],
  providers: [PayrollService],
  // Exported for the export dataset, which reads the run through the same
  // scoping rather than a second query that could disagree with the screen.
  exports: [PayrollService],
})
export class PayrollModule {}
